use std::fs::{DirBuilder, File};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitCode};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use crate::adopt;
use crate::kq::{Event, Kqueue};
use crate::record::{self, Record};
use crate::sock::{self, Server};
use crate::spawn;
use crate::state::{self, ChildSpec, Kept, Spec, State};
use crate::{PROTOCOL, VERSION};

const DEFAULT_LINGER: Duration = Duration::from_secs(10);
const STOP_MARGIN: Duration = Duration::from_secs(5);
const KILL_MARGIN: Duration = Duration::from_secs(2);
const GRACE_AFTER_STOP: Duration = Duration::from_secs(3);
const HOST_END_POLL: Duration = Duration::from_millis(250);

pub struct Settings {
    pub dir: PathBuf,
    pub budget: Duration,
}

struct Running {
    kept: Kept,
    process: Option<Child>,
}

struct StopAction {
    process: Child,
    pid: i32,
    started: Instant,
}

struct HostEnd {
    stop_deadline: Instant,
    kill_at: Instant,
    stop: Option<StopAction>,
    killed: bool,
}

struct Keeper {
    dir: PathBuf,
    budget: Duration,
    linger: Duration,
    spec: Spec,
    record: Record,
    kq: Kqueue,
    server: Server,
    child: Option<Running>,
    last_exit: Option<Value>,
    host_end: Option<HostEnd>,
    idle_since: Instant,
    exit_requested: bool,
    _lock: File,
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGTERM => "SIGTERM".to_owned(),
        libc::SIGINT => "SIGINT".to_owned(),
        libc::SIGHUP => "SIGHUP".to_owned(),
        other => format!("signal {other}"),
    }
}

fn pid_of(process: &Child) -> i32 {
    i32::try_from(process.id()).unwrap_or(i32::MAX)
}

fn default_instance(dir: &Path) -> String {
    dir.parent()
        .and_then(Path::file_name)
        .or_else(|| dir.file_name())
        .map_or_else(
            || "default".to_owned(),
            |n| n.to_string_lossy().into_owned(),
        )
}

pub fn run(settings: Settings) -> ExitCode {
    match start(settings) {
        Ok(Some(keeper)) => keeper.serve(),
        Ok(None) => ExitCode::SUCCESS,
        Err(problem) => {
            eprintln!("winvm-keeper: {problem}");
            ExitCode::FAILURE
        }
    }
}

fn start(settings: Settings) -> Result<Option<Keeper>, String> {
    let dir = settings.dir;
    let shown = dir.display().to_string();
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| format!("{shown}: {e}"))?;
    let Some(lock) =
        adopt::hold(&dir.join(state::LOCK)).map_err(|e| format!("{shown}/{}: {e}", state::LOCK))?
    else {
        eprintln!("winvm-keeper: another keeper holds {shown}");
        return Ok(None);
    };
    spawn::block_in_this_process().map_err(|e| format!("blocking signals: {e}"))?;
    let spec = state::read_spec(&dir)?;
    let instance = spec
        .instance
        .clone()
        .unwrap_or_else(|| default_instance(&dir));
    let kq = Kqueue::new().map_err(|e| format!("kqueue: {e}"))?;
    for signal in spawn::SHIELDED {
        kq.watch_signal(signal)
            .map_err(|e| format!("watching signal {signal}: {e}"))?;
    }
    let server = Server::bind(&dir).map_err(|e| format!("{shown}/{}: {e}", state::SOCKET))?;
    kq.watch_readable(server.fd())
        .map_err(|e| format!("watching the socket: {e}"))?;
    let mut keeper = Keeper {
        budget: settings.budget,
        linger: spec.linger_ms.map_or(DEFAULT_LINGER, Duration::from_millis),
        record: Record::new(spec.record.clone(), instance),
        spec,
        kq,
        server,
        child: None,
        last_exit: None,
        host_end: None,
        idle_since: Instant::now(),
        exit_requested: false,
        _lock: lock,
        dir,
    };
    keeper.record.note(
        "started",
        &[
            ("pid", std::process::id().into()),
            ("version", VERSION.into()),
        ],
    );
    keeper.resume_or_launch();
    Ok(Some(keeper))
}

impl Keeper {
    fn resume_or_launch(&mut self) {
        match state::read_state(&self.dir) {
            Ok(Some(previous)) => self.adopt(previous.child),
            Ok(None) => {
                self.save();
                if let Some(child) = self.spec.child.clone() {
                    if let Err(error) = self.launch(&child) {
                        self.record.note(
                            "launch-failed",
                            &[("child", child.name.into()), ("error", error.into())],
                        );
                    }
                }
            }
            Err(problem) => {
                eprintln!("winvm-keeper: {problem}; nothing to adopt");
                self.save();
            }
        }
    }

    fn save(&self) {
        let current = State {
            child: self.child.as_ref().map(|r| r.kept.clone()),
        };
        if let Err(e) = state::write_state(&self.dir, &current) {
            eprintln!("winvm-keeper: writing {}: {e}", state::STATE);
        }
    }

    fn gone(&mut self, kept: &Kept, what: &str, fields: Vec<(&'static str, Value)>) {
        let mut all = vec![
            ("child", Value::from(kept.name.clone())),
            ("pid", kept.pid.into()),
        ];
        all.extend(fields);
        self.record.note(what, &all);
        let mut summary = serde_json::Map::new();
        for (key, value) in all {
            summary.insert(key.to_owned(), value);
        }
        if what == "exited-unknown" {
            summary.insert("unknown".to_owned(), true.into());
        }
        self.last_exit = Some(Value::Object(summary));
        self.child = None;
        self.idle_since = Instant::now();
        self.save();
    }

    fn adopt(&mut self, previous: Option<Kept>) {
        let Some(kept) = previous else {
            self.save();
            return;
        };
        let watched =
            adopt::identify(&kept).filter(|_| self.kq.watch_exit(kept.pid).unwrap_or(false));
        match watched {
            Some(by) => {
                self.record.note(
                    "adopted",
                    &[
                        ("child", kept.name.clone().into()),
                        ("pid", kept.pid.into()),
                        ("by", by.into()),
                    ],
                );
                self.child = Some(Running {
                    kept,
                    process: None,
                });
                self.save();
            }
            None => self.gone(&kept, "exited-unknown", Vec::new()),
        }
    }

    fn launch(&mut self, spec: &ChildSpec) -> Result<i32, String> {
        let program = spec.command.argv.first().cloned().unwrap_or_default();
        let process =
            spawn::spawn(&spec.command, &[], false).map_err(|e| format!("{program}: {e}"))?;
        let pid = pid_of(&process);
        let kept = Kept {
            name: spec.name.clone(),
            pid,
            start_us: adopt::start_time_us(pid).unwrap_or(0),
            pidfile: spec.pidfile.clone(),
        };
        self.child = Some(Running {
            kept,
            process: Some(process),
        });
        self.save();
        self.record.note(
            "launched",
            &[
                ("child", spec.name.clone().into()),
                ("pid", pid.into()),
                ("program", program.into()),
            ],
        );
        if let Err(e) = self.kq.watch_exit(pid) {
            eprintln!("winvm-keeper: watching {pid}: {e}");
        }
        Ok(pid)
    }

    fn poll_child(&mut self, exited: &[i32]) {
        let Some(running) = &mut self.child else {
            return;
        };
        let kept = running.kept.clone();
        let outcome = match &mut running.process {
            Some(process) => match process.try_wait() {
                Ok(Some(status)) => Some(("exited", spawn::exit_fields(status))),
                Ok(None) => None,
                Err(e) => {
                    eprintln!("winvm-keeper: waiting for {}: {e}", kept.pid);
                    Some(("exited-unknown", Vec::new()))
                }
            },
            None => (exited.contains(&kept.pid) || adopt::identify(&kept).is_none())
                .then(|| ("exited-unknown", Vec::new())),
        };
        if let Some((what, fields)) = outcome {
            self.gone(&kept, what, fields);
        }
    }

    fn signal_child(&self, signal: libc::c_int) -> Option<i32> {
        let running = self.child.as_ref()?;
        let pid = running.kept.pid;
        let ours = running.process.is_some() || adopt::identify(&running.kept).is_some();
        (ours && spawn::kill(pid, signal)).then_some(pid)
    }

    fn begin_host_end(&mut self, signal: i32) {
        if self.host_end.is_some() {
            eprintln!("winvm-keeper: {} while already ending", signal_name(signal));
            return;
        }
        let now = Instant::now();
        self.record.note(
            "host-ending",
            &[
                ("signal", signal_name(signal).into()),
                ("budgetMs", millis(self.budget).into()),
            ],
        );
        let mut host = HostEnd {
            stop_deadline: now + self.budget.saturating_sub(STOP_MARGIN),
            kill_at: now + self.budget.saturating_sub(KILL_MARGIN),
            stop: None,
            killed: false,
        };
        if let Some(running) = &self.child {
            match &self.spec.stop {
                Some(stop) => {
                    let deadline = SystemTime::now() + self.budget.saturating_sub(STOP_MARGIN);
                    let env = [
                        (
                            "WINVM_KEEPER_DEADLINE_MS",
                            record::epoch_ms(deadline).to_string(),
                        ),
                        ("WINVM_KEEPER_CHILD_PID", running.kept.pid.to_string()),
                        ("WINVM_KEEPER_INSTANCE", self.record.instance().to_owned()),
                    ];
                    match spawn::spawn(stop, &env, true) {
                        Ok(process) => {
                            let pid = pid_of(&process);
                            if let Err(e) = self.kq.watch_exit(pid) {
                                eprintln!("winvm-keeper: watching the stop action {pid}: {e}");
                            }
                            host.stop = Some(StopAction {
                                process,
                                pid,
                                started: now,
                            });
                        }
                        Err(e) => {
                            self.record.note(
                                "host-end",
                                &[
                                    ("step", "stop-action".into()),
                                    ("ok", false.into()),
                                    ("error", e.to_string().into()),
                                ],
                            );
                            host.kill_at = now;
                        }
                    }
                }
                None => host.kill_at = now,
            }
        }
        self.host_end = Some(host);
    }

    fn poll_stop(&mut self, now: Instant) {
        let Some(host) = &mut self.host_end else {
            return;
        };
        let Some(stop) = &mut host.stop else {
            return;
        };
        let ms = millis(stop.started.elapsed());
        let fields = match stop.process.try_wait() {
            Ok(Some(status)) => {
                let mut fields = vec![
                    ("step", "stop-action".into()),
                    ("ok", status.success().into()),
                ];
                fields.extend(spawn::exit_fields(status));
                fields
            }
            Ok(None) if now >= host.stop_deadline => {
                spawn::kill(-stop.pid, libc::SIGKILL);
                spawn::kill(stop.pid, libc::SIGKILL);
                let _ = stop.process.wait();
                vec![
                    ("step", "stop-action".into()),
                    ("ok", false.into()),
                    ("error", "deadline".into()),
                ]
            }
            Ok(None) => return,
            Err(e) => vec![
                ("step", "stop-action".into()),
                ("ok", false.into()),
                ("error", e.to_string().into()),
            ],
        };
        let mut fields = fields;
        fields.push(("ms", ms.into()));
        self.record.note("host-end", &fields);
        host.stop = None;
        host.kill_at = host.kill_at.min(now + GRACE_AFTER_STOP);
    }

    fn tick(&mut self, exited: &[i32]) -> Option<&'static str> {
        self.poll_child(exited);
        let now = Instant::now();
        self.poll_stop(now);
        let Some(host) = &self.host_end else {
            let idle = self.child.is_none();
            return if idle && self.exit_requested {
                Some("requested")
            } else if idle && now >= self.idle_since + self.linger {
                Some("idle")
            } else {
                None
            };
        };
        if !host.killed && now >= host.kill_at {
            if let Some(pid) = self.signal_child(libc::SIGKILL) {
                self.record
                    .note("host-end", &[("step", "kill".into()), ("pid", pid.into())]);
            }
            if let Some(host) = &mut self.host_end {
                host.killed = true;
            }
        }
        let finished =
            self.child.is_none() && self.host_end.as_ref().is_some_and(|h| h.stop.is_none());
        if finished {
            self.record.note("host-end", &[("step", "done".into())]);
            return Some("host-end");
        }
        None
    }

    fn next_wake(&self) -> Option<Duration> {
        let now = Instant::now();
        match &self.host_end {
            Some(host) => {
                let mut wake = now + HOST_END_POLL;
                if host.stop.is_some() {
                    wake = wake.min(host.stop_deadline);
                }
                if !host.killed {
                    wake = wake.min(host.kill_at);
                }
                Some(wake.saturating_duration_since(now))
            }
            None if self.child.is_none() => {
                Some((self.idle_since + self.linger).saturating_duration_since(now))
            }
            None => None,
        }
    }

    fn answer(&mut self, request: &Value) -> Value {
        match request["op"].as_str() {
            Some("hello") => self.hello(),
            Some("launch") => {
                if self.host_end.is_some() {
                    return json!({ "ok": false, "error": "host-ending" });
                }
                if self.child.is_some() {
                    return json!({ "ok": false, "error": "busy" });
                }
                match serde_json::from_value::<ChildSpec>(request["child"].clone()) {
                    Ok(spec) => match self.launch(&spec) {
                        Ok(pid) => json!({ "ok": true, "pid": pid }),
                        Err(error) => json!({ "ok": false, "error": error }),
                    },
                    Err(e) => json!({ "ok": false, "error": format!("child: {e}") }),
                }
            }
            Some("kill") => match self.signal_child(libc::SIGKILL) {
                Some(pid) => json!({ "ok": true, "pid": pid }),
                None => json!({ "ok": false, "error": "no child" }),
            },
            Some("exit-when-idle") => {
                self.exit_requested = true;
                json!({ "ok": true })
            }
            _ => json!({ "ok": false, "error": "unknown op" }),
        }
    }

    fn hello(&self) -> Value {
        json!({
            "ok": true,
            "protocol": PROTOCOL,
            "version": VERSION,
            "pid": std::process::id(),
            "instance": self.record.instance(),
            "child": self.child.as_ref().map(|r| json!({
                "name": r.kept.name,
                "pid": r.kept.pid,
                "startUs": r.kept.start_us,
                "adopted": r.process.is_none(),
            })),
            "lastExit": self.last_exit,
            "hostEnding": self.host_end.is_some(),
        })
    }

    fn answer_all(&mut self) {
        for stream in self.server.pending() {
            match sock::read_request(&stream) {
                Ok(request) => {
                    let answer = self.answer(&request);
                    sock::reply(&stream, &answer);
                }
                Err(e) => eprintln!("winvm-keeper: request: {e}"),
            }
        }
    }

    fn finish(self, reason: &str) -> ExitCode {
        self.record.note("exiting", &[("reason", reason.into())]);
        state::remove_state(&self.dir);
        ExitCode::SUCCESS
    }

    fn serve(mut self) -> ExitCode {
        let mut exited = Vec::new();
        loop {
            if let Some(reason) = self.tick(&exited) {
                return self.finish(reason);
            }
            exited.clear();
            let events = match self.kq.wait(self.next_wake()) {
                Ok(events) => events,
                Err(e) => {
                    eprintln!("winvm-keeper: kevent: {e}");
                    std::thread::sleep(HOST_END_POLL);
                    Vec::new()
                }
            };
            let mut readable = false;
            for event in events {
                match event {
                    Event::Signal(libc::SIGHUP) => eprintln!("winvm-keeper: SIGHUP ignored"),
                    Event::Signal(signal) => self.begin_host_end(signal),
                    Event::Exit(pid) => exited.push(pid),
                    Event::Readable => readable = true,
                }
            }
            if readable {
                if let Some(reason) = self.tick(&exited) {
                    return self.finish(reason);
                }
                exited.clear();
                self.answer_all();
            }
        }
    }
}
