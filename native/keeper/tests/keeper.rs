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
        let reports: String = fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| fs::read_to_string(entry.path()).ok())
            .collect();
        for pid in reports
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
    assert_eq!(hello["protocol"], 3);
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
        format!("winvm-keeper {} protocol 3", env!("CARGO_PKG_VERSION"))
    );
}

fn hello_child_pid(scratch: &Scratch) -> i32 {
    wait_until("the child", Duration::from_secs(5), || {
        request(scratch, &json!({ "op": "hello" }))["child"]["pid"].is_i64()
    });
    let hello = request(scratch, &json!({ "op": "hello" }));
    i32::try_from(hello["child"]["pid"].as_i64().expect("a child pid")).expect("a pid")
}

fn start_time_us(pid: i32) -> u64 {
    // SAFETY: proc_bsdinfo is plain data, and the buffer is exactly its size.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).expect("size");
        let got = libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size);
        assert_eq!(got, size, "proc_pidinfo({pid})");
        info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec
    }
}

fn gone_pid() -> i32 {
    let mut child = Command::new("/usr/bin/true").spawn().expect("spawn true");
    let pid = pid_of(&child);
    child.wait().expect("reap true");
    pid
}

fn write_state(scratch: &Scratch, state: &Value) {
    fs::create_dir_all(scratch.keeper()).expect("keeper dir");
    fs::write(scratch.keeper().join("state.json"), state.to_string()).expect("state.json");
}

#[test]
fn an_unshielded_child_starts_with_an_empty_mask_and_dies_on_sigterm() {
    let scratch = Scratch::new();
    let mut child = scratch.fake(&[]);
    child["shield"] = json!(false);
    scratch.write_spec(&spec(&scratch, &child, None));
    let mut keeper = start(&scratch, 10_000);
    child_pid(&scratch);
    assert!(
        scratch.report().contains("blocked TERM=0 HUP=0 INT=0"),
        "{}",
        scratch.report()
    );
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());

    let plain = Scratch::new();
    let child = json!({ "name": "plain", "argv": ["/bin/sleep", "600"], "shield": false });
    plain.write_spec(&spec(&plain, &child, None));
    let mut keeper = start(&plain, 10_000);
    let pid = hello_child_pid(&plain);
    signal(pid, libc::SIGTERM);
    let exited = wait_exit(&mut keeper, Duration::from_secs(5));
    if alive(pid) {
        signal(pid, libc::SIGKILL);
    }
    assert!(exited.success());
    assert_eq!(find(&records(&plain), "exited")["signal"], libc::SIGTERM);
}

#[test]
fn a_state_left_by_an_earlier_session_does_not_stop_the_launch() {
    let scratch = Scratch::new();
    let dead = gone_pid();
    write_state(
        &scratch,
        &json!({ "session": "old", "child": { "name": "fake", "pid": dead, "startUs": 1, "pidfile": null } }),
    );
    let mut fresh = spec(&scratch, &scratch.fake(&[]), None);
    fresh["session"] = json!("new");
    scratch.write_spec(&fresh);
    let mut keeper = start(&scratch, 10_000);
    let pid = child_pid(&scratch);
    assert_eq!(
        keeper_whats(&scratch),
        ["started", "exited-unknown", "launched"],
        "{:?}",
        records(&scratch)
    );
    assert_eq!(find(&records(&scratch), "exited-unknown")["pid"], dead);
    assert_eq!(find(&records(&scratch), "launched")["pid"], pid);
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_state_from_before_the_last_boot_does_not_stop_the_launch() {
    let scratch = Scratch::new();
    write_state(
        &scratch,
        &json!({
            "bootSession": "00000000-0000-0000-0000-000000000000",
            "child": { "name": "fake", "pid": gone_pid(), "startUs": 1, "pidfile": null },
        }),
    );
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), None));
    let mut keeper = start(&scratch, 10_000);
    child_pid(&scratch);
    assert_eq!(
        keeper_whats(&scratch),
        ["started", "exited-unknown", "launched"]
    );
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn adoption_refuses_a_live_process_with_the_wrong_start_time() {
    let scratch = Scratch::new();
    let mut stranger = Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .expect("spawn sleep");
    let pid = pid_of(&stranger);
    let mut state =
        json!({ "child": { "name": "fake", "pid": pid, "startUs": 1, "pidfile": null } });
    fs::create_dir_all(scratch.keeper()).expect("keeper dir");
    let mut keeper = start(&scratch, 10_000);
    request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    state["session"] = Value::Null;
    write_state(&scratch, &state);
    scratch.write_spec(&json!({ "instance": "test", "record": scratch.record(), "lingerMs": 300 }));
    let mut keeper = start(&scratch, 10_000);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(alive(pid), "the stranger was signalled");
    assert_eq!(find(&records(&scratch), "exited-unknown")["pid"], pid);
    stranger.kill().expect("kill sleep");
    stranger.wait().expect("reap sleep");
}

#[test]
fn adoption_refuses_a_pid_whose_pidfile_another_process_holds() {
    let scratch = Scratch::new();
    let pidfile = scratch.path("fake.pid");
    let mut holder = Command::new(fakechild())
        .args([
            scratch.path("report").as_str(),
            "--pidfile",
            pidfile.as_str(),
        ])
        .spawn()
        .expect("spawn the lock holder");
    wait_until("the lock", Duration::from_secs(5), || {
        scratch.report().contains("blocked")
    });
    let mut stranger = Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .expect("spawn sleep");
    let pid = pid_of(&stranger);
    write_state(
        &scratch,
        &json!({ "child": { "name": "fake", "pid": pid, "startUs": start_time_us(pid), "pidfile": pidfile } }),
    );
    scratch.write_spec(&json!({ "instance": "test", "record": scratch.record(), "lingerMs": 300 }));
    let mut keeper = start(&scratch, 10_000);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(alive(pid));
    assert!(records(&scratch).iter().all(|r| r["what"] != "adopted"));
    for process in [&mut stranger, &mut holder] {
        process.kill().expect("kill");
        process.wait().expect("reap");
    }
}

#[test]
fn idle_connections_do_not_delay_an_answer() {
    let scratch = Scratch::new();
    scratch.write_spec(&json!({ "lingerMs": 60_000 }));
    let mut keeper = start(&scratch, 10_000);
    request(&scratch, &json!({ "op": "hello" }));
    let socket = scratch.keeper().join("keeper.sock");
    let idle: Vec<UnixStream> = (0..4)
        .map(|_| UnixStream::connect(&socket).expect("an idle connection"))
        .collect();
    std::thread::sleep(Duration::from_millis(50));
    let asked = Instant::now();
    assert_eq!(request(&scratch, &json!({ "op": "hello" }))["ok"], true);
    assert!(
        asked.elapsed() < Duration::from_millis(500),
        "hello took {:?}",
        asked.elapsed()
    );
    drop(idle);
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn requests_with_unknown_fields_or_a_newer_protocol_are_refused() {
    let scratch = Scratch::new();
    scratch.write_spec(&json!({ "lingerMs": 60_000 }));
    let mut keeper = start(&scratch, 10_000);
    assert_eq!(
        request(&scratch, &json!({ "op": "hello", "protocol": 3 }))["ok"],
        true
    );
    let newer = request(&scratch, &json!({ "op": "kill", "protocol": 4 }));
    assert_eq!(newer["ok"], false);
    assert_eq!(newer["protocol"], 3);
    assert_eq!(
        request(&scratch, &json!({ "op": "kill", "slot": "x" }))["ok"],
        false
    );
    let typo = request(
        &scratch,
        &json!({ "op": "launch", "child": { "argv": ["/bin/sleep", "9"], "pidFile": "/tmp/x" } }),
    );
    assert_eq!(typo["ok"], false, "{typo}");
    assert!(
        typo["error"].as_str().unwrap_or("").contains("pidFile"),
        "{typo}"
    );
    assert!(request(&scratch, &json!({ "op": "hello" }))["child"].is_null());
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_bad_spec_parks_the_keeper_with_exit_zero() {
    let scratch = Scratch::new();
    fs::create_dir_all(scratch.keeper()).expect("keeper dir");
    fs::write(scratch.keeper().join("spec.json"), "{ not json").expect("spec.json");
    let mut keeper = start(&scratch, 10_000);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(fs::read_to_string(scratch.path("keeper.err"))
        .expect("stderr")
        .contains("spec.json"));
    let typo = Scratch::new();
    typo.write_spec(&json!({ "child": { "argv": ["/bin/sleep", "9"] }, "lingerMS": 5 }));
    let mut keeper = start(&typo, 10_000);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(fs::read_to_string(typo.path("keeper.err"))
        .expect("stderr")
        .contains("lingerMS"));
}

#[test]
fn a_bad_spec_still_adopts_a_live_child_and_keeps_its_record() {
    let scratch = Scratch::new();
    scratch.write_spec(&spec(&scratch, &scratch.fake_locked(), None));
    let mut first = start(&scratch, 10_000);
    let pid = child_pid(&scratch);
    first.kill().expect("SIGKILL the keeper");
    first.wait().expect("reap the keeper");
    fs::write(scratch.keeper().join("spec.json"), "{ not json").expect("spec.json");
    let mut second = start(&scratch, 10_000);
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["child"]["pid"], pid);
    assert_eq!(hello["instance"], "test");
    signal(pid_of(&second), libc::SIGTERM);
    assert!(wait_exit(&mut second, Duration::from_secs(5)).success());
    assert!(!alive(pid));
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "started",
            "spec-invalid",
            "adopted",
            "host-ending",
            "host-end:kill",
            "exited-unknown",
            "host-end:done",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
}

fn boot_time_us() -> u64 {
    // SAFETY: timeval is plain data, the name is NUL-terminated and the size is passed in.
    unsafe {
        let mut boot: libc::timeval = std::mem::zeroed();
        let mut size = std::mem::size_of::<libc::timeval>();
        let got = libc::sysctlbyname(
            c"kern.boottime".as_ptr(),
            (&raw mut boot).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        );
        assert_eq!(got, 0, "kern.boottime");
        u64::try_from(boot.tv_sec).expect("secs") * 1_000_000
            + u64::try_from(boot.tv_usec).expect("usecs")
    }
}

fn exits_soon(scratch: &Scratch) -> Value {
    json!({ "name": "brief", "argv": ["/bin/bash", "-c", "echo x"], "log": scratch.path("brief.log") })
}

#[test]
fn a_child_that_exits_at_once_is_reaped_without_any_request() {
    for round in 0..20 {
        let scratch = Scratch::new();
        let mut quick = spec(&scratch, &exits_soon(&scratch), None);
        quick["lingerMs"] = json!(100);
        scratch.write_spec(&quick);
        let mut keeper = start(&scratch, 10_000);
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            if let Some(status) = keeper.try_wait().expect("try_wait") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = keeper.kill();
                panic!(
                    "round {round}: the keeper kept a finished child: {:?}",
                    records(&scratch)
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success());
        assert_eq!(
            find(&records(&scratch), "exited")["status"],
            0,
            "round {round}"
        );
    }
}

#[test]
fn a_launched_child_that_exits_at_once_is_recorded_without_any_request() {
    let scratch = Scratch::new();
    scratch
        .write_spec(&json!({ "instance": "test", "record": scratch.record(), "lingerMs": 60_000 }));
    let mut keeper = start(&scratch, 10_000);
    for round in 0..20 {
        let launched = request(
            &scratch,
            &json!({ "op": "launch", "child": exits_soon(&scratch) }),
        );
        assert_eq!(launched["ok"], true, "round {round}: {launched}");
        let wanted = round + 1;
        let deadline = Instant::now() + Duration::from_secs(3);
        while records(&scratch)
            .iter()
            .filter(|r| r["what"] == "exited")
            .count()
            < wanted
        {
            assert!(Instant::now() < deadline, "round {round}: no exited record");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_clock_step_does_not_make_a_crash_restart_relaunch() {
    let scratch = Scratch::new();
    write_state(
        &scratch,
        &json!({
            "session": "same",
            "bootUs": boot_time_us() - 1,
            "child": { "name": "fake", "pid": gone_pid(), "startUs": 1, "pidfile": null },
        }),
    );
    let mut same = spec(&scratch, &scratch.fake(&[]), None);
    same["session"] = json!("same");
    scratch.write_spec(&same);
    let mut keeper = start(&scratch, 10_000);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert_eq!(
        keeper_whats(&scratch),
        ["started", "exited-unknown", "exiting"]
    );
}

#[test]
fn an_unreadable_state_launches_nothing() {
    let scratch = Scratch::new();
    fs::create_dir_all(scratch.keeper()).expect("keeper dir");
    fs::write(scratch.keeper().join("state.json"), "{ truncated").expect("state.json");
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), None));
    let mut keeper = start(&scratch, 10_000);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert_eq!(
        keeper_whats(&scratch),
        ["started", "state-unreadable", "exiting"]
    );
    let all = records(&scratch);
    assert!(find(&all, "state-unreadable")["error"]
        .as_str()
        .is_some_and(|e| e.contains("state.json")));
}

#[test]
fn a_sigterm_pending_at_start_launches_nothing() {
    let scratch = Scratch::new();
    scratch.write_spec(&spec(&scratch, &scratch.fake(&[]), None));
    let term = {
        // SAFETY: sigset_t is plain data, initialised by sigemptyset.
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&raw mut set);
            libc::sigaddset(&raw mut set, libc::SIGTERM);
            set
        }
    };
    // SAFETY: blocks SIGTERM in this test thread only, so the keeper starts with it blocked.
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &raw const term, std::ptr::null_mut()) };
    let mut keeper = start(&scratch, 10_000);
    // SAFETY: restores this test thread's mask.
    unsafe { libc::pthread_sigmask(libc::SIG_UNBLOCK, &raw const term, std::ptr::null_mut()) };
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert_eq!(
        keeper_whats(&scratch),
        ["started", "host-ending", "host-end:done", "exiting"],
        "{:?}",
        records(&scratch)
    );
}

#[test]
fn hello_answers_a_newer_client_with_this_keepers_protocol() {
    let scratch = Scratch::new();
    scratch.write_spec(&json!({ "lingerMs": 60_000 }));
    let mut keeper = start(&scratch, 10_000);
    let hello = request(
        &scratch,
        &json!({ "op": "hello", "protocol": 4, "client": "winvm 9" }),
    );
    assert_eq!(hello["ok"], true, "{hello}");
    assert_eq!(hello["protocol"], 3);
    assert_eq!(hello["hostEnding"], false);
    let kill = request(&scratch, &json!({ "op": "kill", "protocol": 4 }));
    assert_eq!(kill["ok"], false);
    assert_eq!(kill["protocol"], 3);
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

fn fake_as(scratch: &Scratch, name: &str, report: &str, extra: &[&str]) -> Value {
    let mut argv = vec![
        fakechild().to_string_lossy().into_owned(),
        scratch.path(report),
    ];
    argv.extend(extra.iter().map(|s| (*s).to_owned()));
    json!({ "name": name, "argv": argv, "log": scratch.path(&format!("{name}.log")) })
}

fn idle_keeper(scratch: &Scratch, linger_ms: u64) -> Child {
    scratch.write_spec(
        &json!({ "instance": "test", "record": scratch.record(), "lingerMs": linger_ms }),
    );
    start(scratch, 10_000)
}

fn launched_pid(answer: &Value) -> i32 {
    i32::try_from(
        answer["pid"]
            .as_i64()
            .unwrap_or_else(|| panic!("a pid in {answer}")),
    )
    .expect("a pid")
}

fn reported(scratch: &Scratch, report: &str, pid: i32) {
    wait_until("the fake's report", Duration::from_secs(5), || {
        fs::read_to_string(scratch.path(report))
            .unwrap_or_default()
            .contains(&format!("pid={pid}"))
    });
}

fn sidecar(scratch: &Scratch, name: &str) -> i32 {
    let answer = request(
        scratch,
        &json!({ "op": "launch-sidecar", "child": fake_as(scratch, name, name, &[]) }),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    let pid = launched_pid(&answer);
    reported(scratch, name, pid);
    pid
}

fn exits_of(scratch: &Scratch, child: &str) -> Vec<Value> {
    records(scratch)
        .into_iter()
        .filter(|r| r["what"] == "exited" && r["child"] == child)
        .collect()
}

#[test]
fn sidecars_run_shielded_beside_the_child_and_die_with_it() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let tpm = sidecar(&scratch, "swtpm");
    assert!(
        fs::read_to_string(scratch.path("swtpm"))
            .unwrap_or_default()
            .contains("blocked TERM=1 HUP=1 INT=1"),
        "the sidecar is shielded"
    );
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["child"], Value::Null);
    assert_eq!(hello["sidecars"][0]["name"], "swtpm");
    assert_eq!(hello["sidecars"][0]["pid"], tpm);
    assert_eq!(hello["sidecars"][0]["adopted"], false);

    let main = request(
        &scratch,
        &json!({ "op": "launch", "child": fake_as(&scratch, "qemu", "qemu", &[]) }),
    );
    assert_eq!(main["ok"], true, "{main}");
    let qemu = launched_pid(&main);
    reported(&scratch, "qemu", qemu);
    let busy = request(
        &scratch,
        &json!({ "op": "launch-sidecar", "child": fake_as(&scratch, "swtpm", "swtpm", &[]) }),
    );
    assert_eq!(busy["ok"], false);
    assert_eq!(busy["error"], "busy");
    assert!(alive(tpm));

    signal(qemu, libc::SIGUSR1);
    wait_until(
        "the sidecar to go with the child",
        Duration::from_secs(5),
        || {
            request(&scratch, &json!({ "op": "hello" }))["sidecars"]
                .as_array()
                .is_some_and(Vec::is_empty)
        },
    );
    assert!(!alive(tpm));
    assert_eq!(exits_of(&scratch, "qemu")[0]["status"], 0);
    assert_eq!(exits_of(&scratch, "swtpm")[0]["signal"], 9);
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["lastExit"]["child"], "qemu");
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn sidecars_without_a_child_are_killed_when_the_keeper_goes_idle() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 400);
    let started = Instant::now();
    let tpm = sidecar(&scratch, "swtpm");
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(started.elapsed() >= Duration::from_millis(400));
    assert!(!alive(tpm));
    assert_eq!(
        keeper_whats(&scratch),
        ["started", "launched", "exited", "exiting"],
        "{:?}",
        records(&scratch)
    );
    assert_eq!(exits_of(&scratch, "swtpm")[0]["signal"], 9);
}

#[test]
fn kill_takes_the_sidecars_too_when_no_child_runs() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let tpm = sidecar(&scratch, "swtpm");
    let killed = request(&scratch, &json!({ "op": "kill" }));
    assert_eq!(killed["ok"], false);
    assert_eq!(killed["error"], "no child");
    wait_until("the sidecar to go", Duration::from_secs(5), || !alive(tpm));
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_sidecar_launched_again_replaces_the_one_running() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let first = sidecar(&scratch, "swtpm");
    let second = sidecar(&scratch, "swtpm");
    assert_ne!(first, second);
    assert!(!alive(first));
    assert!(alive(second));
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["sidecars"].as_array().map(Vec::len), Some(1));
    assert_eq!(hello["sidecars"][0]["pid"], second);
    assert_eq!(exits_of(&scratch, "swtpm")[0]["pid"], first);
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], false);
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(!alive(second));
}

#[test]
fn a_restarted_keeper_adopts_its_sidecars_and_still_ends_them_with_the_child() {
    let scratch = Scratch::new();
    let mut first = idle_keeper(&scratch, 60_000);
    let tpm = sidecar(&scratch, "swtpm");
    let pidfile = scratch.path("qemu.pid");
    let mut main = fake_as(&scratch, "qemu", "qemu", &["--pidfile", &pidfile]);
    main["pidfile"] = json!(pidfile);
    let qemu = launched_pid(&request(
        &scratch,
        &json!({ "op": "launch", "child": main }),
    ));
    reported(&scratch, "qemu", qemu);
    first.kill().expect("SIGKILL the keeper");
    first.wait().expect("reap the keeper");

    let mut second = start(&scratch, 10_000);
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["child"]["pid"], qemu);
    assert_eq!(hello["sidecars"][0]["pid"], tpm);
    assert_eq!(hello["sidecars"][0]["adopted"], true);
    signal(qemu, libc::SIGUSR1);
    wait_until("the adopted sidecar to go", Duration::from_secs(5), || {
        !alive(tpm)
    });
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut second, Duration::from_secs(5)).success());
    let adopted: Vec<_> = records(&scratch)
        .into_iter()
        .filter(|r| r["what"] == "adopted")
        .map(|r| r["child"].as_str().unwrap_or("").to_owned())
        .collect();
    assert_eq!(adopted, ["qemu", "swtpm"]);
}

#[test]
fn a_host_end_without_a_child_ends_the_sidecars_at_once() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let tpm = sidecar(&scratch, "swtpm");
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(!alive(tpm));
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "host-ending",
            "exited",
            "host-end:done",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
}

fn monitored(scratch: &Scratch, extra: &[&str]) -> Child {
    let socket = scratch.path("qmp.sock");
    let mut args = vec!["--qmp", socket.as_str()];
    args.extend_from_slice(extra);
    let mut child = fake_as(scratch, "qemu", "qemu", &args);
    child["qmp"] = json!(socket);
    scratch.write_spec(&json!({
        "instance": "test",
        "record": scratch.record(),
        "lingerMs": 60_000,
        "child": child,
    }));
    start_budget(scratch)
}

fn start_budget(scratch: &Scratch) -> Child {
    let budget = fs::read_to_string(scratch.path("budget")).unwrap_or_else(|_| "20000".to_owned());
    start(scratch, budget.trim().parse().expect("a budget"))
}

fn qmp_seen(scratch: &Scratch) -> Vec<String> {
    fs::read_to_string(scratch.path("qemu"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.strip_prefix("qmp "))
        .filter(|c| *c != "qmp_capabilities")
        .map(str::to_owned)
        .collect()
}

fn host_end_with(scratch: &Scratch, budget_ms: u64, extra: &[&str]) -> (ExitStatus, Duration) {
    fs::write(scratch.path("budget"), budget_ms.to_string()).expect("budget");
    let mut keeper = monitored(scratch, extra);
    let pid = hello_child_pid(scratch);
    reported(scratch, "qemu", pid);
    wait_until("the private monitor", Duration::from_secs(5), || {
        Path::new(&scratch.path("qmp.sock")).exists()
    });
    let sent = Instant::now();
    signal(pid_of(&keeper), libc::SIGTERM);
    let status = wait_exit(&mut keeper, Duration::from_millis(budget_ms + 3000));
    assert!(!alive(pid));
    (status, sent.elapsed())
}

fn steps(scratch: &Scratch) -> Vec<Value> {
    records(scratch)
        .into_iter()
        .filter(|r| r["what"] == "host-end")
        .collect()
}

#[test]
fn sigterm_asks_the_guest_to_power_down_through_the_private_monitor() {
    let scratch = Scratch::new();
    let (status, took) = host_end_with(&scratch, 20_000, &[]);
    assert!(status.success());
    assert!(took < Duration::from_secs(3), "{took:?}");
    assert_eq!(
        qmp_seen(&scratch),
        ["query-migrate", "query-status", "system_powerdown"]
    );
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "host-ending",
            "host-end:powerdown",
            "exited",
            "host-end:done",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
    assert_eq!(steps(&scratch)[0]["ok"], true);
    assert_eq!(steps(&scratch)[0]["status"], "running");
    assert_eq!(exits_of(&scratch, "qemu")[0]["status"], 0);
}

#[test]
fn a_paused_guest_is_powered_down_then_continued() {
    let scratch = Scratch::new();
    let (status, _) = host_end_with(&scratch, 20_000, &["--status", "paused"]);
    assert!(status.success());
    assert_eq!(
        qmp_seen(&scratch),
        ["query-migrate", "query-status", "system_powerdown", "cont"]
    );
    assert_eq!(steps(&scratch)[0]["cont"], true);
}

#[test]
fn a_guest_that_ignores_the_power_button_is_quit_at_the_budget_less_five_seconds() {
    let scratch = Scratch::new();
    let (status, took) = host_end_with(&scratch, 7000, &["--powerdown", "ignore"]);
    assert!(status.success());
    assert!(took >= Duration::from_millis(1900), "{took:?}");
    assert!(took < Duration::from_secs(4), "{took:?}");
    assert_eq!(
        qmp_seen(&scratch),
        ["query-migrate", "query-status", "system_powerdown", "quit"]
    );
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "host-ending",
            "host-end:powerdown",
            "host-end:quit",
            "exited",
            "host-end:done",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
    assert_eq!(exits_of(&scratch, "qemu")[0]["status"], 0);
}

#[test]
fn a_qemu_that_neither_powers_down_nor_quits_is_killed_at_the_budget_less_two_seconds() {
    let scratch = Scratch::new();
    let (status, took) = host_end_with(
        &scratch,
        6000,
        &["--powerdown", "ignore", "--quit", "ignore"],
    );
    assert!(status.success());
    assert!(took >= Duration::from_millis(3900), "{took:?}");
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "host-ending",
            "host-end:powerdown",
            "host-end:quit",
            "host-end:kill",
            "exited",
            "host-end:done",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
    assert_eq!(exits_of(&scratch, "qemu")[0]["signal"], 9);
}

#[test]
fn an_unreachable_monitor_still_ends_in_quit_then_kill() {
    let scratch = Scratch::new();
    fs::write(scratch.path("budget"), "6000").expect("budget");
    let mut child = fake_as(&scratch, "qemu", "qemu", &[]);
    child["qmp"] = json!(scratch.path("nobody.sock"));
    scratch.write_spec(&json!({
        "instance": "test",
        "record": scratch.record(),
        "lingerMs": 60_000,
        "child": child,
    }));
    let mut keeper = start_budget(&scratch);
    let pid = hello_child_pid(&scratch);
    reported(&scratch, "qemu", pid);
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(9)).success());
    assert!(!alive(pid));
    let all = steps(&scratch);
    assert_eq!(all[0]["step"], "powerdown");
    assert_eq!(all[0]["ok"], false);
    assert!(all[0]["error"].is_string());
    assert_eq!(all[1]["step"], "quit");
    assert_eq!(all[1]["ok"], false);
    assert_eq!(all[2]["step"], "kill");
    assert_eq!(exits_of(&scratch, "qemu")[0]["signal"], 9);
}

#[test]
fn a_migration_in_flight_is_waited_for_before_the_power_button() {
    let scratch = Scratch::new();
    let (status, took) = host_end_with(&scratch, 20_000, &["--migrate-ms", "1500"]);
    assert!(status.success());
    assert!(took < Duration::from_secs(4), "{took:?}");
    let seen = qmp_seen(&scratch);
    assert!(!seen.contains(&"migrate_cancel".to_owned()), "{seen:?}");
    assert_eq!(seen.last().map(String::as_str), Some("system_powerdown"));
    assert!(
        seen.iter().filter(|c| *c == "query-migrate").count() > 1,
        "{seen:?}"
    );
    let all = steps(&scratch);
    assert_eq!(all[0]["step"], "migration-wait");
    assert_eq!(all[1]["step"], "powerdown");
}

#[test]
fn a_migration_still_running_at_the_budget_less_twelve_seconds_is_cancelled() {
    let scratch = Scratch::new();
    let (status, took) = host_end_with(&scratch, 13_000, &["--migrate-ms", "600000"]);
    assert!(status.success());
    assert!(took >= Duration::from_millis(900), "{took:?}");
    let seen = qmp_seen(&scratch);
    let cancel = seen
        .iter()
        .position(|c| c == "migrate_cancel")
        .unwrap_or_else(|| panic!("no migrate_cancel in {seen:?}"));
    assert_eq!(&seen[cancel + 1..], ["query-status", "system_powerdown"]);
    let all = steps(&scratch);
    let named: Vec<_> = all
        .iter()
        .map(|s| s["step"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        named,
        ["migration-wait", "migrate-cancel", "powerdown", "done"]
    );
}

#[test]
fn a_child_and_a_sidecar_create_files_with_the_umask_the_client_asked_for() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let touch = |name: &str, umask: u32| {
        let made = scratch.path(&format!("{name}.made"));
        let mut child = fake_as(&scratch, name, name, &["--touch", &made]);
        child["umask"] = json!(umask);
        child
    };
    let made = |name: &str| {
        let path = scratch.path(&format!("{name}.made"));
        wait_until("the file", Duration::from_secs(5), || {
            Path::new(&path).exists()
        });
        fs::metadata(&path).expect("the file").permissions().mode() & 0o777
    };
    let sidecar = request(
        &scratch,
        &json!({ "op": "launch-sidecar", "child": touch("virtiofsd", 0o002) }),
    );
    assert_eq!(sidecar["ok"], true, "{sidecar}");
    assert_eq!(made("virtiofsd"), 0o664);
    let main = request(
        &scratch,
        &json!({ "op": "launch", "child": touch("qemu", 0o027) }),
    );
    assert_eq!(main["ok"], true, "{main}");
    assert_eq!(made("qemu"), 0o640);
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_sidecar_or_a_child_is_refused_while_the_host_ends() {
    let scratch = Scratch::new();
    fs::write(scratch.path("budget"), "20000").expect("budget");
    let mut keeper = monitored(&scratch, &["--powerdown", "ignore"]);
    let pid = hello_child_pid(&scratch);
    reported(&scratch, "qemu", pid);
    signal(pid_of(&keeper), libc::SIGTERM);
    wait_until("the power button", Duration::from_secs(5), || {
        qmp_seen(&scratch).contains(&"system_powerdown".to_owned())
    });
    let sidecar = request(
        &scratch,
        &json!({ "op": "launch-sidecar", "child": fake_as(&scratch, "swtpm", "swtpm", &[]) }),
    );
    assert_eq!(sidecar, json!({ "ok": false, "error": "host-ending" }));
    let child = request(
        &scratch,
        &json!({ "op": "launch", "child": fake_as(&scratch, "other", "other", &[]) }),
    );
    assert_eq!(child, json!({ "ok": false, "error": "host-ending" }));
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_launch_in_progress_keeps_its_sidecars_past_the_linger() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 400);
    let tpm = sidecar(&scratch, "swtpm");
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            request(&scratch, &json!({ "op": "hello", "launching": true }))["ok"],
            true
        );
    }
    assert!(alive(tpm), "the sidecar was retired mid-launch");
    let main = request(
        &scratch,
        &json!({ "op": "launch", "child": fake_as(&scratch, "qemu", "qemu", &[]) }),
    );
    assert_eq!(main["ok"], true, "{main}");
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_plain_hello_does_not_keep_an_idle_keeper_alive() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 400);
    let started = Instant::now();
    while keeper.try_wait().expect("try_wait").is_none() {
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "plain hellos kept the keeper alive"
        );
        let socket = scratch.keeper().join("keeper.sock");
        if let Ok(mut stream) = UnixStream::connect(&socket) {
            let _ = writeln!(stream, "{}", json!({ "op": "hello" }));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn a_guest_stopped_after_a_migration_is_quit_at_once() {
    for status in ["postmigrate", "inmigrate", "prelaunch"] {
        let scratch = Scratch::new();
        let (exit, took) = host_end_with(
            &scratch,
            20_000,
            &["--status", status, "--powerdown", "ignore"],
        );
        assert!(exit.success());
        assert!(took < Duration::from_secs(3), "{status}: {took:?}");
        assert_eq!(
            qmp_seen(&scratch),
            ["query-migrate", "query-status", "quit"],
            "{status}"
        );
        let all = steps(&scratch);
        assert_eq!(all[0]["step"], "quit", "{status}");
        assert_eq!(all[0]["status"], status);
        assert_eq!(exits_of(&scratch, "qemu")[0]["status"], 0);
    }
}

fn service_spec(scratch: &Scratch, build: &str, extra: &[&str]) -> Value {
    let control = scratch.path("control.sock");
    let mut argv = vec![
        fakechild().to_string_lossy().into_owned(),
        scratch.path("service"),
        "--control".to_owned(),
        control.clone(),
        "--keeper".to_owned(),
        scratch.keeper().to_string_lossy().into_owned(),
    ];
    argv.extend(extra.iter().map(|s| (*s).to_owned()));
    json!({
        "argv": argv,
        "log": scratch.path("service.log"),
        "build": build,
        "control": control,
    })
}

fn service_report(scratch: &Scratch) -> String {
    fs::read_to_string(scratch.path("service")).unwrap_or_default()
}

fn start_service(scratch: &Scratch, build: &str, extra: &[&str]) -> i32 {
    let answer = request(
        scratch,
        &json!({ "op": "service", "service": service_spec(scratch, build, extra) }),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    let pid = launched_pid(&answer);
    wait_until("the service's report", Duration::from_secs(5), || {
        service_report(scratch).contains(&format!("pid={pid}"))
    });
    wait_until(
        "the service's control socket",
        Duration::from_secs(5),
        || Path::new(&scratch.path("control.sock")).exists(),
    );
    pid
}

fn whats_of(scratch: &Scratch, what: &str) -> Vec<Value> {
    records(scratch)
        .into_iter()
        .filter(|r| r["what"] == what)
        .collect()
}

#[test]
fn the_service_runs_unshielded_as_the_keepers_child_and_ignored_sigterm_does_not_end_it() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let pid = start_service(&scratch, "b1", &[]);
    assert!(
        service_report(&scratch).contains(&format!(
            "blocked TERM=0 HUP=0 INT=0 pid={pid} keeper={}",
            pid_of(&keeper)
        )),
        "{}",
        service_report(&scratch)
    );
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["service"]["pid"], pid);
    assert_eq!(hello["service"]["build"], "b1");
    assert_eq!(hello["service"]["adopted"], false);
    let again = request(
        &scratch,
        &json!({ "op": "service", "service": service_spec(&scratch, "b1", &[]) }),
    );
    assert_eq!(again["pid"], pid, "{again}");
    assert_eq!(again["started"], false);
    signal(pid, libc::SIGTERM);
    wait_until("the service to see SIGTERM", Duration::from_secs(5), || {
        service_report(&scratch).contains("handled 15")
    });
    assert!(alive(pid));
    let started = whats_of(&scratch, "service-started");
    assert_eq!(started.len(), 1);
    assert_eq!(started[0]["pid"], pid);
    assert_eq!(started[0]["build"], "b1");

    let stopped = request(&scratch, &json!({ "op": "service-stop" }));
    assert_eq!(stopped["ok"], true, "{stopped}");
    assert!(!alive(pid));
    assert!(service_report(&scratch).contains("stopped"));
    assert_eq!(whats_of(&scratch, "service-exited")[0]["status"], 0);
    assert_eq!(
        request(&scratch, &json!({ "op": "hello" }))["service"],
        Value::Null
    );
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_service_of_another_build_is_replaced_once_the_old_one_has_exited() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let old = start_service(&scratch, "b1", &[]);
    let answer = request(
        &scratch,
        &json!({ "op": "service", "service": service_spec(&scratch, "b2", &[]) }),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["started"], true);
    let new = launched_pid(&answer);
    assert_ne!(old, new);
    assert!(!alive(old));
    let exited = whats_of(&scratch, "service-exited");
    assert_eq!(exited[0]["pid"], old);
    assert_eq!(exited[0]["replaced"], true);
    assert_eq!(
        request(&scratch, &json!({ "op": "hello" }))["service"]["build"],
        "b2"
    );
    assert_eq!(
        request(&scratch, &json!({ "op": "service-stop" }))["ok"],
        true
    );
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn an_idle_keeper_waits_for_its_service_to_exit() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 200);
    let pid = start_service(&scratch, "b1", &["--exit", "0", "--after-ms", "1200"]);
    let started = Instant::now();
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
    assert!(
        started.elapsed() >= Duration::from_millis(900),
        "{:?}",
        started.elapsed()
    );
    assert!(!alive(pid));
    assert_eq!(whats_of(&scratch, "service-exited")[0]["status"], 0);
}

#[test]
fn a_crashed_service_is_restarted_while_qemu_runs_and_not_after() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let main = request(
        &scratch,
        &json!({ "op": "launch", "child": fake_as(&scratch, "qemu", "qemu", &[]) }),
    );
    let qemu = launched_pid(&main);
    reported(&scratch, "qemu", qemu);
    let first = start_service(&scratch, "b1", &["--exit", "3", "--after-ms", "100"]);
    wait_until("a restarted service", Duration::from_secs(5), || {
        whats_of(&scratch, "service-started").len() >= 2
    });
    let exited = whats_of(&scratch, "service-exited");
    assert_eq!(exited[0]["pid"], first);
    assert_eq!(exited[0]["status"], 3);
    assert!(exited[0]["restartInMs"].as_u64().is_some(), "{exited:?}");
    assert_eq!(whats_of(&scratch, "service-started")[1]["restart"], 1);
    signal(qemu, libc::SIGUSR1);
    wait_until("the child to go", Duration::from_secs(5), || {
        request(&scratch, &json!({ "op": "hello" }))["child"].is_null()
    });
    std::thread::sleep(Duration::from_millis(2500));
    let after = whats_of(&scratch, "service-started").len();
    std::thread::sleep(Duration::from_millis(2500));
    assert_eq!(whats_of(&scratch, "service-started").len(), after);
    assert_eq!(
        request(&scratch, &json!({ "op": "hello" }))["service"],
        Value::Null
    );
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_restarted_keeper_adopts_its_service() {
    let scratch = Scratch::new();
    let mut first = idle_keeper(&scratch, 60_000);
    let pid = start_service(&scratch, "b1", &[]);
    first.kill().expect("SIGKILL the keeper");
    first.wait().expect("reap the keeper");
    let mut second = start(&scratch, 10_000);
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["service"]["pid"], pid);
    assert_eq!(hello["service"]["adopted"], true);
    assert_eq!(hello["service"]["build"], "b1");
    assert_eq!(
        request(&scratch, &json!({ "op": "service-stop" }))["ok"],
        true
    );
    assert!(!alive(pid));
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut second, Duration::from_secs(5)).success());
}

fn served_host_end(
    scratch: &Scratch,
    budget_ms: u64,
    qemu: &[&str],
    service: &[&str],
) -> (Child, i32, i32) {
    fs::write(scratch.path("budget"), budget_ms.to_string()).expect("budget");
    let keeper = monitored(scratch, qemu);
    let pid = hello_child_pid(scratch);
    reported(scratch, "qemu", pid);
    wait_until("the private monitor", Duration::from_secs(5), || {
        Path::new(&scratch.path("qmp.sock")).exists()
    });
    let service_pid = start_service(scratch, "b1", service);
    (keeper, pid, service_pid)
}

#[test]
fn sigterm_hands_the_host_end_to_the_service_whose_stow_ends_qemu() {
    let scratch = Scratch::new();
    let qmp = scratch.path("qmp.sock");
    let (mut keeper, qemu, service) = served_host_end(
        &scratch,
        20_000,
        &[],
        &["--on-host-end", "quit", "--quit-qmp", &qmp],
    );
    let sent = Instant::now();
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(10)).success());
    assert!(
        sent.elapsed() < Duration::from_secs(4),
        "{:?}",
        sent.elapsed()
    );
    assert!(!alive(qemu));
    assert!(!alive(service));
    let report = service_report(&scratch);
    assert!(
        report.contains("/host-ending {\"budgetMs\":20000,\"deadlineMs\":"),
        "{report}"
    );
    assert!(
        report.contains("handled 15") || !report.contains("handled"),
        "{report}"
    );
    assert!(report.contains("stopped"), "{report}");
    assert_eq!(qmp_seen(&scratch), ["quit"]);
    assert_eq!(
        keeper_whats(&scratch),
        [
            "started",
            "launched",
            "service-started",
            "host-ending",
            "host-end:service",
            "exited",
            "service-exited",
            "host-end:done",
            "exiting"
        ],
        "{:?}",
        records(&scratch)
    );
    assert_eq!(steps(&scratch)[0]["ok"], true);
}

#[test]
fn a_service_that_refuses_the_host_end_leaves_it_to_the_keepers_power_button() {
    let scratch = Scratch::new();
    let (mut keeper, qemu, _) =
        served_host_end(&scratch, 20_000, &[], &["--on-host-end", "refuse"]);
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(10)).success());
    assert!(!alive(qemu));
    let all = steps(&scratch);
    assert_eq!(all[0]["step"], "service");
    assert_eq!(all[0]["ok"], false);
    assert!(
        all[0]["error"].as_str().unwrap_or("").contains("503"),
        "{all:?}"
    );
    assert_eq!(all[1]["step"], "powerdown");
    assert_eq!(
        qmp_seen(&scratch),
        ["query-migrate", "query-status", "system_powerdown"]
    );
}

#[test]
fn a_service_that_overruns_its_deadline_is_overtaken_by_the_power_button() {
    let scratch = Scratch::new();
    let (mut keeper, qemu, _) = served_host_end(&scratch, 10_000, &[], &[]);
    let sent = Instant::now();
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(12)).success());
    let took = sent.elapsed();
    assert!(took >= Duration::from_millis(1900), "{took:?}");
    assert!(took < Duration::from_secs(5), "{took:?}");
    assert!(!alive(qemu));
    let all = steps(&scratch);
    assert_eq!(all[0]["step"], "service");
    assert_eq!(all[0]["ok"], true);
    assert_eq!(all[1]["step"], "fallback");
    assert_eq!(all[1]["reason"], "service-deadline");
    assert_eq!(all[2]["step"], "powerdown");
}

#[test]
fn a_service_that_dies_during_the_host_end_hands_it_to_the_power_button() {
    let scratch = Scratch::new();
    let (mut keeper, qemu, service) = served_host_end(&scratch, 20_000, &[], &[]);
    signal(pid_of(&keeper), libc::SIGTERM);
    wait_until("the service to be asked", Duration::from_secs(5), || {
        service_report(&scratch).contains("/host-ending")
    });
    signal(service, libc::SIGKILL);
    assert!(wait_exit(&mut keeper, Duration::from_secs(10)).success());
    assert!(!alive(qemu));
    let all = steps(&scratch);
    assert_eq!(all[1]["step"], "fallback");
    assert_eq!(all[1]["reason"], "service-gone");
    assert_eq!(all[2]["step"], "powerdown");
}

#[test]
fn a_service_can_hand_the_host_end_back_for_a_shutdown_or_a_quit() {
    for (then, last) in [("shutdown", "system_powerdown"), ("quit", "quit")] {
        let scratch = Scratch::new();
        let flag = format!("fallback-{then}");
        let (mut keeper, qemu, _) = served_host_end(
            &scratch,
            20_000,
            &["--powerdown", "exit"],
            &["--on-host-end", &flag],
        );
        signal(pid_of(&keeper), libc::SIGTERM);
        assert!(wait_exit(&mut keeper, Duration::from_secs(10)).success());
        assert!(!alive(qemu));
        assert!(
            service_report(&scratch).contains("handed back {\"ok\":true}"),
            "{}",
            service_report(&scratch)
        );
        let all = steps(&scratch);
        assert_eq!(all[1]["step"], "fallback", "{all:?}");
        assert_eq!(all[1]["reason"], "test");
        assert_eq!(all[1]["end"], then);
        assert_eq!(
            qmp_seen(&scratch).last().map(String::as_str),
            Some(last),
            "{then}"
        );
    }
}

#[test]
fn a_host_end_request_outside_a_host_end_is_refused() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let answer = request(
        &scratch,
        &json!({ "op": "host-end", "end": "quit", "reason": "x" }),
    );
    assert_eq!(answer, json!({ "ok": false, "error": "not ending" }));
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_keeper_adopts_a_qemu_it_did_not_launch_by_its_pidfile_lock_and_powers_it_down() {
    let scratch = Scratch::new();
    let pidfile = scratch.path("qemu.pid");
    let qmp = scratch.path("qmp.sock");
    let mut legacy = Command::new(fakechild())
        .args([
            scratch.path("qemu"),
            "--pidfile".to_owned(),
            pidfile.clone(),
            "--qmp".to_owned(),
            qmp.clone(),
        ])
        .spawn()
        .expect("spawn a legacy QEMU");
    let pid = pid_of(&legacy);
    reported(&scratch, "qemu", pid);
    wait_until("its monitor", Duration::from_secs(5), || {
        Path::new(&qmp).exists()
    });
    scratch.write_spec(&json!({
        "instance": "test",
        "record": scratch.record(),
        "lingerMs": 60_000,
        "adopt": { "name": "qemu", "pidfile": pidfile, "qmp": qmp },
    }));
    let mut keeper = start(&scratch, 20_000);
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["child"]["pid"], pid, "{hello}");
    assert_eq!(hello["child"]["adopted"], true);
    assert_eq!(hello["child"]["legacy"], true);
    let adopted = whats_of(&scratch, "adopted");
    assert_eq!(adopted[0]["by"], "pidfile");
    assert_eq!(adopted[0]["legacy"], true);
    signal(pid_of(&keeper), libc::SIGTERM);
    assert_eq!(legacy.wait().expect("reap the legacy QEMU").code(), Some(0));
    assert!(wait_exit(&mut keeper, Duration::from_secs(10)).success());
    assert_eq!(
        qmp_seen(&scratch),
        ["query-migrate", "query-status", "system_powerdown"]
    );
    assert_eq!(whats_of(&scratch, "exited-unknown")[0]["child"], "qemu");
}

#[test]
fn a_launched_child_reports_the_runtime_it_was_launched_from() {
    let scratch = Scratch::new();
    let mut keeper = idle_keeper(&scratch, 60_000);
    let mut child = fake_as(&scratch, "qemu", "qemu", &[]);
    child["runtime"] = json!("11.1.2+patches:abc");
    let pid = launched_pid(&request(
        &scratch,
        &json!({ "op": "launch", "child": child }),
    ));
    reported(&scratch, "qemu", pid);
    let hello = request(&scratch, &json!({ "op": "hello" }));
    assert_eq!(hello["child"]["runtime"], "11.1.2+patches:abc");
    assert_eq!(hello["child"]["legacy"], false);
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert_eq!(
        request(&scratch, &json!({ "op": "exit-when-idle" }))["ok"],
        true
    );
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_hand_back_after_the_keeper_has_taken_over_changes_nothing() {
    let scratch = Scratch::new();
    let (mut keeper, _, _) = served_host_end(
        &scratch,
        20_000,
        &["--powerdown", "ignore"],
        &["--on-host-end", "refuse"],
    );
    signal(pid_of(&keeper), libc::SIGTERM);
    wait_until("the power button", Duration::from_secs(5), || {
        qmp_seen(&scratch).contains(&"system_powerdown".to_owned())
    });
    let late = request(
        &scratch,
        &json!({ "op": "host-end", "end": "quit", "reason": "late" }),
    );
    assert_eq!(late["ok"], true, "{late}");
    assert!(
        steps(&scratch).iter().all(|s| s["reason"] != "late"),
        "{:?}",
        steps(&scratch)
    );
    assert!(!qmp_seen(&scratch).contains(&"quit".to_owned()));
    assert_eq!(request(&scratch, &json!({ "op": "kill" }))["ok"], true);
    assert!(wait_exit(&mut keeper, Duration::from_secs(5)).success());
}

#[test]
fn a_service_still_writing_its_stow_after_qemu_quits_gets_time_to_finish() {
    let scratch = Scratch::new();
    let qmp = scratch.path("qmp.sock");
    let (mut keeper, _, service) = served_host_end(
        &scratch,
        20_000,
        &[],
        &[
            "--on-host-end",
            "quit",
            "--quit-qmp",
            &qmp,
            "--stop-ms",
            "3500",
        ],
    );
    signal(pid_of(&keeper), libc::SIGTERM);
    assert!(wait_exit(&mut keeper, Duration::from_secs(12)).success());
    assert!(!alive(service));
    assert!(service_report(&scratch).contains("stopped"));
    let exited = whats_of(&scratch, "service-exited");
    assert_eq!(exited[0]["status"], 0, "{exited:?}");
}
