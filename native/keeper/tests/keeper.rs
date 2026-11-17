use std::cell::RefCell;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Scratch {
    dir: PathBuf,
    keepers: RefCell<Vec<i32>>,
}

impl Scratch {
    fn new() -> Self {
        let dir = PathBuf::from(format!(
            "/tmp/wkt-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create the scratch directory");
        Self {
            dir,
            keepers: RefCell::new(Vec::new()),
        }
    }

    fn keeper(&self) -> PathBuf {
        self.dir.join("keeper")
    }

    fn path(&self, name: &str) -> String {
        self.dir.join(name).to_string_lossy().into_owned()
    }

    fn record(&self) -> String {
        self.path("events.jsonl")
    }

    fn report(&self) -> String {
        fs::read_to_string(self.path("report")).unwrap_or_default()
    }

    fn write_spec(&self, spec: &Value) {
        fs::create_dir_all(self.keeper()).expect("create the keeper directory");
        fs::write(self.keeper().join("spec.json"), spec.to_string()).expect("write spec.json");
    }

    fn fake(&self, extra: &[&str]) -> Value {
        let mut argv = vec![
            fakechild().to_string_lossy().into_owned(),
            self.path("report"),
        ];
        argv.extend(extra.iter().map(|s| (*s).to_owned()));
        json!({ "name": "fake", "argv": argv, "log": self.path("child.log") })
    }

    fn fake_locked(&self) -> Value {
        let pidfile = self.path("fake.pid");
        let mut child = self.fake(&["--pidfile", &pidfile]);
        child["pidfile"] = json!(pidfile);
        child
    }
}

fn is_fakechild(pid: i32) -> bool {
    let mut path = [0u8; 4096];
    let size = u32::try_from(path.len()).expect("a buffer size");
    // SAFETY: the buffer is writable for `size` bytes.
    let got = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), size) };
    let len = usize::try_from(got).unwrap_or(0);
    path[..len].ends_with(b"/examples/fakechild")
}

impl Drop for Scratch {
    fn drop(&mut self) {
        for &pid in self.keepers.borrow().iter() {
            // SAFETY: waitpid with WNOHANG on a pid this test spawned; 0 means it is still running.
            if unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) } == 0 {
                // SAFETY: kills and reaps the still-running child this test spawned.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                    libc::waitpid(pid, std::ptr::null_mut(), 0);
                }
            }
        }
        for pid in self
            .report()
            .split_whitespace()
            .filter_map(|word| word.strip_prefix("pid=")?.parse::<i32>().ok())
        {
            if is_fakechild(pid) {
                // SAFETY: plain kill(2) on a fake child this test started.
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn keeper_bin() -> &'static str {
    env!("CARGO_BIN_EXE_winvm-keeper")
}

fn fakechild() -> PathBuf {
    Path::new(keeper_bin())
        .parent()
        .expect("the keeper's directory")
        .join("examples")
        .join("fakechild")
}

fn start(scratch: &Scratch, budget_ms: u64) -> Child {
    let keeper = Command::new(keeper_bin())
        .args(["run", "--dir"])
        .arg(scratch.keeper())
        .args(["--budget-ms", &budget_ms.to_string()])
        .stdout(fs::File::create(scratch.path("keeper.log")).expect("keeper.log"))
        .stderr(fs::File::create(scratch.path("keeper.err")).expect("keeper.err"))
        .spawn()
        .expect("spawn the keeper");
    scratch.keepers.borrow_mut().push(pid_of(&keeper));
    keeper
}

fn wait_until(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_exit(child: &mut Child, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("the keeper did not exit within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn request(scratch: &Scratch, message: &Value) -> Value {
    let socket = scratch.keeper().join("keeper.sock");
    let mut connected = None;
    wait_until("the control socket", Duration::from_secs(5), || {
        connected = UnixStream::connect(&socket).ok();
        connected.is_some()
    });
    let mut stream = connected.expect("connected to keeper.sock");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("timeout");
    writeln!(stream, "{message}").expect("send the request");
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .expect("read the response");
    serde_json::from_str(&line).expect("a JSON response")
}

fn records(scratch: &Scratch) -> Vec<Value> {
    fs::read_to_string(scratch.record())
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).expect("a JSON record line"))
        .collect()
}

fn keeper_whats(scratch: &Scratch) -> Vec<String> {
    records(scratch)
        .iter()
        .filter(|r| r["kind"] == "keeper")
        .map(|r| match r["step"].as_str() {
            Some(step) => format!("{}:{step}", r["what"].as_str().unwrap_or("")),
            None => r["what"].as_str().unwrap_or("").to_owned(),
        })
        .collect()
}

fn find<'a>(all: &'a [Value], what: &str) -> &'a Value {
    all.iter()
        .find(|r| r["what"] == what)
        .unwrap_or_else(|| panic!("no {what} record in {all:?}"))
}

fn child_pid(scratch: &Scratch) -> i32 {
    wait_until("the child", Duration::from_secs(5), || {
        request(scratch, &json!({ "op": "hello" }))["child"]["pid"].is_i64()
    });
    let hello = request(scratch, &json!({ "op": "hello" }));
    let pid = i32::try_from(hello["child"]["pid"].as_i64().expect("a child pid")).expect("a pid");
    wait_until("the fake child's handlers", Duration::from_secs(5), || {
        scratch.report().contains(&format!("pid={pid}"))
    });
    pid
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn signal(pid: i32, sig: libc::c_int) {
    // SAFETY: plain kill(2) on a pid this test started.
    let sent = unsafe { libc::kill(pid, sig) };
    assert_eq!(sent, 0, "kill({pid}, {sig})");
}

fn pid_of(child: &Child) -> i32 {
    i32::try_from(child.id()).expect("a pid")
}

fn spec(scratch: &Scratch, child: &Value, stop: Option<Value>) -> Value {
    let mut spec = json!({
        "instance": "test",
        "record": scratch.record(),
        "lingerMs": 300,
        "child": child,
    });
    if let Some(stop) = stop {
        spec["stop"] = stop;
    }
    spec
}

#[test]
fn the_child_starts_with_term_hup_and_int_blocked_and_they_stay_pending() {
    let scratch = Scratch::new();
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), None));
    let mut keeper = start(&scratch, 10_000);
    let pid = child_pid(&scratch);
    wait_until("the report", Duration::from_secs(5), || {
        scratch.report().contains("blocked")
    });
    assert!(
        scratch.report().contains("blocked TERM=1 HUP=1 INT=1"),
        "{}",
        scratch.report()
    );

    for sig in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
        signal(pid, sig);
    }
    wait_until("pending TERM", Duration::from_secs(5), || {
        scratch.report().contains("pending TERM")
    });
    std::thread::sleep(Duration::from_millis(200));
    assert!(alive(pid));
    assert!(
        !scratch.report().contains("handled"),
        "{}",
        scratch.report()
    );

    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    let all = records(&scratch);
    assert_eq!(find(&all, "exited")["signal"], 9);
}

#[test]
fn the_keeper_records_the_childs_exit_status_then_exits_when_idle() {
    let scratch = Scratch::new();
    let child = json!({ "name": "short", "argv": ["/bin/sh", "-c", "exit 7"] });
    scratch.write_spec(&spec(&scratch, &child, None));
    let mut keeper = start(&scratch, 10_000);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());

    assert_eq!(
        keeper_whats(&scratch),
        ["started", "launched", "exited", "exiting"],
        "{:?}",
        records(&scratch)
    );
    let all = records(&scratch);
    let exited = find(&all, "exited");
    assert_eq!(exited["status"], 7);
    assert_eq!(exited["child"], "short");
    assert_eq!(exited["pid"], find(&all, "launched")["pid"]);
    assert_eq!(find(&all, "exiting")["reason"], "idle");
    assert!(all.iter().all(|r| r["instance"] == "test"));
    assert!(!scratch.keeper().join("state.json").exists());
    assert!(!scratch.keeper().join("keeper.sock").exists());
}

#[test]
fn the_record_starts_with_a_generation_line_when_the_keeper_creates_it() {
    let scratch = Scratch::new();
    let child = json!({ "name": "short", "argv": ["/usr/bin/true"] });
    scratch.write_spec(&spec(&scratch, &child, None));
    let mut keeper = start(&scratch, 10_000);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    let all = records(&scratch);
    assert_eq!(all[0]["kind"], "generation");
    assert_eq!(all[0]["generation"].as_str().map(str::len), Some(36));
    let mode = fs::metadata(scratch.record())
        .expect("the record")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn sigterm_runs_the_stop_action_with_its_deadline_and_the_keeper_exits_zero() {
    let scratch = Scratch::new();
    let stop = json!({
        "argv": ["/bin/sh", "-c", "echo \"$WINVM_KEEPER_DEADLINE_MS $WINVM_KEEPER_CHILD_PID\" > \"$0\"; kill -USR1 \"$WINVM_KEEPER_CHILD_PID\"; while kill -0 \"$WINVM_KEEPER_CHILD_PID\" 2>/dev/null; do sleep 0.05; done", scratch.path("stop.out")],
    });
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), Some(stop)));
    let mut keeper = start(&scratch, 10_000);
    let pid = child_pid(&scratch);
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_millis();
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(8)).success());

    let whats = keeper_whats(&scratch);
    assert_eq!(
        whats,
        [
            "started",
            "launched",
            "host-ending",
            "exited",
            "host-end:stop-action",
            "host-end:done",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
    let all = records(&scratch);
    assert_eq!(find(&all, "host-ending")["budgetMs"], 10_000);
    assert_eq!(find(&all, "host-ending")["signal"], "SIGTERM");
    assert_eq!(find(&all, "exited")["status"], 0);
    assert_eq!(find(&all, "host-end")["ok"], true);
    assert_eq!(find(&all, "exiting")["reason"], "host-end");
    assert!(scratch.report().contains("quit"));

    let out = fs::read_to_string(scratch.path("stop.out")).expect("the stop action ran");
    let mut fields = out.split_whitespace();
    let deadline: u128 = fields
        .next()
        .and_then(|d| d.parse().ok())
        .expect("a deadline");
    assert_eq!(fields.next(), Some(pid.to_string().as_str()));
    assert!(
        deadline > before + 4_000 && deadline <= before + 6_000,
        "deadline {deadline}, sent at {before}"
    );
}

#[test]
fn a_stop_action_past_its_deadline_is_killed_and_the_child_after_a_grace() {
    let scratch = Scratch::new();
    let stop = json!({ "argv": ["/bin/sleep", "30"] });
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), Some(stop)));
    let mut keeper = start(&scratch, 7_000);
    let pid = child_pid(&scratch);
    let sent = Instant::now();
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(10)).success());
    let took = sent.elapsed();
    assert!(
        took >= Duration::from_millis(4_500),
        "exited after {took:?}"
    );
    assert!(took < Duration::from_millis(5_800), "exited after {took:?}");
    assert!(!alive(pid));

    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "host-ending",
            "host-end:stop-action",
            "host-end:kill",
            "exited",
            "host-end:done",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
    let all = records(&scratch);
    let stop = all
        .iter()
        .find(|r| r["step"] == "stop-action")
        .expect("stop-action");
    assert_eq!(stop["ok"], false);
    assert_eq!(stop["error"], "deadline");
    assert_eq!(find(&all, "exited")["signal"], 9);
}

#[test]
fn sigterm_without_a_stop_action_kills_the_child_at_once() {
    let scratch = Scratch::new();
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), None));
    let mut keeper = start(&scratch, 30_000);
    let pid = child_pid(&scratch);
    let sent = Instant::now();
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(sent.elapsed() < Duration::from_secs(2));
    assert!(!alive(pid));
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "host-ending",
            "host-end:kill",
            "exited",
            "host-end:done",
            "exiting"
        ]
    );
}

#[test]
fn a_restarted_keeper_adopts_the_child_through_its_pidfile_lock() {
    let scratch = Scratch::new();
    scratch.write_spec(&spec(&scratch, &scratch.fake_locked(), None));
    let mut first = start(&scratch, 10_000);
    let pid = child_pid(&scratch);
    wait_until("the pidfile", Duration::from_secs(5), || {
        scratch.report().contains("blocked")
    });
    first.kill().expect("SIGKILL the keeper");
    first.wait().expect("reap the keeper");
    assert!(alive(pid));

    let mut second = start(&scratch, 10_000);
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["child"]["pid"], pid);
    assert_eq!(hello["child"]["adopted"], true);
    assert_eq!(hello["child"]["name"], "fake");

    signal(pid, libc::SIGUSR1);
    assert!(wait_exit(&mut second, Duration::from_secs(5)).success());
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "started",
            "adopted",
            "exited-unknown",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
    let all = records(&scratch);
    assert_eq!(find(&all, "adopted")["pid"], pid);
    assert_eq!(find(&all, "adopted")["by"], "pidfile");
}

#[test]
fn a_restarted_keeper_never_relaunches_a_child_that_is_gone() {
    let scratch = Scratch::new();
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), None));
    let mut first = start(&scratch, 10_000);
    let pid = child_pid(&scratch);
    first.kill().expect("SIGKILL the keeper");
    first.wait().expect("reap the keeper");
    signal(pid, libc::SIGKILL);
    wait_until("the orphan to go", Duration::from_secs(5), || !alive(pid));

    let mut second = start(&scratch, 10_000);
    assert!(wait_exit(&mut second, Duration::from_secs(5)).success());
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "started",
            "exited-unknown",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
}

#[test]
fn a_restarted_keeper_adopts_an_unlocked_child_by_pid_and_start_time() {
    let scratch = Scratch::new();
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), None));
    let mut first = start(&scratch, 10_000);
    let pid = child_pid(&scratch);
    first.kill().expect("SIGKILL the keeper");
    first.wait().expect("reap the keeper");

    let mut second = start(&scratch, 10_000);
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["child"]["pid"], pid);
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut second, Duration::from_secs(5)).success());
    assert!(!alive(pid));
    let all = records(&scratch);
    assert_eq!(find(&all, "adopted")["by"], "start-time");
}

#[test]
fn the_control_socket_answers_hello_launch_kill_and_exit_when_idle() {
    let scratch = Scratch::new();
    fs::create_dir_all(scratch.keeper()).expect("keeper dir");
    fs::write(
        scratch.keeper().join("spec.json"),
        json!({ "instance": "test", "record": scratch.record(), "lingerMs": 60_000 }).to_string(),
    )
    .expect("spec.json");
    let mut keeper = start(&scratch, 10_000);

    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["ok"], true);
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(hello["pid"], pid_of(&keeper));
    assert_eq!(hello["instance"], "test");
    assert_eq!(hello["child"], Value::Null);
    assert_eq!(hello["hostEnding"], false);
    let mode = fs::metadata(scratch.keeper().join("keeper.sock"))
        .expect("the socket")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);

    let launched = request(
        &scratch,
        &json!({ "op": "launch", "child": scratch.fake(&[]) }),
    );
    assert_eq!(launched["ok"], true, "{launched}");
    let pid = launched["pid"].as_i64().expect("a pid");
    assert_eq!(
        request(&scratch, &json!({ "op": "hello" }))["child"]["pid"],
        pid
    );
    assert_eq!(
        request(&scratch, &json!({ "op": "hello" }))["child"]["adopted"],
        false
    );

    let busy = request(
        &scratch,
        &json!({ "op": "launch", "child": scratch.fake(&[]) }),
    );
    assert_eq!(busy["ok"], false);
    assert_eq!(busy["error"], "busy");

    assert_eq!(request(&scratch, &json!({ "op": "nonsense" }))["ok"], false);
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    wait_until("the child's exit", Duration::from_secs(5), || {
        request(&scratch, &json!({ "op": "hello" }))["child"].is_null()
    });
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["lastExit"]["signal"], 9);
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], false);

    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert_eq!(find(&records(&scratch), "exiting")["reason"], "requested");
}

#[test]
fn a_second_keeper_for_the_same_directory_steps_aside() {
    let scratch = Scratch::new();
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), None));
    let mut first = start(&scratch, 10_000);
    let pid = child_pid(&scratch);
    let mut second = Command::new(keeper_bin())
        .args(["run", "--dir"])
        .arg(scratch.keeper())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn a second keeper");
    let status = wait_exit(&mut second, Duration::from_secs(5));
    assert!(status.success());
    assert!(alive(pid));
    assert_eq!(
        request(&scratch, &json!({ "op": "hello" }))["pid"],
        pid_of(&first)
    );
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut first, Duration::from_secs(5)).success());
}

#[test]
fn ctl_sends_one_request_and_prints_the_answer() {
    let scratch = Scratch::new();
    fs::create_dir_all(scratch.keeper()).expect("keeper dir");
    fs::write(
        scratch.keeper().join("spec.json"),
        json!({ "lingerMs": 60_000 }).to_string(),
    )
    .expect("spec.json");
    let mut keeper = start(&scratch, 10_000);
    request(&scratch, &json!({ "op": "hello" }));
    let out = Command::new(keeper_bin())
        .args(["ctl", "--dir"])
        .arg(scratch.keeper())
        .arg(r#"{"op":"exit-when-idle"}"#)
        .output()
        .expect("run ctl");
    assert!(out.status.success());
    let answer: Value = serde_json::from_slice(&out.stdout).expect("JSON on stdout");
    assert_eq!(answer["ok"], true);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn version_prints_the_version_and_protocol() {
    let out = Command::new(keeper_bin())
        .arg("version")
        .output()
        .expect("run version");
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        format!("winvm-keeper {} protocol 1", env!("CARGO_PKG_VERSION"))
    );
}
