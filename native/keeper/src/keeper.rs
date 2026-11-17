use std::fs::{DirBuilder, File};
use std::os::fd::RawFd;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitCode};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use crate::adopt;
use crate::kq::{Event, Kqueue};
use crate::qmp;
use crate::record::{self, Record};
use crate::sock::{Connection, Received, Server};
use crate::spawn;
use crate::state::{self, ChildSpec, Kept, Spec, State};
use crate::{PROTOCOL, VERSION};

const DEFAULT_LINGER: Duration = Duration::from_secs(10);
const STOP_MARGIN: Duration = Duration::from_secs(5);
const KILL_MARGIN: Duration = Duration::from_secs(2);
const GRACE_AFTER_STOP: Duration = Duration::from_secs(3);
const HOST_END_POLL: Duration = Duration::from_millis(250);
const MIGRATE_MARGIN: Duration = Duration::from_secs(12);
const QMP_TIMEOUT: Duration = Duration::from_secs(1);

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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fallback {
    Check,
    Migrating,
    Waiting,
    Quit,
}

struct HostEnd {
    stop_deadline: Instant,
    kill_at: Instant,
    quit_at: Instant,
    migrate_until: Instant,
    stop: Option<StopAction>,
    fallback: Option<Fallback>,
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
    sidecars: Vec<Running>,
    last_exit: Option<Value>,
    host_end: Option<HostEnd>,
    idle_since: Instant,
    exit_requested: bool,
    boot_session: Option<String>,
    connections: Vec<Connection>,
    stragglers: Vec<Child>,
    _lock: File,
}

enum Failure {
    Retry(String),
    Park(String),
}

const REQUEST_FIELDS: [&str; 2] = ["op", "protocol"];

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
        Err(Failure::Park(problem)) => {
            eprintln!("winvm-keeper: {problem}; nothing to keep, so not retrying");
            ExitCode::SUCCESS
        }
        Err(Failure::Retry(problem)) => {
            eprintln!("winvm-keeper: {problem}");
            ExitCode::FAILURE
        }
    }
}

fn live_child(previous: Option<&State>) -> bool {
    previous
        .and_then(|p| p.child.as_ref())
        .is_some_and(|kept| adopt::identify(kept).is_some())
}

fn spec_or_previous(
    dir: &Path,
    previous: Option<&State>,
) -> Result<(Spec, Option<String>), Failure> {
    match state::read_spec(dir) {
        Ok(spec) => Ok((spec, None)),
        Err(problem) if live_child(previous) => {
            let p = previous.cloned().unwrap_or_default();
            let spec = Spec {
                session: p.session,
                instance: p.instance,
                record: p.record,
                linger_ms: None,
                child: None,
                stop: p.stop,
            };
            Ok((spec, Some(problem)))
        }
        Err(problem) => {
            if let Some(p) = previous {
                let instance = p.instance.clone().unwrap_or_else(|| default_instance(dir));
                Record::new(p.record.clone(), instance)
                    .note("start-failed", &[("error", problem.clone().into())]);
            }
            Err(Failure::Park(problem))
        }
    }
}

fn start(settings: Settings) -> Result<Option<Keeper>, Failure> {
    let dir = settings.dir;
    let shown = dir.display().to_string();
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| Failure::Retry(format!("{shown}: {e}")))?;
    let Some(lock) = adopt::hold(&dir.join(state::LOCK))
        .map_err(|e| Failure::Retry(format!("{shown}/{}: {e}", state::LOCK)))?
    else {
        eprintln!("winvm-keeper: another keeper holds {shown}");
        return Ok(None);
    };
    spawn::block_in_this_process().map_err(|e| Failure::Retry(format!("blocking signals: {e}")))?;
    let kq = Kqueue::new().map_err(|e| Failure::Retry(format!("kqueue: {e}")))?;
    for signal in spawn::SHIELDED.into_iter().chain([libc::SIGCHLD]) {
        kq.watch_signal(signal)
            .map_err(|e| Failure::Retry(format!("watching signal {signal}: {e}")))?;
    }
    let (previous, unreadable) = match state::read_state(&dir) {
        Ok(previous) => (previous, None),
        Err(problem) => {
            eprintln!("winvm-keeper: {problem}; nothing to adopt, and nothing launched");
            (None, Some(problem))
        }
    };
    let (spec, invalid) = spec_or_previous(&dir, previous.as_ref())?;
    let server = Server::bind(&dir).map_err(|e| {
        let problem = format!("{shown}/{}: {e}", state::SOCKET);
        if e.kind() == std::io::ErrorKind::InvalidInput {
            Failure::Park(problem)
        } else {
            Failure::Retry(problem)
        }
    })?;
    kq.watch_readable(server.fd())
        .map_err(|e| Failure::Retry(format!("watching the socket: {e}")))?;
    let instance = spec
        .instance
        .clone()
        .unwrap_or_else(|| default_instance(&dir));
    let mut keeper = Keeper {
        budget: settings.budget,
        linger: spec.linger_ms.map_or(DEFAULT_LINGER, Duration::from_millis),
        record: Record::new(spec.record.clone(), instance),
        spec,
        kq,
        server,
        child: None,
        sidecars: Vec::new(),
        last_exit: None,
        host_end: None,
        idle_since: Instant::now(),
        exit_requested: false,
        boot_session: adopt::boot_session(),
        connections: Vec::new(),
        stragglers: Vec::new(),
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
    if let Some(problem) = invalid {
        keeper
            .record
            .note("spec-invalid", &[("error", problem.into())]);
    }
    if let Some(problem) = &unreadable {
        keeper
            .record
            .note("state-unreadable", &[("error", problem.clone().into())]);
    }
    let ending = spawn::pending_shutdown();
    keeper.resume_or_launch(previous, unreadable.is_none() && ending.is_none());
    if let Some(signal) = ending {
        keeper.begin_host_end(signal);
    }
    Ok(Some(keeper))
}

impl Keeper {
    fn resume_or_launch(&mut self, previous: Option<State>, may_launch: bool) {
        let launch = match previous {
            None => {
                self.save();
                true
            }
            Some(previous) => {
                let new_boot = matches!(
                    (&previous.boot_session, &self.boot_session),
                    (Some(was), Some(now)) if was != now
                );
                let new_session = (previous.session.is_some() || self.spec.session.is_some())
                    && previous.session != self.spec.session;
                let adopted = self.adopt(previous.child);
                self.adopt_sidecars(previous.sidecars);
                if !adopted {
                    self.retire_sidecars();
                }
                !adopted && (new_boot || new_session)
            }
        };
        if !launch || !may_launch {
            return;
        }
        if let Some(child) = self.spec.child.clone() {
            if let Err(error) = self.launch(&child) {
                self.record.note(
                    "launch-failed",
                    &[("child", child.name.into()), ("error", error.into())],
                );
            }
        }
    }

    fn save(&self) {
        let current = State {
            session: self.spec.session.clone(),
            boot_session: self.boot_session.clone(),
            instance: Some(self.record.instance().to_owned()),
            record: self.spec.record.clone(),
            stop: self.spec.stop.clone(),
            child: self.child.as_ref().map(|r| r.kept.clone()),
            sidecars: self.sidecars.iter().map(|r| r.kept.clone()).collect(),
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
        self.retire_sidecars();
        self.save();
    }

    fn adopt_sidecars(&mut self, previous: Vec<Kept>) {
        for kept in previous {
            let watched =
                adopt::identify(&kept).filter(|_| self.kq.watch_exit(kept.pid).unwrap_or(false));
            let fields = [
                ("child", kept.name.clone().into()),
                ("pid", kept.pid.into()),
            ];
            match watched {
                Some(by) => {
                    let mut fields = fields.to_vec();
                    fields.push(("by", by.into()));
                    self.record.note("adopted", &fields);
                    self.sidecars.push(Running {
                        kept,
                        process: None,
                    });
                }
                None => self.record.note("exited-unknown", &fields),
            }
        }
        self.save();
    }

    fn retire_sidecars(&mut self) {
        for running in &self.sidecars {
            let ours = running.process.is_some() || adopt::identify(&running.kept).is_some();
            if ours {
                spawn::kill(running.kept.pid, libc::SIGKILL);
            }
        }
    }

    fn poll_sidecars(&mut self, exited: &[i32]) {
        let mut gone = Vec::new();
        self.sidecars.retain_mut(|running| {
            let outcome = match &mut running.process {
                Some(process) => match process.try_wait() {
                    Ok(Some(status)) => Some(("exited", spawn::exit_fields(status))),
                    Ok(None) => None,
                    Err(_) => Some(("exited-unknown", Vec::new())),
                },
                None => (exited.contains(&running.kept.pid)
                    || adopt::identify(&running.kept).is_none())
                .then(|| ("exited-unknown", Vec::new())),
            };
            match outcome {
                Some((what, fields)) => {
                    gone.push((running.kept.clone(), what, fields));
                    false
                }
                None => true,
            }
        });
        if gone.is_empty() {
            return;
        }
        for (kept, what, fields) in gone {
            let mut all = vec![("child", Value::from(kept.name)), ("pid", kept.pid.into())];
            all.extend(fields);
            self.record.note(what, &all);
        }
        self.save();
    }

    fn launch_sidecar(&mut self, spec: &ChildSpec) -> Result<i32, String> {
        if let Some(index) = self.sidecars.iter().position(|r| r.kept.name == spec.name) {
            let mut old = self.sidecars.swap_remove(index);
            if old.process.is_some() || adopt::identify(&old.kept).is_some() {
                spawn::kill(old.kept.pid, libc::SIGKILL);
            }
            let (what, fields) = match old.process.as_mut().map(Child::wait) {
                Some(Ok(status)) => ("exited", spawn::exit_fields(status)),
                _ => ("exited-unknown", Vec::new()),
            };
            let mut all = vec![
                ("child", Value::from(old.kept.name.clone())),
                ("pid", old.kept.pid.into()),
            ];
            all.extend(fields);
            self.record.note(what, &all);
        }
        let program = spec.argv.first().cloned().unwrap_or_default();
        let process =
            spawn::spawn(&spec.command(), &[], false).map_err(|e| format!("{program}: {e}"))?;
        let pid = pid_of(&process);
        self.sidecars.push(Running {
            kept: Kept {
                name: spec.name.clone(),
                pid,
                start_us: adopt::start_time_us(pid).unwrap_or(0),
                pidfile: spec.pidfile.clone(),
                qmp: None,
            },
            process: Some(process),
        });
        self.idle_since = Instant::now();
        self.save();
        self.record.note(
            "launched",
            &[
                ("child", spec.name.clone().into()),
                ("pid", pid.into()),
                ("program", program.into()),
                ("sidecar", true.into()),
            ],
        );
        if let Err(e) = self.kq.watch_exit(pid) {
            eprintln!("winvm-keeper: watching {pid}: {e}");
        }
        Ok(pid)
    }

    fn adopt(&mut self, previous: Option<Kept>) -> bool {
        let Some(kept) = previous else {
            self.save();
            return false;
        };
        let watched =
            adopt::identify(&kept).filter(|_| self.kq.watch_exit(kept.pid).unwrap_or(false));
        let Some(by) = watched else {
            self.gone(&kept, "exited-unknown", Vec::new());
            return false;
        };
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
        true
    }

    fn launch(&mut self, spec: &ChildSpec) -> Result<i32, String> {
        let program = spec.argv.first().cloned().unwrap_or_default();
        let process =
            spawn::spawn(&spec.command(), &[], false).map_err(|e| format!("{program}: {e}"))?;
        let pid = pid_of(&process);
        let kept = Kept {
            name: spec.name.clone(),
            pid,
            start_us: adopt::start_time_us(pid).unwrap_or(0),
            pidfile: spec.pidfile.clone(),
            qmp: spec.qmp.clone(),
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
            quit_at: now + self.budget.saturating_sub(STOP_MARGIN),
            migrate_until: now + self.budget.saturating_sub(MIGRATE_MARGIN),
            stop: None,
            fallback: None,
            killed: false,
        };
        if self.child.is_none() {
            self.retire_sidecars();
        }
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
                None if running.kept.qmp.is_some() => host.fallback = Some(Fallback::Check),
                None => host.kill_at = now,
            }
        }
        self.host_end = Some(host);
    }

    fn host_end_step(&self, step: &str, outcome: Result<Value, String>) {
        let mut fields = vec![("step", Value::from(step)), ("ok", outcome.is_ok().into())];
        if let Err(error) = outcome {
            fields.push(("error", error.into()));
        }
        self.record.note("host-end", &fields);
    }

    fn power_down(&self, socket: &Path) -> Fallback {
        let status = qmp::execute(socket, "query-status", QMP_TIMEOUT)
            .ok()
            .and_then(|s| s["status"].as_str().map(str::to_owned));
        if let Some(stopped) = status
            .as_deref()
            .filter(|s| matches!(*s, "postmigrate" | "inmigrate" | "prelaunch"))
        {
            let quit = qmp::execute(socket, "quit", QMP_TIMEOUT);
            let mut fields = vec![
                ("step", Value::from("quit")),
                ("ok", quit.is_ok().into()),
                ("status", stopped.into()),
            ];
            if let Err(error) = quit {
                fields.push(("error", error.into()));
            }
            self.record.note("host-end", &fields);
            return Fallback::Quit;
        }
        let sent = qmp::execute(socket, "system_powerdown", QMP_TIMEOUT);
        let mut fields = vec![
            ("step", Value::from("powerdown")),
            ("ok", sent.is_ok().into()),
        ];
        if let Some(status) = &status {
            fields.push(("status", status.clone().into()));
        }
        if let Err(error) = &sent {
            fields.push(("error", error.clone().into()));
        }
        if sent.is_ok() && matches!(status.as_deref(), Some("paused" | "suspended")) {
            let resumed = qmp::execute(socket, "cont", QMP_TIMEOUT);
            fields.push(("cont", resumed.is_ok().into()));
        }
        self.record.note("host-end", &fields);
        Fallback::Waiting
    }

    fn step_fallback(&mut self, now: Instant) {
        let Some(host) = &self.host_end else {
            return;
        };
        let (Some(step), migrate_until, quit_at) =
            (host.fallback, host.migrate_until, host.quit_at)
        else {
            return;
        };
        let Some(socket) = self.child.as_ref().and_then(|r| r.kept.qmp.clone()) else {
            return;
        };
        let next = match step {
            Fallback::Check | Fallback::Migrating => {
                match qmp::execute(&socket, "query-migrate", QMP_TIMEOUT) {
                    Ok(answer) if qmp::migrating(&answer) && now < migrate_until => {
                        if step == Fallback::Check {
                            self.record
                                .note("host-end", &[("step", "migration-wait".into())]);
                        }
                        Fallback::Migrating
                    }
                    Ok(answer) if qmp::migrating(&answer) => {
                        let cancelled = qmp::execute(&socket, "migrate_cancel", QMP_TIMEOUT);
                        self.host_end_step("migrate-cancel", cancelled);
                        self.power_down(&socket)
                    }
                    _ => self.power_down(&socket),
                }
            }
            Fallback::Waiting if now >= quit_at => {
                let quit = qmp::execute(&socket, "quit", QMP_TIMEOUT);
                self.host_end_step("quit", quit);
                Fallback::Quit
            }
            other => other,
        };
        if let Some(host) = &mut self.host_end {
            host.fallback = Some(next);
        }
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
                spawn::kill_group(stop.pid, libc::SIGKILL);
                spawn::kill(stop.pid, libc::SIGKILL);
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
        if let Some(stop) = host.stop.take() {
            self.stragglers.push(stop.process);
        }
        host.kill_at = host.kill_at.min(now + GRACE_AFTER_STOP);
    }

    fn reap_stragglers(&mut self) {
        self.stragglers
            .retain_mut(|process| matches!(process.try_wait(), Ok(None)));
    }

    fn drop_late_connections(&mut self, now: Instant) {
        self.connections.retain(|c| c.deadline > now);
    }

    fn tick(&mut self, exited: &[i32]) -> Option<&'static str> {
        self.poll_child(exited);
        self.poll_sidecars(exited);
        let now = Instant::now();
        self.poll_stop(now);
        self.reap_stragglers();
        self.drop_late_connections(now);
        let Some(host) = &self.host_end else {
            let idle = self.child.is_none();
            let reason = if idle && self.exit_requested {
                Some("requested")
            } else if idle && now >= self.idle_since + self.linger {
                Some("idle")
            } else {
                None
            };
            if reason.is_some() && !self.sidecars.is_empty() {
                self.retire_sidecars();
                return None;
            }
            return reason;
        };
        let killed = host.killed;
        let kill_at = host.kill_at;
        if !killed && now < kill_at {
            self.step_fallback(now);
        }
        if !killed && now >= kill_at {
            if let Some(pid) = self.signal_child(libc::SIGKILL) {
                self.record
                    .note("host-end", &[("step", "kill".into()), ("pid", pid.into())]);
            }
            if let Some(host) = &mut self.host_end {
                host.killed = true;
            }
        }
        let finished = self.child.is_none()
            && self.sidecars.is_empty()
            && self.host_end.as_ref().is_some_and(|h| h.stop.is_none());
        if finished {
            self.record.note("host-end", &[("step", "done".into())]);
            return Some("host-end");
        }
        None
    }

    fn next_wake(&self) -> Option<Duration> {
        let now = Instant::now();
        let soonest = self.connections.iter().map(|c| c.deadline).min();
        let wake = self.state_wake(now);
        match (wake, soonest) {
            (Some(wake), Some(deadline)) => Some(wake.min(deadline.saturating_duration_since(now))),
            (None, Some(deadline)) => Some(deadline.saturating_duration_since(now)),
            (wake, None) => wake,
        }
    }

    fn state_wake(&self, now: Instant) -> Option<Duration> {
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
                let idle_at = self.idle_since + self.linger;
                Some(if self.sidecars.is_empty() || now < idle_at {
                    idle_at.saturating_duration_since(now)
                } else {
                    HOST_END_POLL
                })
            }
            None => None,
        }
    }

    fn answer(&mut self, request: &Value) -> Value {
        let Some(fields) = request.as_object() else {
            return json!({ "ok": false, "error": "a request is one JSON object" });
        };
        let op = request["op"].as_str();
        if op == Some("hello") {
            if request["launching"] == Value::Bool(true) {
                self.idle_since = Instant::now();
            }
            return self.hello();
        }
        if let Some(protocol) = fields.get("protocol") {
            let newer = protocol.as_u64().is_none_or(|p| p > u64::from(PROTOCOL));
            if newer && op != Some("hello") {
                return json!({
                    "ok": false,
                    "error": format!("protocol {protocol} is newer than this keeper's"),
                    "protocol": PROTOCOL,
                });
            }
        }
        let extra: &[&str] = if matches!(op, Some("launch" | "launch-sidecar")) {
            &["child"]
        } else {
            &[]
        };
        if let Some(unknown) = fields
            .keys()
            .find(|k| !REQUEST_FIELDS.contains(&k.as_str()) && !extra.contains(&k.as_str()))
        {
            return json!({ "ok": false, "error": format!("unknown field {unknown}") });
        }
        match op {
            Some("launch-sidecar") => {
                if self.host_end.is_some() {
                    return json!({ "ok": false, "error": "host-ending" });
                }
                if self.child.is_some() {
                    return json!({ "ok": false, "error": "busy" });
                }
                match serde_json::from_value::<ChildSpec>(request["child"].clone()) {
                    Ok(spec) => match self.launch_sidecar(&spec) {
                        Ok(pid) => json!({ "ok": true, "pid": pid }),
                        Err(error) => json!({ "ok": false, "error": error }),
                    },
                    Err(e) => json!({ "ok": false, "error": format!("child: {e}") }),
                }
            }
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
            Some("kill") => {
                let killed = self.signal_child(libc::SIGKILL);
                self.retire_sidecars();
                match killed {
                    Some(pid) => json!({ "ok": true, "pid": pid }),
                    None => json!({ "ok": false, "error": "no child" }),
                }
            }
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
            "sidecars": self.sidecars.iter().map(|r| json!({
                "name": r.kept.name,
                "pid": r.kept.pid,
                "startUs": r.kept.start_us,
                "adopted": r.process.is_none(),
            })).collect::<Vec<_>>(),
            "lastExit": self.last_exit,
            "hostEnding": self.host_end.is_some(),
        })
    }

    fn accept(&mut self) {
        for connection in self.server.accept() {
            if let Err(e) = self.kq.watch_readable(connection.fd()) {
                eprintln!("winvm-keeper: watching a connection: {e}");
                continue;
            }
            self.connections.push(connection);
            self.serve_connection(self.connections.len() - 1);
        }
    }

    fn serve_connection(&mut self, index: usize) {
        let mut connection = self.connections.swap_remove(index);
        match connection.read() {
            Received::Pending => self.connections.push(connection),
            Received::Closed => {}
            Received::Line(line) => {
                let answer = match serde_json::from_str::<Value>(&line) {
                    Ok(request) => self.answer(&request),
                    Err(e) => json!({ "ok": false, "error": format!("bad request: {e}") }),
                };
                connection.reply(&answer);
            }
        }
    }

    fn readable(&mut self, fd: RawFd) {
        if fd == self.server.fd() {
            self.accept();
        } else if let Some(index) = self.connections.iter().position(|c| c.fd() == fd) {
            self.serve_connection(index);
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
            let mut readable = Vec::new();
            for event in events {
                match event {
                    Event::Signal(libc::SIGHUP) => eprintln!("winvm-keeper: SIGHUP ignored"),
                    Event::Signal(libc::SIGCHLD) => {}
                    Event::Signal(signal) => self.begin_host_end(signal),
                    Event::Exit(pid) => exited.push(pid),
                    Event::Readable(fd) => readable.push(fd),
                }
            }
            if !readable.is_empty() {
                if let Some(reason) = self.tick(&exited) {
                    return self.finish(reason);
                }
                exited.clear();
                for fd in readable {
                    self.readable(fd);
                }
            }
        }
    }
}
