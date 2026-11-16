use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::async_runtime::Receiver;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent, TerminatedPayload};
use tauri_plugin_shell::ShellExt;

use crate::sidecar::{terminate_child, SidecarChild};

pub const EVENT: &str = "winvm-event";
pub const FIRST_DELAY: Duration = Duration::from_secs(1);
pub const LONGEST_DELAY: Duration = Duration::from_secs(60);
pub const HEALTHY_AFTER: Duration = Duration::from_secs(30);

pub fn stream_args(cursor: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["events", "--follow", "--json"].map(String::from).into();
    if let Some(c) = cursor {
        args.push(format!("--since={c}"));
    }
    args
}

pub fn follows(args: &[String]) -> bool {
    args.first().is_some_and(|v| v == "events") && args.iter().any(|a| a == "--follow")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    next: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff { next: FIRST_DELAY }
    }
}

impl Backoff {
    pub fn after(&mut self, ran: Duration) -> Duration {
        if ran >= HEALTHY_AFTER {
            self.next = FIRST_DELAY;
        }
        let wait = self.next;
        self.next = (self.next * 2).min(LONGEST_DELAY);
        wait
    }
}

pub trait Runner {
    type Child: SidecarChild;
    fn spawn(&self, args: &[String]) -> Result<(Receiver<CommandEvent>, Self::Child), String>;
    fn emit(&self, payload: Value);
    fn terminate(&self, pid: u32) -> Result<(), String>;
    async fn sleep(&self, d: Duration);
    fn now(&self) -> Instant;
}

pub struct Stream<C> {
    stopping: AtomicBool,
    up: AtomicBool,
    restarts: AtomicU32,
    child: Mutex<Option<C>>,
    cursor: Mutex<Option<String>>,
}

impl<C> Default for Stream<C> {
    fn default() -> Self {
        Stream {
            stopping: AtomicBool::new(false),
            up: AtomicBool::new(false),
            restarts: AtomicU32::new(0),
            child: Mutex::new(None),
            cursor: Mutex::new(None),
        }
    }
}

fn cursor_of(line: &Value) -> Option<String> {
    line.get("cursor")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn ended(t: Option<&TerminatedPayload>, error: Option<&str>, wait: Duration) -> Value {
    json!({
        "type": "down",
        "code": t.and_then(|t| t.code),
        "signal": t.and_then(|t| t.signal),
        "error": error,
        "restartInMs": u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
    })
}

impl<C: SidecarChild> Stream<C> {
    pub fn is_up(&self) -> bool {
        self.up.load(Ordering::SeqCst)
    }

    pub fn restarts(&self) -> u32 {
        self.restarts.load(Ordering::SeqCst)
    }

    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    fn last_cursor(&self) -> Option<String> {
        self.cursor.lock().ok().and_then(|c| c.clone())
    }

    fn remember(&self, cursor: String) {
        if let Ok(mut c) = self.cursor.lock() {
            *c = Some(cursor);
        }
    }

    fn hold(&self, child: C) -> Option<C> {
        let Ok(mut held) = self.child.lock() else {
            return Some(child);
        };
        if self.stopping() {
            return Some(child);
        }
        *held = Some(child);
        None
    }

    fn release(&self) -> Option<C> {
        self.child.lock().ok().and_then(|mut c| c.take())
    }

    pub fn stop(&self, terminate: &dyn Fn(u32) -> Result<(), String>) -> Result<(), String> {
        self.stopping.store(true, Ordering::SeqCst);
        match self.release() {
            Some(child) => {
                let termed = terminate(child.pid());
                drop(child);
                termed
            }
            None => Ok(()),
        }
    }

    async fn follow<R: Runner<Child = C>>(
        &self,
        runner: &R,
        mut rx: Receiver<CommandEvent>,
    ) -> Option<TerminatedPayload> {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let Ok(line) = serde_json::from_slice::<Value>(&bytes) else {
                        continue;
                    };
                    if let Some(c) = cursor_of(&line) {
                        self.remember(c);
                    }
                    runner.emit(line);
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("winvm events: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(t) => return Some(t),
                _ => {}
            }
        }
        None
    }

    pub async fn supervise<R: Runner<Child = C>>(&self, runner: &R) {
        let mut backoff = Backoff::default();
        while !self.stopping() {
            let started = runner.now();
            let args = stream_args(self.last_cursor().as_deref());
            let (terminated, error) = match runner.spawn(&args) {
                Ok((rx, child)) => {
                    if let Some(late) = self.hold(child) {
                        let _ = runner.terminate(late.pid());
                        drop(late);
                        break;
                    }
                    self.up.store(true, Ordering::SeqCst);
                    let t = self.follow(runner, rx).await;
                    self.up.store(false, Ordering::SeqCst);
                    drop(self.release());
                    (t, None)
                }
                Err(e) => (None, Some(e)),
            };
            if self.stopping() {
                break;
            }
            let wait = backoff.after(runner.now().saturating_duration_since(started));
            runner.emit(ended(terminated.as_ref(), error.as_deref(), wait));
            self.restarts.fetch_add(1, Ordering::SeqCst);
            runner.sleep(wait).await;
        }
    }
}

pub type AppStream = Stream<CommandChild>;

struct AppRunner {
    app: tauri::AppHandle,
}

impl Runner for AppRunner {
    type Child = CommandChild;

    fn spawn(&self, args: &[String]) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
        self.app
            .shell()
            .sidecar("winvm")
            .map_err(|e| e.to_string())?
            .args(args)
            .spawn()
            .map_err(|e| e.to_string())
    }

    fn emit(&self, payload: Value) {
        let _ = self.app.emit_to("main", EVENT, payload);
    }

    fn terminate(&self, pid: u32) -> Result<(), String> {
        terminate_child(pid)
    }

    async fn sleep(&self, d: Duration) {
        tokio::time::sleep(d).await;
    }

    fn now(&self) -> Instant {
        Instant::now()
    }
}

pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let runner = AppRunner { app: app.clone() };
        app.state::<AppStream>().supervise(&runner).await;
    });
}

pub fn stop(app: &tauri::AppHandle) {
    if let Some(stream) = app.try_state::<AppStream>() {
        if let Err(e) = stream.stop(&terminate_child) {
            eprintln!("winvm events: {e}");
        }
    }
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects the AppHandle by value; a command cannot take a reference to it"
)]
pub fn events_state(app: tauri::AppHandle) -> Value {
    let stream = app.state::<AppStream>();
    json!({ "up": stream.is_up(), "restarts": stream.restarts() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::Arc;
    use tauri::async_runtime::{block_on, channel};

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

    impl Drop for FakeChild {
        fn drop(&mut self) {
            self.log.lock().unwrap().push(format!("drop {}", self.pid));
        }
    }

    enum Run {
        Lines(Vec<&'static str>, Duration, TerminatedPayload),
        Fails(&'static str),
        StopsTheApp,
    }

    struct Fake {
        runs: RefCell<VecDeque<Run>>,
        stream: Arc<Stream<FakeChild>>,
        log: Log,
        clock: RefCell<Instant>,
        spawned: RefCell<Vec<Vec<String>>>,
        emitted: RefCell<Vec<Value>>,
        slept: RefCell<Vec<Duration>>,
        next_pid: RefCell<u32>,
    }

    impl Fake {
        fn new(runs: Vec<Run>) -> Self {
            Fake {
                runs: RefCell::new(runs.into()),
                stream: Arc::default(),
                log: Arc::default(),
                clock: RefCell::new(Instant::now()),
                spawned: RefCell::default(),
                emitted: RefCell::default(),
                slept: RefCell::default(),
                next_pid: RefCell::new(100),
            }
        }

        fn kinds(&self) -> Vec<String> {
            self.emitted
                .borrow()
                .iter()
                .map(|v| v["type"].as_str().unwrap_or("?").to_owned())
                .collect()
        }
    }

    impl Runner for Fake {
        type Child = FakeChild;

        fn spawn(&self, args: &[String]) -> Result<(Receiver<CommandEvent>, FakeChild), String> {
            self.spawned.borrow_mut().push(args.to_vec());
            let run = self
                .runs
                .borrow_mut()
                .pop_front()
                .unwrap_or(Run::StopsTheApp);
            let pid = {
                let mut p = self.next_pid.borrow_mut();
                *p += 1;
                *p
            };
            let child = FakeChild {
                pid,
                log: self.log.clone(),
            };
            match run {
                Run::Fails(why) => Err(why.to_owned()),
                Run::StopsTheApp => {
                    let (_tx, rx) = channel(1);
                    let log = self.log.clone();
                    self.stream
                        .stop(&|pid| {
                            log.lock().unwrap().push(format!("term {pid}"));
                            Ok(())
                        })
                        .unwrap();
                    Ok((rx, child))
                }
                Run::Lines(lines, lasted, end) => {
                    let (tx, rx) = channel(lines.len() + 2);
                    for l in lines {
                        tx.try_send(CommandEvent::Stdout(l.as_bytes().to_vec()))
                            .unwrap();
                    }
                    tx.try_send(CommandEvent::Terminated(end)).unwrap();
                    *self.clock.borrow_mut() += lasted;
                    Ok((rx, child))
                }
            }
        }

        fn emit(&self, payload: Value) {
            self.emitted.borrow_mut().push(payload);
        }

        fn terminate(&self, pid: u32) -> Result<(), String> {
            self.log.lock().unwrap().push(format!("term {pid}"));
            Ok(())
        }

        async fn sleep(&self, d: Duration) {
            self.slept.borrow_mut().push(d);
            *self.clock.borrow_mut() += d;
        }

        fn now(&self) -> Instant {
            *self.clock.borrow()
        }
    }

    fn exit(code: i32) -> TerminatedPayload {
        TerminatedPayload {
            code: Some(code),
            signal: None,
        }
    }

    #[test]
    fn the_stream_is_the_events_command_following_from_its_last_cursor() {
        assert_eq!(stream_args(None), ["events", "--follow", "--json"]);
        assert_eq!(
            stream_args(Some("eyJ2IjoxfQ")),
            ["events", "--follow", "--json", "--since=eyJ2IjoxfQ"]
        );
        assert!(follows(&stream_args(None)));
        assert!(!follows(&["events".to_owned(), "--json".to_owned()]));
        assert!(!follows(&["status".to_owned(), "--follow".to_owned()]));
    }

    #[test]
    fn backs_off_doubling_to_a_minute_and_starts_over_after_a_healthy_run() {
        let mut b = Backoff::default();
        let quick = Duration::from_millis(10);
        let waits: Vec<u64> = (0..8).map(|_| b.after(quick).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 32, 60, 60]);
        assert_eq!(b.after(HEALTHY_AFTER), FIRST_DELAY);
        assert_eq!(b.after(quick), Duration::from_secs(2));
    }

    #[test]
    fn forwards_each_json_line_restarts_with_backoff_from_the_last_cursor_and_stops_when_the_app_does(
    ) {
        let fake = Fake::new(vec![
            Run::Lines(
                vec![
                    r#"{"type":"hello","instances":["a"],"cursor":"c0"}"#,
                    "not json",
                    r#"{"type":"entry","instance":"a","entry":{"kind":"qmp","event":"STOP"},"cursor":"c1"}"#,
                ],
                Duration::from_millis(50),
                exit(1),
            ),
            Run::Fails("No such file or directory"),
            Run::Lines(
                vec![r#"{"type":"hello","instances":["a"],"cursor":"c1"}"#],
                HEALTHY_AFTER,
                exit(0),
            ),
            Run::StopsTheApp,
        ]);
        let stream = fake.stream.clone();
        block_on(stream.supervise(&fake));

        let spawned = fake.spawned.borrow().clone();
        assert_eq!(spawned.len(), 4);
        assert_eq!(spawned[0], stream_args(None));
        assert_eq!(spawned[1], stream_args(Some("c1")));
        assert_eq!(spawned[2], stream_args(Some("c1")));
        assert_eq!(
            *fake.slept.borrow(),
            [
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(1)
            ]
        );
        assert_eq!(
            fake.kinds(),
            ["hello", "entry", "down", "down", "hello", "down"]
        );
        let emitted = fake.emitted.borrow();
        assert_eq!(emitted[1]["entry"]["event"], "STOP");
        assert_eq!(emitted[2]["code"], 1);
        assert_eq!(emitted[2]["restartInMs"], 1000);
        assert_eq!(emitted[3]["error"], "No such file or directory");
        assert_eq!(stream.restarts(), 3);
        assert!(!stream.is_up());
        let log = fake.log.lock().unwrap().clone();
        assert_eq!(
            log[log.len().saturating_sub(2)..],
            ["term 104".to_owned(), "drop 104".to_owned()]
        );
        assert!(!log.iter().any(|l| l.starts_with("kill")), "{log:?}");
    }

    #[test]
    fn stopping_terms_the_running_child_by_its_own_pid_while_it_is_still_a_child_then_closes_its_stdin(
    ) {
        let stream: Stream<FakeChild> = Stream::default();
        let log: Log = Arc::default();
        assert!(stream
            .hold(FakeChild {
                pid: 77,
                log: log.clone(),
            })
            .is_none());
        let seen = log.clone();
        stream
            .stop(&|pid| {
                seen.lock().unwrap().push(format!("term {pid}"));
                Ok(())
            })
            .unwrap();
        assert_eq!(*log.lock().unwrap(), ["term 77", "drop 77"]);
        assert!(stream.stopping());
        assert!(stream
            .hold(FakeChild {
                pid: 78,
                log: log.clone(),
            })
            .is_some());
        stream.stop(&|_| Err("never".into())).unwrap();
    }

    #[test]
    fn starts_no_stream_once_the_app_has_stopped() {
        let fake = Fake::new(vec![Run::Lines(
            vec![r#"{"type":"hello","instances":[],"cursor":"c0"}"#],
            Duration::from_millis(5),
            TerminatedPayload {
                code: None,
                signal: Some(15),
            },
        )]);
        fake.stream.stop(&|_| Ok(())).unwrap();
        let stream = fake.stream.clone();
        block_on(stream.supervise(&fake));
        assert!(fake.spawned.borrow().is_empty());
        assert!(fake.slept.borrow().is_empty());
    }
}
