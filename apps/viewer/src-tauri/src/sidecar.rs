//! Running the winvm CLI (the bundled sidecar), with a deadline where one
//! belongs, and saying why it failed: the helper is `missing`, it would not
//! `launch`, it ran past its `timeout` and was stopped, or it `exit`ed nonzero
//! (or on a signal).
//!
//! A deadline stops only the CLI process this app started: SIGTERM to its own
//! pid (checked to still be this app's child first), two seconds to finish,
//! then the shell plugin's SIGKILL of that same child. Never a process group:
//! QEMU, the per-instance service and the watcher are detached from the CLI
//! and are never signalled from here. A `status` stopped mid-repair leaves its
//! repair lock behind for the next poll to pick up.
//!
//! Reads and connects are bounded; long mutations (setup, start, stop, save,
//! load, file copies, exec, …) keep no automatic deadline, as before: killing
//! them halfway would do more harm than waiting.

use serde::Serialize;
use std::time::Duration;
use tauri::async_runtime::Receiver;
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;
use tokio::time::{timeout_at, Instant};

/// Status, info, doctor and the like: long enough for `status` to repair a stale
/// service or watcher, short enough that a wedged CLI never stops the polling.
pub const READ_TIMEOUT: Duration = Duration::from_secs(45);
/// A terminal's endpoint, the shells it has, the screen's address: these may
/// install or update the guest agent first.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(120);
/// `winvm agent connect`, which may also install the agent.
pub const AGENT_CONNECT_TIMEOUT: Duration = CONNECT_TIMEOUT;
/// `winvm cua serve` printing its token.
pub const SHARE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
/// Between SIGTERM and SIGKILL.
pub const TERM_GRACE: Duration = Duration::from_secs(2);

/// Verbs whose first word after the flags names what they do (`share status`, `saves rm`).
const WITH_SUBCOMMANDS: &[&str] = &["share", "mcp", "saves", "files", "agent", "cua"];

/// What a command printed, and its exit code.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FailureKind {
    Missing,
    Launch,
    Timeout,
    Exit,
}

/// Why a sidecar run failed, for the UI: a stable `kind`, the `operation`, and
/// an actionable `message`; what it printed, its code or signal, and the
/// deadline it ran past are kept for details.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarFailure {
    pub kind: FailureKind,
    pub operation: String,
    pub message: String,
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub timeout_ms: Option<u64>,
    /// The host's own words (an OS error), when there are any.
    pub detail: Option<String>,
}

fn seconds(d: Duration) -> String {
    format!("{}", d.as_millis() as f64 / 1000.0)
}

/// The `::error::` lines a command printed, else its stderr.
fn said(stdout: &str, stderr: &str) -> String {
    let errors: Vec<&str> =
        stdout.lines().chain(stderr.lines()).filter_map(|l| l.strip_prefix("::error::")).map(str::trim).filter(|l| !l.is_empty()).collect();
    if errors.is_empty() {
        stderr.trim().to_owned()
    } else {
        errors.join("\n")
    }
}

impl SidecarFailure {
    fn new(kind: FailureKind, operation: &str, message: String) -> Self {
        SidecarFailure {
            kind,
            operation: operation.to_owned(),
            message,
            stdout: String::new(),
            stderr: String::new(),
            code: None,
            signal: None,
            timeout_ms: None,
            detail: None,
        }
    }

    pub fn missing(operation: &str, detail: String) -> Self {
        SidecarFailure {
            detail: Some(detail),
            ..Self::new(FailureKind::Missing, operation, "winvm's helper (the winvm command inside the app) is missing. Reinstall winvm to put it back.".into())
        }
    }

    pub fn launch(operation: &str, detail: String) -> Self {
        SidecarFailure {
            message: format!("winvm couldn't start its helper for `{operation}` ({detail}). Quit and reopen winvm; if it keeps happening, reinstall it."),
            detail: Some(detail),
            ..Self::new(FailureKind::Launch, operation, String::new())
        }
    }

    /// Not run at all: the request itself was wrong.
    pub fn rejected(operation: &str, message: String) -> Self {
        Self::new(FailureKind::Launch, operation, message)
    }

    pub fn timeout(operation: &str, after: Duration, stdout: String, stderr: String) -> Self {
        let message = format!(
            "`winvm {operation}` didn't answer in {} seconds, so it was stopped. Windows wasn't touched; winvm may be busy finishing a save or a repair. Try again in a moment.",
            seconds(after)
        );
        SidecarFailure { stdout, stderr, timeout_ms: Some(after.as_millis() as u64), ..Self::new(FailureKind::Timeout, operation, message) }
    }

    pub fn exit(operation: &str, code: Option<i32>, signal: Option<i32>, stdout: String, stderr: String) -> Self {
        let text = said(&stdout, &stderr);
        let message = if !text.is_empty() {
            text
        } else if let Some(code) = code {
            format!("`winvm {operation}` exited with code {code}")
        } else if let Some(signal) = signal {
            format!("`winvm {operation}` was stopped by signal {signal}")
        } else {
            format!("`winvm {operation}` ended without an exit code")
        };
        SidecarFailure { stdout, stderr, code, signal, ..Self::new(FailureKind::Exit, operation, message) }
    }
}

/// Why the helper couldn't be started: not there at all, or there and refused.
pub fn spawn_failure(operation: &str, err: &tauri_plugin_shell::Error) -> SidecarFailure {
    match err {
        tauri_plugin_shell::Error::Io(e) if e.kind() == std::io::ErrorKind::NotFound => SidecarFailure::missing(operation, err.to_string()),
        _ => SidecarFailure::launch(operation, err.to_string()),
    }
}

/// The word after the verb's flags (and `-i NAME`), for verbs that have one.
fn subcommand(args: &[String]) -> Option<&str> {
    let mut rest = args.iter().skip(1);
    while let Some(a) = rest.next() {
        if a == "-i" || a == "--instance" {
            rest.next();
        } else if !a.starts_with('-') {
            return Some(a);
        }
    }
    None
}

/// What a run is called in messages: the verb, and its subcommand where it has one.
pub fn operation_of(args: &[String]) -> String {
    match args.first().map(String::as_str) {
        None => "winvm".into(),
        Some(verb) if WITH_SUBCOMMANDS.contains(&verb) => match subcommand(args) {
            Some(sub) => format!("{verb} {sub}"),
            None => verb.into(),
        },
        Some(verb) => verb.into(),
    }
}

/// The deadline for a `winvm` run from the app, by what it does. None: no automatic deadline.
pub fn timeout_for(args: &[String]) -> Option<Duration> {
    match args.first().map(String::as_str).unwrap_or("") {
        "status" | "info" | "doctor" | "ls" | "settings" | "config" | "help" => Some(READ_TIMEOUT),
        "saves" if !matches!(subcommand(args), Some("rm" | "note")) => Some(READ_TIMEOUT),
        "terminal" | "open" => Some(CONNECT_TIMEOUT),
        "share" | "mcp" if subcommand(args) == Some("status") => Some(READ_TIMEOUT),
        _ => None,
    }
}

/// SIGTERM to `pid`, only while it is this process's own child (a zombie not yet
/// reaped still is; a reaped pid taken by something else is not). Never a group.
pub fn terminate_child(pid: u32) -> Result<(), String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(format!("not a process id: {pid}"));
    }
    let pid_text = pid.to_string();
    let ps = std::process::Command::new("/bin/ps").args(["-o", "ppid=", "-p", &pid_text]).output().map_err(|e| e.to_string())?;
    let parent: Option<u32> = String::from_utf8_lossy(&ps.stdout).trim().parse().ok();
    if parent != Some(std::process::id()) {
        return Err(format!("process {pid} is not this app's child, so it was left alone"));
    }
    let status = std::process::Command::new("/bin/kill").args(["-TERM", &pid_text]).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill -TERM {pid} failed"))
    }
}

/// The running CLI, as the runner needs it: its pid for SIGTERM, and SIGKILL.
pub trait SidecarChild {
    fn pid(&self) -> u32;
    /// SIGKILL to this child only (the shell plugin's, which is a no-op once it is reaped).
    fn kill(self) -> Result<(), String>;
}

impl SidecarChild for CommandChild {
    fn pid(&self) -> u32 {
        CommandChild::pid(self)
    }
    fn kill(self) -> Result<(), String> {
        CommandChild::kill(self).map_err(|e| e.to_string())
    }
}

/// How to run: the deadline (None: none), the SIGTERM-to-SIGKILL grace, how to
/// SIGTERM a pid, and, for a server, when what it printed says it is ready.
pub struct Plan<'a> {
    pub timeout: Option<Duration>,
    pub grace: Duration,
    pub terminate: &'a (dyn Fn(u32) -> Result<(), String> + Sync),
    pub ready: Option<&'a (dyn Fn(&str) -> bool + Sync)>,
}

/// A run that ended (exit 0), or a server that said it is ready and keeps running.
pub enum Finished<C> {
    Exited(Output),
    Ready { output: Output, child: C },
}

#[derive(Default)]
struct Collected {
    stdout: String,
    stderr: String,
    errors: Vec<String>,
}

enum Step {
    More,
    Ended(TerminatedPayload),
    Closed,
}

impl Collected {
    fn take(&mut self, event: Option<CommandEvent>) -> Step {
        match event {
            None => Step::Closed,
            Some(CommandEvent::Stdout(line)) => {
                self.stdout.push_str(&String::from_utf8_lossy(&line));
                self.stdout.push('\n');
                Step::More
            }
            Some(CommandEvent::Stderr(line)) => {
                self.stderr.push_str(&String::from_utf8_lossy(&line));
                self.stderr.push('\n');
                Step::More
            }
            Some(CommandEvent::Error(e)) => {
                self.errors.push(e);
                Step::More
            }
            Some(CommandEvent::Terminated(t)) => Step::Ended(t),
            Some(_) => Step::More,
        }
    }

    fn output(&self, code: i32) -> Output {
        Output { code, stdout: self.stdout.clone(), stderr: self.stderr.clone() }
    }

    fn finish(self, operation: &str, t: TerminatedPayload) -> Result<Output, SidecarFailure> {
        if t.code == Some(0) && self.errors.is_empty() {
            return Ok(Output { code: 0, stdout: self.stdout, stderr: self.stderr });
        }
        let detail = (!self.errors.is_empty()).then(|| self.errors.join("\n"));
        if t.code == Some(0) {
            let why = detail.clone().unwrap_or_else(|| "the output stream failed".into());
            let message = format!("winvm couldn't read all of its helper's output for `{operation}` ({why}). Try again.");
            return Err(SidecarFailure {
                stdout: self.stdout,
                stderr: self.stderr,
                detail,
                ..SidecarFailure::new(FailureKind::Launch, operation, message)
            });
        }
        Err(SidecarFailure { detail, ..SidecarFailure::exit(operation, t.code, t.signal, self.stdout, self.stderr) })
    }

    /// The events ended without the process's exit: it can't be told what happened.
    fn lost(self, operation: &str) -> SidecarFailure {
        let why = if self.errors.is_empty() { "its output ended without an exit status".to_owned() } else { self.errors.join("\n") };
        SidecarFailure { stdout: self.stdout, stderr: self.stderr, ..SidecarFailure::launch(operation, why) }
    }
}

/// Reads a spawned CLI's events to its end, or until `plan.ready`, or until the
/// deadline: then SIGTERM to its pid, `plan.grace` to end, and SIGKILL.
pub async fn collect<C: SidecarChild>(mut rx: Receiver<CommandEvent>, child: C, operation: &str, plan: Plan<'_>) -> Result<Finished<C>, SidecarFailure> {
    let mut got = Collected::default();
    let deadline = plan.timeout.map(|t| Instant::now() + t);
    let ready = |got: &Collected| got.errors.is_empty() && plan.ready.is_some_and(|r| r(&got.stdout));
    loop {
        let event = match deadline {
            None => rx.recv().await,
            Some(at) => match timeout_at(at, rx.recv()).await {
                Ok(event) => event,
                Err(_) => break,
            },
        };
        match got.take(event) {
            Step::More if ready(&got) => return Ok(Finished::Ready { output: got.output(0), child }),
            Step::More => {}
            Step::Ended(t) => return got.finish(operation, t).map(Finished::Exited),
            Step::Closed => return Err(got.lost(operation)),
        }
    }
    // An exit (or readiness) already queued when the deadline struck wins over it.
    while let Ok(event) = rx.try_recv() {
        match got.take(Some(event)) {
            Step::More if ready(&got) => return Ok(Finished::Ready { output: got.output(0), child }),
            Step::Ended(t) => return got.finish(operation, t).map(Finished::Exited),
            _ => {}
        }
    }
    let after = plan.timeout.unwrap_or_default();
    let termed = (plan.terminate)(child.pid());
    let grace_ends = Instant::now() + plan.grace;
    let mut ended = false;
    while let Ok(event) = timeout_at(grace_ends, rx.recv()).await {
        match got.take(event) {
            Step::Ended(_) => {
                ended = true;
                break;
            }
            Step::Closed => break,
            Step::More => {}
        }
    }
    let killed = if ended { Ok(()) } else { child.kill() };
    let notes: Vec<String> = [termed.err(), killed.err()].into_iter().flatten().chain(got.errors.iter().cloned()).collect();
    let mut failure = SidecarFailure::timeout(operation, after, got.stdout, got.stderr);
    failure.detail = (!notes.is_empty()).then(|| notes.join("\n"));
    Err(failure)
}

fn spawn(app: &tauri::AppHandle, operation: &str, args: &[String]) -> Result<(Receiver<CommandEvent>, CommandChild), SidecarFailure> {
    app.shell().sidecar("winvm").map_err(|e| spawn_failure(operation, &e))?.args(args).spawn().map_err(|e| spawn_failure(operation, &e))
}

/// Runs `winvm ARGS` to its end, within `timeout` when given. Exit 0 is Ok; anything else is a SidecarFailure.
pub async fn run_sidecar(app: &tauri::AppHandle, args: &[String], timeout: Option<Duration>) -> Result<Output, SidecarFailure> {
    let operation = operation_of(args);
    let (rx, child) = spawn(app, &operation, args)?;
    let plan = Plan { timeout, grace: TERM_GRACE, terminate: &terminate_child, ready: None };
    match collect(rx, child, &operation, plan).await? {
        Finished::Exited(out) | Finished::Ready { output: out, .. } => Ok(out),
    }
}

/// Starts a long-running `winvm ARGS` and waits, within `timeout`, for what it prints to satisfy `ready`.
pub async fn start_sidecar(
    app: &tauri::AppHandle,
    args: &[String],
    timeout: Duration,
    ready: &(dyn Fn(&str) -> bool + Sync),
) -> Result<Finished<CommandChild>, SidecarFailure> {
    let operation = operation_of(args);
    let (rx, child) = spawn(app, &operation, args)?;
    collect(rx, child, &operation, Plan { timeout: Some(timeout), grace: TERM_GRACE, terminate: &terminate_child, ready: Some(ready) }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::async_runtime::{block_on, channel, Sender};
    use tauri_plugin_shell::process::TerminatedPayload;

    type Log = Arc<Mutex<Vec<String>>>;

    struct FakeChild {
        pid: u32,
        log: Log,
    }

    impl SidecarChild for FakeChild {
        fn pid(&self) -> u32 {
            self.pid
        }
        fn kill(self) -> Result<(), String> {
            self.log.lock().unwrap().push(format!("kill {}", self.pid));
            Ok(())
        }
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    fn line(s: &str) -> Vec<u8> {
        s.as_bytes().to_vec()
    }

    fn ended(code: Option<i32>, signal: Option<i32>) -> CommandEvent {
        CommandEvent::Terminated(TerminatedPayload { code, signal })
    }

    async fn send_all(tx: &Sender<CommandEvent>, events: Vec<CommandEvent>) {
        for e in events {
            tx.send(e).await.unwrap();
        }
    }

    /// Runs `collect` over `events` with a fake child (pid 4242) whose SIGTERM and SIGKILL are logged.
    fn run(
        events: Vec<CommandEvent>,
        close: bool,
        timeout: Option<Duration>,
        ready: Option<&(dyn Fn(&str) -> bool + Sync)>,
        on_term: Option<Box<dyn Fn(&Sender<CommandEvent>) + Send + Sync>>,
    ) -> (Result<Finished<FakeChild>, SidecarFailure>, Vec<String>) {
        block_on(async move {
            let log: Log = Arc::default();
            let (tx, rx) = channel(16);
            send_all(&tx, events).await;
            // `close`: no sender is left, so the channel ends after the events (the plugin's threads are done).
            let keep = if close {
                drop(tx);
                None
            } else {
                Some(tx)
            };
            let term_log = log.clone();
            let terminate = move |pid: u32| -> Result<(), String> {
                term_log.lock().unwrap().push(format!("term {pid}"));
                if let (Some(f), Some(tx)) = (&on_term, &keep) {
                    f(tx);
                }
                Ok(())
            };
            let child = FakeChild { pid: 4242, log: log.clone() };
            let plan = Plan { timeout, grace: Duration::from_millis(60), terminate: &terminate, ready };
            let got = collect(rx, child, "status", plan).await;
            let seen = log.lock().unwrap().clone();
            (got, seen)
        })
    }

    fn exited(got: Result<Finished<FakeChild>, SidecarFailure>) -> Result<Output, SidecarFailure> {
        got.map(|f| match f {
            Finished::Exited(out) => out,
            Finished::Ready { .. } => panic!("not a handshake"),
        })
    }

    #[test]
    fn bounds_reads_and_connects_but_not_long_mutations() {
        for read in [
            &["status", "--json"][..],
            &["status", "--json", "-i", "demo"],
            &["info", "-i", "demo", "--json"],
            &["doctor", "--json"],
            &["ls", "--json"],
            &["saves", "-i", "demo", "--json"],
            &["settings", "--section", "terminal"],
            &["config", "-i", "demo", "title=x"],
            &["help"],
            &["share", "-i", "demo", "status", "--json"],
            &["mcp", "status", "-i", "demo", "--json"],
        ] {
            assert_eq!(timeout_for(&args(read)), Some(READ_TIMEOUT), "{read:?}");
        }
        for connect in [&["terminal", "-i", "demo", "--shell", "pwsh", "--connect", "--json"][..], &["terminal", "-i", "demo", "--shells", "--json"], &["open", "--json", "-i", "demo"]] {
            assert_eq!(timeout_for(&args(connect)), Some(CONNECT_TIMEOUT), "{connect:?}");
        }
        for long in [
            &["setup"][..],
            &["start", "-i", "demo"],
            &["stop", "-i", "demo"],
            &["save", "-i", "demo", "before"],
            &["load", "-i", "demo", "before"],
            &["put", "-i", "demo", "/tmp/a", "C:\\a"],
            &["get", "-i", "demo", "C:\\a", "/tmp/a"],
            &["exec", "-i", "demo", "--", "hostname"],
            &["create", "-i", "x"],
            &["destroy", "-i", "x"],
            &["files", "open", "-i", "demo", "c"],
            &["share", "-i", "demo", "install", "--restart", "--json"],
            &["pause", "-i", "demo"],
            &["kill", "-i", "demo"],
            &["saves", "-i", "demo", "rm", "before"],
            &["saves", "-i", "demo", "note", "before", "--text", "kept"],
        ] {
            assert_eq!(timeout_for(&args(long)), None, "{long:?}");
        }
        assert!(READ_TIMEOUT < CONNECT_TIMEOUT);
        assert_eq!(AGENT_CONNECT_TIMEOUT, CONNECT_TIMEOUT);
        assert!(SHARE_HANDSHAKE_TIMEOUT <= CONNECT_TIMEOUT);
        assert_eq!(TERM_GRACE, Duration::from_secs(2));
    }

    #[test]
    fn names_the_operation_with_its_subcommand() {
        assert_eq!(operation_of(&args(&["status", "--json", "-i", "demo"])), "status");
        assert_eq!(operation_of(&args(&["share", "-i", "demo", "status", "--json"])), "share status");
        assert_eq!(operation_of(&args(&["saves", "-i", "demo", "rm", "x"])), "saves rm");
        assert_eq!(operation_of(&args(&["terminal", "-i", "demo", "--shell", "pwsh", "--connect"])), "terminal");
        assert_eq!(operation_of(&[]), "winvm");
    }

    #[test]
    fn collects_stdout_and_stderr_of_a_clean_exit() {
        let (got, log) = run(
            vec![CommandEvent::Stdout(line("a")), CommandEvent::Stderr(line("warn")), CommandEvent::Stdout(line("b")), ended(Some(0), None)],
            true,
            Some(Duration::from_secs(5)),
            None,
            None,
        );
        let out = exited(got).expect("a clean exit");
        assert_eq!((out.code, out.stdout.as_str(), out.stderr.as_str()), (0, "a\nb\n", "warn\n"));
        assert!(log.is_empty(), "nothing signalled: {log:?}");
    }

    #[test]
    fn a_nonzero_exit_is_an_exit_failure_with_what_it_said() {
        let (got, log) = run(vec![CommandEvent::Stderr(line("::error::instance \"demo\" is not running")), ended(Some(3), None)], true, None, None, None);
        let f = exited(got).expect_err("exit 3 fails");
        assert_eq!(f.kind, FailureKind::Exit);
        assert_eq!((f.code, f.signal), (Some(3), None));
        assert_eq!(f.operation, "status");
        assert_eq!(f.stderr, "::error::instance \"demo\" is not running\n");
        assert_eq!(f.message, "instance \"demo\" is not running");
        assert!(log.is_empty());
    }

    #[test]
    fn a_signalled_exit_is_an_exit_failure_with_the_signal() {
        let (got, _) = run(vec![ended(None, Some(9))], true, None, None, None);
        let f = exited(got).expect_err("killed");
        assert_eq!(f.kind, FailureKind::Exit);
        assert_eq!((f.code, f.signal), (None, Some(9)));
        assert!(f.message.contains("signal 9"), "{}", f.message);
    }

    #[test]
    fn a_command_event_error_is_kept_and_a_lost_child_is_a_launch_failure() {
        let (got, _) = run(vec![CommandEvent::Error("pipe broke".into())], true, None, None, None);
        let f = exited(got).expect_err("no termination seen");
        assert_eq!(f.kind, FailureKind::Launch);
        assert!(f.detail.as_deref().unwrap_or("").contains("pipe broke"), "{:?}", f.detail);

        let (got, _) = run(vec![CommandEvent::Stdout(line("ok")), CommandEvent::Error("stderr read failed".into()), ended(Some(0), None)], true, None, None, None);
        let f = exited(got).expect_err("truncated output is not a successful command");
        assert_eq!(f.kind, FailureKind::Launch);
        assert_eq!(f.stdout, "ok\n");
        assert!(f.detail.as_deref().unwrap_or("").contains("stderr read failed"), "{:?}", f.detail);
    }

    #[test]
    fn a_timeout_terms_the_exact_pid_then_kills_and_keeps_partial_output() {
        let (got, log) = run(
            vec![CommandEvent::Stdout(line("partial")), CommandEvent::Stderr(line("waiting for the save"))],
            false,
            Some(Duration::from_millis(50)),
            None,
            None,
        );
        let f = exited(got).expect_err("timed out");
        assert_eq!(f.kind, FailureKind::Timeout);
        assert_eq!(f.timeout_ms, Some(50));
        assert_eq!((f.stdout.as_str(), f.stderr.as_str()), ("partial\n", "waiting for the save\n"));
        assert_eq!(log, vec!["term 4242".to_string(), "kill 4242".to_string()]);
    }

    #[test]
    fn a_child_that_ends_on_sigterm_is_not_killed() {
        let on_term: Box<dyn Fn(&Sender<CommandEvent>) + Send + Sync> = Box::new(|tx| {
            let _ = tx.try_send(ended(None, Some(15)));
        });
        let (got, log) = run(vec![], false, Some(Duration::from_millis(30)), None, Some(on_term));
        let f = exited(got).expect_err("timed out");
        assert_eq!(f.kind, FailureKind::Timeout);
        assert_eq!(log, vec!["term 4242".to_string()]);
    }

    #[test]
    fn an_exit_already_queued_at_the_deadline_is_not_a_timeout() {
        // Nothing arrives before the deadline is checked, but the exit is waiting in the channel.
        let (got, log) = run(vec![CommandEvent::Stdout(line("done")), ended(Some(0), None)], false, Some(Duration::from_millis(0)), None, None);
        assert_eq!(exited(got).expect("finished").stdout, "done\n");
        assert!(log.is_empty(), "{log:?}");
    }

    #[test]
    fn the_share_handshake_returns_the_running_child_once_ready() {
        let ready = |stdout: &str| stdout.contains("  token ");
        let (got, log) = run(
            vec![CommandEvent::Stdout(line("serving on 127.0.0.1:7000")), CommandEvent::Stdout(line("  token abc")), CommandEvent::Stdout(line("later"))],
            false,
            Some(Duration::from_secs(5)),
            Some(&ready),
            None,
        );
        match got.expect("ready") {
            Finished::Ready { output, child } => {
                assert_eq!(output.stdout, "serving on 127.0.0.1:7000\n  token abc\n");
                assert_eq!(child.pid, 4242);
            }
            Finished::Exited(_) => panic!("it is still serving"),
        }
        assert!(log.is_empty());
    }

    #[test]
    fn the_share_handshake_is_bounded() {
        let ready = |stdout: &str| stdout.contains("  token ");
        let (got, log) = run(vec![CommandEvent::Stdout(line("starting"))], false, Some(Duration::from_millis(40)), Some(&ready), None);
        let f = got.err().expect("timed out");
        assert_eq!(f.kind, FailureKind::Timeout);
        assert_eq!(log, vec!["term 4242".to_string(), "kill 4242".to_string()]);
    }

    #[test]
    fn tells_a_missing_helper_from_one_that_would_not_start() {
        let missing = spawn_failure("status", &tauri_plugin_shell::Error::Io(std::io::Error::from(std::io::ErrorKind::NotFound)));
        assert_eq!(missing.kind, FailureKind::Missing);
        assert!(missing.message.contains("Reinstall"), "{}", missing.message);
        assert!(missing.detail.is_some());
        let denied = spawn_failure("status", &tauri_plugin_shell::Error::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied)));
        assert_eq!(denied.kind, FailureKind::Launch);
        assert!(!denied.message.is_empty());
    }

    #[test]
    fn serializes_tagged_by_kind_with_camel_case_fields() {
        let f = SidecarFailure::timeout("status", Duration::from_secs(45), "half".into(), String::new());
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["kind"], "timeout");
        assert_eq!(v["operation"], "status");
        assert_eq!(v["timeoutMs"], 45_000);
        assert_eq!(v["stdout"], "half");
        assert!(v["code"].is_null() && v["signal"].is_null());
        assert!(v["message"].as_str().unwrap().contains("45"));
    }

    #[test]
    fn terminate_child_signals_only_this_process_s_own_child() {
        assert!(terminate_child(0).is_err());
        let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        terminate_child(child.id()).expect("our own child");
        let status = child.wait().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(15));

        // A grandchild: alive, ours to start, but not this process's child. Left alone.
        let mut parent = std::process::Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 30 & echo $!; wait"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut pid = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(parent.stdout.take().unwrap()), &mut pid).unwrap();
        let grandchild: u32 = pid.trim().parse().unwrap();
        assert!(terminate_child(grandchild).is_err());
        let alive = std::process::Command::new("/bin/kill").args(["-0", &grandchild.to_string()]).status().unwrap();
        assert!(alive.success(), "the grandchild was signalled");
        let _ = std::process::Command::new("/bin/kill").args(["-KILL", &grandchild.to_string()]).status();
        let _ = parent.kill();
        let _ = parent.wait();
    }
}
