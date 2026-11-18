use crate::sidecar::{self, Output, SidecarFailure};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseState {
    #[default]
    Idle,
    Requested,
    Running,
    Authorized,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    Emit,
    Coalesced,
    Allow,
}

impl Request {
    pub fn keeps_app_open(self) -> bool {
        self != Request::Allow
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quit {
    User,
    SessionEnd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Terminate {
    Now,
    Cancel { emit: bool },
    Later { id: u64, check: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settled {
    Stale,
    Allow,
    Ask,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Finish {
    Exit,
    Reply,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
    pub machine: String,
    pub verb: String,
    pub op: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub machine: String,
    pub verb: String,
    pub op: Option<String>,
    pub code: i32,
    pub output: String,
}

impl Outcome {
    fn of(command: Command, ran: &Result<Output, Box<SidecarFailure>>) -> Self {
        let (code, output) = match ran {
            Ok(out) => (out.code, shown(&out.stdout, &out.stderr)),
            Err(failure) if failure.code.is_some() => (
                failure.code.unwrap_or(-1),
                shown(&failure.stdout, &failure.stderr),
            ),
            Err(failure) => (-1, failure.message.clone()),
        };
        Outcome {
            machine: command.machine,
            verb: command.verb,
            op: command.op,
            code,
            output,
        }
    }
}

fn shown(stdout: &str, stderr: &str) -> String {
    [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Session {
    Waiting { deadline: u64 },
    Missed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub state: CloseState,
    pub machine: Option<String>,
    pub command: Option<Command>,
    pub last: Option<Outcome>,
    pub resolved: Vec<String>,
    pub session: Option<Session>,
    pub orphans: Vec<Command>,
}

#[derive(Default)]
struct Inner {
    now: Snapshot,
    owed: Option<u64>,
    sessions: u64,
    deadline: u64,
    journal: Option<PathBuf>,
    orphans: Vec<Command>,
    written: Vec<String>,
}

impl Inner {
    fn request(&mut self) -> Request {
        match self.now.state {
            CloseState::Idle => {
                self.now = Snapshot {
                    state: CloseState::Requested,
                    session: self.owed.map(|_| Session::Waiting {
                        deadline: self.deadline,
                    }),
                    ..Snapshot::default()
                };
                Request::Emit
            }
            CloseState::Requested | CloseState::Running => Request::Coalesced,
            CloseState::Authorized => Request::Allow,
        }
    }

    fn not_running_a_command(&self, what: &str) -> Result<(), String> {
        match &self.now.command {
            Some(c) => Err(format!(
                "close {what} arrived while winvm {} on {} was still running for the close",
                c.verb, c.machine
            )),
            None => Ok(()),
        }
    }

    fn running(&self, what: &str) -> Result<(), String> {
        match self.now.state {
            CloseState::Running => Ok(()),
            other => Err(out_of_order(what, other)),
        }
    }

    fn journal(&mut self, command: &Command) {
        let (Some(path), Some(op)) = (&self.journal, &command.op) else {
            return;
        };
        let mut notes = journaled(path);
        notes.push(command.clone());
        match rewrite(path, &notes) {
            Ok(()) => self.written.push(op.clone()),
            Err(e) => note(&format!(
                "winvm: couldn't note the close's winvm {} on {} for a later window: {e}",
                command.verb, command.machine
            )),
        }
    }

    fn unjournal(&mut self) {
        let written = std::mem::take(&mut self.written);
        if let Some(path) = &self.journal {
            let notes = journaled(path);
            let kept: Vec<Command> = notes
                .iter()
                .filter(|c| !c.op.as_ref().is_some_and(|op| written.contains(op)))
                .cloned()
                .collect();
            if kept.len() != notes.len() {
                let _ = rewrite(path, &kept);
            }
        }
    }

    fn defer(&mut self, deadline: u64, check: bool) -> Terminate {
        self.sessions += 1;
        let id = self.sessions;
        self.owed = Some(id);
        self.deadline = deadline;
        self.now.session = Some(Session::Waiting { deadline });
        Terminate::Later { id, check }
    }

    fn terminate(&mut self, quit: Quit, has_window: bool, deadline: u64) -> Terminate {
        if self.now.state == CloseState::Authorized {
            return Terminate::Now;
        }
        if self.owed.is_some() {
            return Terminate::Cancel { emit: false };
        }
        if !has_window {
            self.now.state = CloseState::Authorized;
            return Terminate::Now;
        }
        match (quit, self.now.state) {
            (Quit::User, _) => Terminate::Cancel {
                emit: self.request() == Request::Emit,
            },
            (Quit::SessionEnd, CloseState::Idle) => {
                let deferred = self.defer(deadline, true);
                self.now.session = None;
                deferred
            }
            (Quit::SessionEnd, _) => self.defer(deadline, false),
        }
    }
}

#[derive(Default)]
pub struct CloseCoordinator {
    inner: Mutex<Inner>,
    changed: Condvar,
}

impl CloseCoordinator {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn change<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        let mut inner = self.lock();
        let out = f(&mut inner);
        drop(inner);
        self.changed.notify_all();
        out
    }

    #[cfg(test)]
    pub fn state(&self) -> CloseState {
        self.lock().now.state
    }

    pub fn snapshot(&self) -> Snapshot {
        let inner = self.lock();
        Snapshot {
            orphans: inner.orphans.clone(),
            ..inner.now.clone()
        }
    }

    pub fn open_journal(&self, path: PathBuf) {
        self.change(|i| {
            i.orphans = journaled(&path);
            i.journal = Some(path);
        });
    }

    pub fn forget_orphan(&self, op: &str) {
        self.change(|i| {
            let before = i.orphans.len();
            i.orphans.retain(|o| o.op.as_deref() != Some(op));
            if i.orphans.len() == before {
                return;
            }
            if let Some(path) = &i.journal {
                let notes = journaled(path);
                let kept: Vec<Command> = notes
                    .iter()
                    .filter(|c| c.op.as_deref() != Some(op))
                    .cloned()
                    .collect();
                if kept.len() != notes.len() {
                    let _ = rewrite(path, &kept);
                }
            }
        });
    }

    pub fn wait_for_command(&self) -> Snapshot {
        let inner = self
            .changed
            .wait_while(self.lock(), |i| i.now.command.is_some())
            .unwrap_or_else(PoisonError::into_inner);
        Snapshot {
            orphans: inner.orphans.clone(),
            ..inner.now.clone()
        }
    }

    pub fn request(&self) -> Request {
        self.change(Inner::request)
    }

    pub fn authorize_bypass(&self) {
        self.change(|i| i.now.state = CloseState::Authorized);
    }

    pub fn start(&self) -> Result<(), String> {
        self.change(|i| match i.now.state {
            CloseState::Requested => {
                i.now.state = CloseState::Running;
                Ok(())
            }
            other => Err(out_of_order("start", other)),
        })
    }

    pub fn cancel(&self) -> Result<Option<bool>, String> {
        self.change(|i| match i.now.state {
            CloseState::Requested | CloseState::Running => {
                i.not_running_a_command("cancel")?;
                i.unjournal();
                i.now = Snapshot::default();
                Ok(i.owed.take().map(|_| false))
            }
            other => Err(out_of_order("cancel", other)),
        })
    }

    pub fn complete(&self) -> Result<Finish, String> {
        self.change(|i| {
            i.running("complete")?;
            i.not_running_a_command("complete")?;
            i.unjournal();
            i.now.state = CloseState::Authorized;
            i.now.session = None;
            Ok(if i.owed.take().is_some() {
                Finish::Reply
            } else {
                Finish::Exit
            })
        })
    }

    pub fn at(&self, machine: &str) -> Result<(), String> {
        self.change(|i| {
            i.running("progress")?;
            i.now.machine = Some(machine.to_owned());
            Ok(())
        })
    }

    pub fn resolved(&self, machine: &str) -> Result<(), String> {
        self.change(|i| {
            i.running("progress")?;
            if !i.now.resolved.iter().any(|m| m == machine) {
                i.now.resolved.push(machine.to_owned());
            }
            if i.now.machine.as_deref() == Some(machine) {
                i.now.machine = None;
            }
            if i.now.last.as_ref().is_some_and(|l| l.machine == machine) {
                i.unjournal();
            }
            Ok(())
        })
    }

    pub fn begin(&self, args: &[String]) -> Result<Command, String> {
        let command = close_command(args)?;
        self.change(|i| {
            i.running("command")?;
            i.not_running_a_command("command")?;
            i.now.machine = Some(command.machine.clone());
            i.now.command = Some(command.clone());
            i.journal(&command);
            Ok(command)
        })
    }

    pub fn run_command(&self, args: &[String]) -> Result<CommandRun<'_>, String> {
        let command = self.begin(args)?;
        Ok(CommandRun {
            close: self,
            command: Some(command),
        })
    }

    pub fn end(&self, outcome: Outcome) {
        self.change(|i| {
            i.now.command = None;
            i.now.last = Some(outcome);
        });
    }

    pub fn on_terminate(&self, quit: Quit, has_window: bool, deadline: u64) -> Terminate {
        self.change(|i| i.terminate(quit, has_window, deadline))
    }

    pub fn settle_session(&self, id: u64, needs: bool) -> Settled {
        self.change(|i| {
            if i.owed != Some(id) {
                return Settled::Stale;
            }
            match i.now.state {
                CloseState::Requested | CloseState::Running => Settled::Stale,
                CloseState::Authorized => {
                    i.owed = None;
                    Settled::Allow
                }
                CloseState::Idle if needs => {
                    let deadline = i.deadline;
                    i.request();
                    i.now.session = Some(Session::Waiting { deadline });
                    Settled::Ask
                }
                CloseState::Idle => {
                    i.owed = None;
                    i.now.state = CloseState::Authorized;
                    Settled::Allow
                }
            }
        })
    }

    pub fn expire(&self, id: u64) -> bool {
        self.change(|i| {
            if i.owed != Some(id) {
                return false;
            }
            i.owed = None;
            i.now.session = match i.now.state {
                CloseState::Requested | CloseState::Running => Some(Session::Missed),
                CloseState::Idle | CloseState::Authorized => None,
            };
            true
        })
    }

    pub fn wait_to_restart(&self) -> bool {
        let mut inner = self
            .changed
            .wait_while(self.lock(), |i| {
                i.owed.is_some()
                    || matches!(i.now.state, CloseState::Requested | CloseState::Running)
            })
            .unwrap_or_else(PoisonError::into_inner);
        let restart = inner.now.state != CloseState::Authorized;
        inner.now.state = CloseState::Authorized;
        drop(inner);
        self.changed.notify_all();
        restart
    }
}

pub struct CommandRun<'a> {
    close: &'a CloseCoordinator,
    command: Option<Command>,
}

impl CommandRun<'_> {
    pub fn finish(mut self, ran: &Result<Output, Box<SidecarFailure>>) {
        if let Some(command) = self.command.take() {
            self.close.end(Outcome::of(command, ran));
        }
    }
}

impl Drop for CommandRun<'_> {
    fn drop(&mut self) {
        if let Some(command) = self.command.take() {
            let output = format!(
                "winvm {} on {} stopped without saying how it ended",
                command.verb, command.machine
            );
            self.close.end(Outcome {
                machine: command.machine,
                verb: command.verb,
                op: command.op,
                code: -1,
                output,
            });
        }
    }
}

fn out_of_order(what: &str, state: CloseState) -> String {
    format!("close {what} arrived while the close was {state:?}")
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Journaled {
    Many(Vec<Command>),
    One(Command),
}

fn journaled(path: &std::path::Path) -> Vec<Command> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let notes = match serde_json::from_str::<Journaled>(&text) {
        Ok(Journaled::Many(notes)) => notes,
        Ok(Journaled::One(note)) => vec![note],
        Err(_) => Vec::new(),
    };
    notes
        .into_iter()
        .filter(|c| c.op.as_deref().is_some_and(is_op_id))
        .collect()
}

fn rewrite(path: &std::path::Path, notes: &[Command]) -> std::io::Result<()> {
    if notes.is_empty() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string(notes).map_err(std::io::Error::other)?;
    std::fs::write(path, text)
}

pub fn is_op_id(id: &str) -> bool {
    let mut chars = id.chars();
    (8..=64).contains(&id.len())
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn close_command(args: &[String]) -> Result<Command, String> {
    let (verb, flag, machine, op) = match args {
        [verb, flag, machine] => (verb, flag, machine, None),
        [verb, flag, machine, op_flag, id] if op_flag == "--op-id" && is_op_id(id) => {
            (verb, flag, machine, Some(id.clone()))
        }
        _ => (&String::new(), &String::new(), &String::new(), None),
    };
    if (verb == "stow" || verb == "stop") && flag == "-i" && !machine.is_empty() {
        Ok(Command {
            machine: machine.clone(),
            verb: verb.clone(),
            op,
        })
    } else {
        Err(format!(
            "the close only runs winvm stow or stop on one machine, not {args:?}"
        ))
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Listed {
    All { instances: Vec<Listing> },
    One(Listing),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listing {
    state: String,
    #[serde(default)]
    close_policy: Option<String>,
    #[serde(default)]
    operation: Option<serde_json::Value>,
}

impl Listing {
    fn needs_resolving(&self) -> bool {
        let live = matches!(self.state.as_str(), "running" | "paused" | "asleep");
        live && (self.operation.is_some() || self.close_policy.as_deref() != Some("leave"))
    }
}

pub fn needs_resolving(status: &str) -> bool {
    match serde_json::from_str::<Listed>(status) {
        Ok(Listed::All { instances }) => instances.iter().any(Listing::needs_resolving),
        Ok(Listed::One(one)) => one.needs_resolving(),
        Err(_) => true,
    }
}

pub const MAIN: &str = "main";
pub const JOURNAL: &str = "close-op.json";
pub const REQUESTED_EVENT: &str = "viewer-close-requested";
pub const SESSION_EVENT: &str = "viewer-close-session";
pub const QUIT_ID: &str = "quit";
pub const SESSION_END_BUDGET: Duration = Duration::from_secs(40);
const SESSION_STATUS_TIMEOUT: Duration = Duration::from_secs(3);

pub fn closes_viewer(label: &str) -> bool {
    label == MAIN
}

pub fn is_quit(menu_id: &str) -> bool {
    menu_id == QUIT_ID
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseRoute {
    TerminalTab,
    Viewer,
    Window,
    Nothing,
}

pub fn route_close(focused: Option<&str>, terminal: &str) -> CloseRoute {
    match focused {
        Some(label) if label == terminal => CloseRoute::TerminalTab,
        Some(label) if closes_viewer(label) => CloseRoute::Viewer,
        Some(_) => CloseRoute::Window,
        None => CloseRoute::Nothing,
    }
}

pub fn caller_may_answer(label: &str) -> Result<(), String> {
    if closes_viewer(label) {
        Ok(())
    } else {
        Err(format!("only the main window answers a close, not {label}"))
    }
}

pub fn note(line: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{line}");
}

fn bring_forward<R: tauri::Runtime>(main: &tauri::WebviewWindow<R>) {
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
}

fn ask_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    match app.emit_to(MAIN, REQUESTED_EVENT, ()) {
        Ok(()) => true,
        Err(e) => {
            note(&format!("winvm: the close request did not reach the main window, so the close was called off: {e}"));
            false
        }
    }
}

fn tell_session<R: tauri::Runtime>(app: &tauri::AppHandle<R>, close: &CloseCoordinator) {
    if let Err(e) = app.emit_to(MAIN, SESSION_EVENT, close.snapshot().session) {
        note(&format!(
            "winvm: the logout deadline did not reach the main window: {e}"
        ));
    }
}

fn answer_termination<R: tauri::Runtime>(app: &tauri::AppHandle<R>, terminate: bool) {
    if let Err(e) = app.run_on_main_thread(move || crate::terminate::reply(terminate)) {
        note(&format!(
            "winvm: couldn't answer macOS's request to quit: {e}"
        ));
    }
}

pub fn request<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let close = app.state::<CloseCoordinator>();
    let Some(main) = app.get_webview_window(MAIN) else {
        close.authorize_bypass();
        return false;
    };
    let request = close.request();
    if request == Request::Emit {
        bring_forward(&main);
        if !ask_window(app) {
            let _ = close.cancel();
        }
    }
    request.keeps_app_open()
}

fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

async fn settle_session(app: tauri::AppHandle, id: u64) {
    let args = ["status", "--json"].map(String::from);
    let read = sidecar::run_sidecar(&app, &args, Some(SESSION_STATUS_TIMEOUT)).await;
    let close = app.state::<CloseCoordinator>();
    match close.settle_session(id, needs_from(&read)) {
        Settled::Stale => {}
        Settled::Allow => answer_termination(&app, true),
        Settled::Ask => {
            if let Some(main) = app.get_webview_window(MAIN) {
                bring_forward(&main);
            }
            if ask_window(&app) {
                tell_session(&app, &close);
            } else if let Ok(Some(terminate)) = close.cancel() {
                answer_termination(&app, terminate);
            }
        }
    }
}

fn needs_from(read: &Result<Output, Box<SidecarFailure>>) -> bool {
    match read {
        Ok(out) => needs_resolving(&out.stdout),
        Err(failure) if failure.code.is_some() => needs_resolving(&failure.stdout),
        Err(_) => true,
    }
}

fn expire_at(app: &tauri::AppHandle, id: u64, deadline: SystemTime) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let left = deadline
            .duration_since(SystemTime::now())
            .unwrap_or_default();
        tokio::time::sleep(left).await;
        let close = app.state::<CloseCoordinator>();
        if close.expire(id) {
            answer_termination(&app, false);
            tell_session(&app, &close);
        }
    });
}

pub fn should_terminate(app: &tauri::AppHandle, quit: Quit) -> Terminate {
    let close = app.state::<CloseCoordinator>();
    let main = app.get_webview_window(MAIN);
    let deadline = SystemTime::now() + SESSION_END_BUDGET;
    let decided = close.on_terminate(quit, main.is_some(), epoch_ms(deadline));
    note(&format!(
        "winvm: macOS asked winvm to quit ({quit:?}); answered {decided:?}"
    ));
    match decided {
        Terminate::Cancel { emit: true } => {
            if let Some(main) = &main {
                bring_forward(main);
            }
            if !ask_window(app) {
                let _ = close.cancel();
            }
        }
        Terminate::Later { id, check } => {
            expire_at(app, id, deadline);
            if check {
                tauri::async_runtime::spawn(settle_session(app.clone(), id));
            } else {
                tell_session(app, &close);
            }
        }
        Terminate::Now | Terminate::Cancel { emit: false } => {}
    }
    decided
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects these extractors by value; a command cannot take a reference to them"
)]
pub fn close_state(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
) -> Result<Snapshot, String> {
    caller_may_answer(window.label())?;
    Ok(close.snapshot())
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects these extractors by value; a command cannot take a reference to them"
)]
pub fn close_start(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    close.start()
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects these extractors by value; a command cannot take a reference to them"
)]
pub fn close_at(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
    machine: String,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    close.at(&machine)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects these extractors by value; a command cannot take a reference to them"
)]
pub fn close_resolved(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
    machine: String,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    close.resolved(&machine)
}

#[tauri::command]
pub async fn close_wait(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Snapshot, String> {
    caller_may_answer(window.label())?;
    tauri::async_runtime::spawn_blocking(move || app.state::<CloseCoordinator>().wait_for_command())
        .await
        .map_err(|e| format!("couldn't wait for the close's command: {e}"))
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects these extractors by value; a command cannot take a reference to them"
)]
pub fn close_forget(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
    op: String,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    close.forget_orphan(&op);
    Ok(())
}

#[tauri::command]
pub async fn close_run(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    args: Vec<String>,
) -> Result<Output, Box<SidecarFailure>> {
    let operation = sidecar::operation_of(&args);
    let refuse = |why: String| Box::new(SidecarFailure::rejected(&operation, why));
    caller_may_answer(window.label()).map_err(refuse)?;
    let close = app.state::<CloseCoordinator>();
    let running = close.run_command(&args).map_err(refuse)?;
    let ran = sidecar::run_sidecar(&app, &args, None).await;
    running.finish(&ran);
    ran
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects these extractors by value; a command cannot take a reference to them"
)]
pub fn close_cancel(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    close: tauri::State<CloseCoordinator>,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    if let Some(terminate) = close.cancel()? {
        answer_termination(&app, terminate);
    }
    Ok(())
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects these extractors by value; a command cannot take a reference to them"
)]
pub fn close_complete(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    close: tauri::State<CloseCoordinator>,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    match close.complete()? {
        Finish::Exit => app.exit(0),
        Finish::Reply => answer_termination(&app, true),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_emits_and_duplicates_coalesce() {
        let close = CloseCoordinator::default();
        assert_eq!(close.request(), Request::Emit);
        assert_eq!(close.request(), Request::Coalesced);
        assert_eq!(close.request(), Request::Coalesced);
        assert_eq!(close.state(), CloseState::Requested);
    }

    #[test]
    fn acknowledging_runs_and_requests_during_the_flow_coalesce() {
        let close = CloseCoordinator::default();
        close.request();
        assert_eq!(close.start(), Ok(()));
        assert_eq!(close.state(), CloseState::Running);
        assert_eq!(close.request(), Request::Coalesced);
    }

    #[test]
    fn cancelling_returns_to_idle_and_the_next_request_emits_again() {
        let close = CloseCoordinator::default();
        close.request();
        close.start().unwrap();
        assert_eq!(close.cancel(), Ok(None));
        assert_eq!(close.state(), CloseState::Idle);
        assert_eq!(close.request(), Request::Emit);
        assert_eq!(close.cancel(), Ok(None));
        assert_eq!(close.state(), CloseState::Idle);
    }

    #[test]
    fn out_of_order_acknowledgements_are_errors_that_change_nothing() {
        let close = CloseCoordinator::default();
        assert!(close.start().is_err());
        assert!(close.cancel().is_err());
        assert!(close.complete().is_err());
        assert_eq!(close.state(), CloseState::Idle);

        close.request();
        assert!(close.complete().is_err(), "complete before start");
        close.start().unwrap();
        assert!(close.start().is_err(), "second start");
        assert_eq!(close.state(), CloseState::Running);
    }

    #[test]
    fn completing_authorizes_and_later_acknowledgements_are_errors() {
        let close = CloseCoordinator::default();
        close.request();
        close.start().unwrap();
        assert_eq!(close.complete(), Ok(Finish::Exit));
        assert_eq!(close.state(), CloseState::Authorized);
        assert!(close.start().is_err());
        assert!(close.cancel().is_err());
        assert!(close.complete().is_err());
        assert_eq!(close.state(), CloseState::Authorized);
    }

    #[test]
    fn authorized_permits_every_callback_of_the_terminating_sequence() {
        let close = CloseCoordinator::default();
        close.request();
        close.start().unwrap();
        close.complete().unwrap();
        for _ in 0..5 {
            assert_eq!(close.request(), Request::Allow);
            assert!(!close.request().keeps_app_open());
            assert_eq!(close.state(), CloseState::Authorized);
        }
    }

    #[test]
    fn unapproved_exit_is_kept_open_and_asks_the_window_once() {
        let close = CloseCoordinator::default();
        assert!(close.request().keeps_app_open());
        assert_eq!(close.state(), CloseState::Requested);
        assert!(close.request().keeps_app_open());
        assert_eq!(close.state(), CloseState::Requested);
    }

    #[test]
    fn with_no_window_to_ask_the_bypass_authorizes_from_any_state() {
        for before in [CloseState::Idle, CloseState::Requested, CloseState::Running] {
            let close = CloseCoordinator::default();
            if before != CloseState::Idle {
                close.request();
            }
            if before == CloseState::Running {
                close.start().unwrap();
            }
            close.authorize_bypass();
            assert_eq!(close.state(), CloseState::Authorized, "from {before:?}");
            assert_eq!(close.request(), Request::Allow);
            assert_eq!(close.request(), Request::Allow);
        }
    }

    fn running() -> CloseCoordinator {
        let close = CloseCoordinator::default();
        close.request();
        close.start().unwrap();
        close
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn outcome(machine: &str, verb: &str, code: i32) -> Outcome {
        Outcome {
            machine: machine.into(),
            verb: verb.into(),
            op: None,
            code,
            output: String::new(),
        }
    }

    const DEADLINE: u64 = 1_800_000_040_000;

    #[test]
    fn a_user_quit_starts_the_close_like_cmd_q_and_cancels_the_termination() {
        let close = CloseCoordinator::default();
        assert_eq!(
            close.on_terminate(Quit::User, true, DEADLINE),
            Terminate::Cancel { emit: true }
        );
        assert_eq!(close.state(), CloseState::Requested);
        assert_eq!(
            close.on_terminate(Quit::User, true, DEADLINE),
            Terminate::Cancel { emit: false }
        );
        close.start().unwrap();
        assert_eq!(
            close.on_terminate(Quit::User, true, DEADLINE),
            Terminate::Cancel { emit: false }
        );
        assert_eq!(close.state(), CloseState::Running);
        assert_eq!(close.snapshot().session, None);
    }

    #[test]
    fn an_authorized_close_terminates_now_for_every_kind_of_quit() {
        for quit in [Quit::User, Quit::SessionEnd] {
            let close = running();
            close.complete().unwrap();
            assert_eq!(close.on_terminate(quit, true, DEADLINE), Terminate::Now);
            assert_eq!(close.state(), CloseState::Authorized);
        }
    }

    #[test]
    fn with_no_main_window_any_quit_terminates_now() {
        for quit in [Quit::User, Quit::SessionEnd] {
            let close = CloseCoordinator::default();
            assert_eq!(close.on_terminate(quit, false, DEADLINE), Terminate::Now);
            assert_eq!(close.state(), CloseState::Authorized);
        }
    }

    fn checking(close: &CloseCoordinator) -> u64 {
        let Terminate::Later { id, check: true } =
            close.on_terminate(Quit::SessionEnd, true, DEADLINE)
        else {
            panic!("a session end with no close under way defers and reads the machines");
        };
        id
    }

    #[test]
    fn a_session_end_defers_at_once_and_reads_the_machines_afterwards() {
        let close = CloseCoordinator::default();
        checking(&close);
        assert_eq!(close.state(), CloseState::Idle);
        assert_eq!(close.snapshot().session, None);
    }

    #[test]
    fn a_session_end_with_nothing_to_resolve_lets_macos_go_on() {
        let close = CloseCoordinator::default();
        let id = checking(&close);
        assert_eq!(close.settle_session(id, false), Settled::Allow);
        assert_eq!(close.state(), CloseState::Authorized);
        assert!(!close.expire(id), "answered once");
        assert_eq!(close.request(), Request::Allow);
    }

    #[test]
    fn a_session_end_with_machines_to_resolve_requests_the_close_with_a_deadline() {
        let close = CloseCoordinator::default();
        let id = checking(&close);
        assert_eq!(close.settle_session(id, true), Settled::Ask);
        assert_eq!(close.state(), CloseState::Requested);
        assert_eq!(
            close.snapshot().session,
            Some(Session::Waiting { deadline: DEADLINE })
        );
        assert_eq!(close.request(), Request::Coalesced);
        assert_eq!(close.settle_session(id, true), Settled::Stale);
        close.start().unwrap();
        assert_eq!(close.complete(), Ok(Finish::Reply));
    }

    #[test]
    fn a_close_requested_while_the_machines_are_read_carries_the_deadline_and_answers_macos() {
        let close = CloseCoordinator::default();
        let id = checking(&close);
        assert_eq!(close.request(), Request::Emit);
        assert_eq!(
            close.snapshot().session,
            Some(Session::Waiting { deadline: DEADLINE })
        );
        assert_eq!(close.settle_session(id, false), Settled::Stale);
        assert_eq!(close.state(), CloseState::Requested);
        close.start().unwrap();
        assert_eq!(close.complete(), Ok(Finish::Reply));
    }

    #[test]
    fn a_read_that_ends_after_the_deadline_changes_nothing() {
        let close = CloseCoordinator::default();
        let id = checking(&close);
        assert!(close.expire(id));
        assert_eq!(close.state(), CloseState::Idle);
        assert_eq!(close.snapshot().session, None);
        assert_eq!(close.settle_session(id, false), Settled::Stale);
        assert_eq!(close.state(), CloseState::Idle);
        assert_eq!(close.request(), Request::Emit);
    }

    #[test]
    fn any_quit_while_the_machines_are_read_is_refused() {
        let close = CloseCoordinator::default();
        checking(&close);
        for quit in [Quit::User, Quit::SessionEnd] {
            assert_eq!(
                close.on_terminate(quit, true, DEADLINE),
                Terminate::Cancel { emit: false }
            );
        }
    }

    #[test]
    fn the_updater_waits_out_a_logout_still_reading_the_machines() {
        let close = std::sync::Arc::new(CloseCoordinator::default());
        let id = checking(&close);
        let restart = updater(&close);
        assert!(restart.recv_timeout(HELD).is_err(), "restarted mid-logout");
        assert_eq!(close.settle_session(id, false), Settled::Allow);
        assert_eq!(restart.recv_timeout(LONG), Ok(false));
    }

    #[test]
    fn a_session_end_during_a_close_joins_it_without_reading_the_machines_or_asking_again() {
        let requested = CloseCoordinator::default();
        requested.request();
        let running = running();
        for close in [requested, running] {
            let before = close.state();
            let Terminate::Later { check: false, .. } =
                close.on_terminate(Quit::SessionEnd, true, DEADLINE)
            else {
                panic!("a session end joins the close under way without reading the machines");
            };
            assert_eq!(close.state(), before);
            assert_eq!(
                close.snapshot().session,
                Some(Session::Waiting { deadline: DEADLINE })
            );
        }
    }

    #[test]
    fn a_second_quit_while_a_reply_is_owed_is_refused() {
        let close = running();
        close.on_terminate(Quit::SessionEnd, true, DEADLINE);
        for quit in [Quit::User, Quit::SessionEnd] {
            assert_eq!(
                close.on_terminate(quit, true, DEADLINE),
                Terminate::Cancel { emit: false }
            );
        }
        assert_eq!(close.state(), CloseState::Running);
    }

    #[test]
    fn completing_a_session_end_replies_yes_instead_of_exiting() {
        let close = running();
        close.on_terminate(Quit::SessionEnd, true, DEADLINE);
        assert_eq!(close.complete(), Ok(Finish::Reply));
        assert_eq!(close.state(), CloseState::Authorized);
        assert_eq!(close.snapshot().session, None);

        let ordinary = running();
        assert_eq!(ordinary.complete(), Ok(Finish::Exit));
    }

    #[test]
    fn cancelling_a_session_end_replies_no_and_an_ordinary_cancel_replies_nothing() {
        let close = running();
        close.on_terminate(Quit::SessionEnd, true, DEADLINE);
        assert_eq!(close.cancel(), Ok(Some(false)));
        assert_eq!(close.state(), CloseState::Idle);
        assert_eq!(close.snapshot().session, None);

        let ordinary = running();
        assert_eq!(ordinary.cancel(), Ok(None));
    }

    #[test]
    fn an_expired_session_end_replies_no_once_and_the_close_goes_on() {
        let close = running();
        let Terminate::Later { id, .. } = close.on_terminate(Quit::SessionEnd, true, DEADLINE)
        else {
            panic!("deferred");
        };
        assert!(close.expire(id));
        assert!(!close.expire(id), "replied once");
        assert_eq!(close.state(), CloseState::Running);
        assert_eq!(close.snapshot().session, Some(Session::Missed));
        assert_eq!(close.complete(), Ok(Finish::Exit));
    }

    #[test]
    fn an_expiry_for_a_session_end_already_answered_changes_nothing() {
        let close = running();
        let Terminate::Later { id, .. } = close.on_terminate(Quit::SessionEnd, true, DEADLINE)
        else {
            panic!("deferred");
        };
        close.cancel().unwrap();
        assert!(!close.expire(id));
        assert_eq!(close.state(), CloseState::Idle);
        assert_eq!(close.snapshot().session, None);

        close.request();
        close.start().unwrap();
        let Terminate::Later { id: next, .. } =
            close.on_terminate(Quit::SessionEnd, true, DEADLINE)
        else {
            panic!("deferred");
        };
        assert_ne!(id, next);
        assert!(!close.expire(id), "an earlier session end's timer");
        assert!(close.expire(next));
    }

    #[test]
    fn a_close_owned_command_is_kept_until_it_ends_with_its_outcome() {
        let close = running();
        assert_eq!(
            close.begin(&args(&["stow", "-i", "a"])),
            Ok(Command {
                machine: "a".into(),
                verb: "stow".into(),
                op: None,
            })
        );
        let during = close.snapshot();
        assert_eq!(during.machine.as_deref(), Some("a"));
        assert_eq!(
            during.command,
            Some(Command {
                machine: "a".into(),
                verb: "stow".into(),
                op: None,
            })
        );
        assert!(
            close.begin(&args(&["stop", "-i", "b"])).is_err(),
            "one at a time"
        );
        close.end(outcome("a", "stow", 0));
        let after = close.snapshot();
        assert_eq!(after.command, None);
        assert_eq!(after.last, Some(outcome("a", "stow", 0)));
        assert_eq!(close.state(), CloseState::Running);
    }

    #[test]
    fn a_close_owned_command_whose_task_ends_without_an_outcome_still_ends() {
        let close = running();
        let run = close.run_command(&args(&["stow", "-i", "a"])).unwrap();
        assert!(close.snapshot().command.is_some());
        drop(run);
        let after = close.snapshot();
        assert_eq!(after.command, None);
        let last = after.last.unwrap();
        assert_eq!((last.machine.as_str(), last.verb.as_str()), ("a", "stow"));
        assert_ne!(last.code, 0);
        assert_eq!(
            last.output,
            "winvm stow on a stopped without saying how it ended"
        );
        assert_eq!(close.cancel(), Ok(None));
    }

    #[test]
    fn a_close_owned_command_that_finishes_records_how_it_ended_once() {
        let close = running();
        let run = close.run_command(&args(&["stop", "-i", "a"])).unwrap();
        run.finish(&Ok(Output {
            code: 0,
            stdout: "stopped\n".into(),
            stderr: String::new(),
        }));
        assert_eq!(
            close.snapshot().last,
            Some(Outcome {
                machine: "a".into(),
                verb: "stop".into(),
                op: None,
                code: 0,
                output: "stopped".into(),
            })
        );
        assert!(close.run_command(&args(&["kill", "-i", "a"])).is_err());
    }

    #[test]
    fn nothing_ends_the_close_while_its_own_command_runs() {
        let close = running();
        close.on_terminate(Quit::SessionEnd, true, DEADLINE);
        close.begin(&args(&["stop", "-i", "a"])).unwrap();
        assert!(close.cancel().is_err());
        assert!(close.complete().is_err());
        assert_eq!(close.state(), CloseState::Running);
        close.end(outcome("a", "stop", 1));
        assert_eq!(close.cancel(), Ok(Some(false)));
    }

    #[test]
    fn only_a_stow_or_stop_of_one_machine_runs_as_the_close_and_only_while_it_runs() {
        let idle = CloseCoordinator::default();
        assert!(idle.begin(&args(&["stow", "-i", "a"])).is_err());
        idle.request();
        assert!(
            idle.begin(&args(&["stow", "-i", "a"])).is_err(),
            "requested"
        );

        let close = running();
        for bad in [
            &["kill", "-i", "a"][..],
            &["stow"],
            &["stow", "-i"],
            &["stow", "-i", ""],
            &["stow", "a"],
            &["stop", "-i", "a", "--force"],
            &[],
        ] {
            assert!(close.begin(&args(bad)).is_err(), "{bad:?}");
        }
        assert_eq!(close.snapshot().command, None);
    }

    const OP: &str = "0b9c2f1e-7d3a-4e5b-9c8d-112233445566";

    fn journal_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "winvm-close-{name}-{}-{}",
            std::process::id(),
            epoch_ms(SystemTime::now())
        ))
    }

    #[test]
    fn a_close_command_carries_the_op_id_it_was_given_and_only_a_well_formed_one() {
        let close = running();
        let command = close
            .begin(&args(&["stow", "-i", "a", "--op-id", OP]))
            .unwrap();
        assert_eq!(command.op.as_deref(), Some(OP));
        close.end(outcome("a", "stow", 0));
        for bad in [
            &["stow", "-i", "a", "--op-id", "short"][..],
            &["stow", "-i", "a", "--op-id", "has space in it"],
            &["stow", "-i", "a", "--id", OP],
            &["stow", "-i", "a", "--op-id"],
        ] {
            assert!(close.begin(&args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_close_command_cut_short_with_the_app_is_found_by_the_next_app() {
        let path = journal_path("orphan");
        let close = running();
        close.open_journal(path.clone());
        close
            .begin(&args(&["stow", "-i", "a", "--op-id", OP]))
            .unwrap();
        drop(close);
        let next = CloseCoordinator::default();
        next.open_journal(path.clone());
        let orphan = next.snapshot().orphans.first().cloned().unwrap();
        assert_eq!(
            (
                orphan.machine.as_str(),
                orphan.verb.as_str(),
                orphan.op.as_deref()
            ),
            ("a", "stow", Some(OP))
        );
        next.forget_orphan("someone-else-01");
        assert_eq!(next.snapshot().orphans.len(), 1);
        next.forget_orphan(OP);
        assert_eq!(next.snapshot().orphans, vec![]);
        assert!(!path.exists());
    }

    #[test]
    fn a_second_close_cut_short_keeps_the_first_for_the_next_app_too() {
        const SECOND: &str = "1c2d3e4f-0000-4000-8000-aabbccddeeff";
        let path = journal_path("two");
        let first = running();
        first.open_journal(path.clone());
        first
            .begin(&args(&["stow", "-i", "a", "--op-id", OP]))
            .unwrap();
        drop(first);
        let second = running();
        second.open_journal(path.clone());
        second
            .begin(&args(&["stow", "-i", "b", "--op-id", SECOND]))
            .unwrap();
        drop(second);
        let third = CloseCoordinator::default();
        third.open_journal(path.clone());
        let ops: Vec<String> = third
            .snapshot()
            .orphans
            .iter()
            .filter_map(|o| o.op.clone())
            .collect();
        assert_eq!(ops, vec![OP.to_owned(), SECOND.to_owned()]);
        third.forget_orphan(OP);
        third.forget_orphan(SECOND);
        assert!(!path.exists());
    }

    #[test]
    fn a_close_that_settles_its_command_keeps_an_earlier_close_cut_short() {
        let path = journal_path("keeps");
        let first = running();
        first.open_journal(path.clone());
        first
            .begin(&args(&["stow", "-i", "a", "--op-id", OP]))
            .unwrap();
        drop(first);
        let next = running();
        next.open_journal(path.clone());
        next.begin(&args(&[
            "stop",
            "-i",
            "b",
            "--op-id",
            "2d3e4f50-0000-4000-8000-aabbccddeeff",
        ]))
        .unwrap();
        next.end(outcome("b", "stop", 0));
        next.resolved("b").unwrap();
        let after = CloseCoordinator::default();
        after.open_journal(path.clone());
        assert_eq!(
            after
                .snapshot()
                .orphans
                .iter()
                .filter_map(|o| o.op.as_deref())
                .collect::<Vec<_>>(),
            vec![OP]
        );
        after.forget_orphan(OP);
    }

    #[test]
    fn a_close_that_settles_its_command_leaves_nothing_for_the_next_app() {
        for settle in ["resolved", "cancel", "complete"] {
            let path = journal_path(settle);
            let close = running();
            close.open_journal(path.clone());
            close
                .begin(&args(&["stop", "-i", "a", "--op-id", OP]))
                .unwrap();
            assert!(path.exists(), "{settle}");
            close.end(outcome("a", "stop", 0));
            match settle {
                "resolved" => close.resolved("a").unwrap(),
                "cancel" => {
                    close.cancel().unwrap();
                }
                _ => {
                    close.complete().unwrap();
                }
            }
            assert!(!path.exists(), "{settle}");
        }
    }

    #[test]
    fn a_reloaded_window_waits_for_the_close_command_without_polling() {
        let close = std::sync::Arc::new(running());
        close
            .begin(&args(&["stow", "-i", "a", "--op-id", OP]))
            .unwrap();
        let waiting = std::sync::Arc::clone(&close);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(waiting.wait_for_command());
        });
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        close.end(outcome("a", "stow", 4));
        let after = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(after.command, None);
        assert_eq!(after.last.map(|l| l.code), Some(4));
    }

    #[test]
    fn a_reloaded_window_reads_where_the_running_close_got_to() {
        let close = running();
        close.at("a").unwrap();
        close.resolved("a").unwrap();
        close.resolved("a").unwrap();
        close.at("b").unwrap();
        close.begin(&args(&["stow", "-i", "b"])).unwrap();
        let snap = close.snapshot();
        assert_eq!(snap.state, CloseState::Running);
        assert_eq!(snap.machine.as_deref(), Some("b"));
        assert_eq!(snap.resolved, vec!["a".to_owned()]);
        assert_eq!(
            serde_json::to_value(&snap).unwrap(),
            serde_json::json!({
                "state": "running",
                "machine": "b",
                "command": { "machine": "b", "verb": "stow", "op": null },
                "last": null,
                "resolved": ["a"],
                "session": null,
                "orphans": [],
            })
        );
    }

    #[test]
    fn progress_is_only_recorded_while_the_close_runs() {
        let close = CloseCoordinator::default();
        assert!(close.at("a").is_err());
        assert!(close.resolved("a").is_err());
        close.request();
        assert!(close.at("a").is_err());
        assert_eq!(close.snapshot().machine, None);
    }

    #[test]
    fn a_new_request_starts_a_fresh_transaction() {
        let close = running();
        close.on_terminate(Quit::SessionEnd, true, DEADLINE);
        close.resolved("a").unwrap();
        close.begin(&args(&["stow", "-i", "b"])).unwrap();
        close.end(outcome("b", "stow", 1));
        close.cancel().unwrap();
        assert_eq!(close.request(), Request::Emit);
        assert_eq!(
            close.snapshot(),
            Snapshot {
                state: CloseState::Requested,
                ..Snapshot::default()
            }
        );
    }

    #[test]
    fn the_snapshot_serializes_a_session_end_for_the_window() {
        assert_eq!(
            serde_json::to_value(Session::Waiting { deadline: DEADLINE }).unwrap(),
            serde_json::json!({ "kind": "waiting", "deadline": DEADLINE })
        );
        assert_eq!(
            serde_json::to_value(Session::Missed).unwrap(),
            serde_json::json!({ "kind": "missed" })
        );
    }

    fn updater(close: &std::sync::Arc<CloseCoordinator>) -> std::sync::mpsc::Receiver<bool> {
        let (tx, rx) = std::sync::mpsc::channel();
        let close = std::sync::Arc::clone(close);
        std::thread::spawn(move || {
            let _ = tx.send(close.wait_to_restart());
        });
        rx
    }

    const HELD: std::time::Duration = std::time::Duration::from_millis(150);
    const LONG: std::time::Duration = std::time::Duration::from_secs(5);

    #[test]
    fn the_updater_restarts_at_once_when_no_close_is_under_way() {
        let close = std::sync::Arc::new(CloseCoordinator::default());
        assert_eq!(updater(&close).recv_timeout(LONG), Ok(true));
        assert_eq!(close.state(), CloseState::Authorized);
        assert_eq!(close.request(), Request::Allow);
    }

    #[test]
    fn the_updater_waits_out_a_close_and_its_command_then_restarts_once_it_is_cancelled() {
        let close = std::sync::Arc::new(running());
        close.begin(&args(&["stow", "-i", "a"])).unwrap();
        let restart = updater(&close);
        assert!(restart.recv_timeout(HELD).is_err(), "restarted mid-stow");
        close.end(outcome("a", "stow", 1));
        assert!(restart.recv_timeout(HELD).is_err(), "restarted mid-close");
        assert_eq!(close.state(), CloseState::Running);
        close.cancel().unwrap();
        assert_eq!(restart.recv_timeout(LONG), Ok(true));
        assert_eq!(close.state(), CloseState::Authorized);
    }

    #[test]
    fn the_updater_waits_out_a_requested_close_too() {
        let close = std::sync::Arc::new(CloseCoordinator::default());
        close.request();
        let restart = updater(&close);
        assert!(restart.recv_timeout(HELD).is_err());
        close.cancel().unwrap();
        assert_eq!(restart.recv_timeout(LONG), Ok(true));
    }

    #[test]
    fn the_updater_does_not_restart_an_app_whose_close_completed() {
        let close = std::sync::Arc::new(running());
        let restart = updater(&close);
        assert!(restart.recv_timeout(HELD).is_err());
        close.complete().unwrap();
        assert_eq!(restart.recv_timeout(LONG), Ok(false));
        assert_eq!(close.state(), CloseState::Authorized);
    }

    fn status(instances: &serde_json::Value) -> String {
        serde_json::json!({ "instances": instances }).to_string()
    }

    #[test]
    fn a_session_end_needs_the_close_only_for_a_live_machine_not_left_running() {
        let none = status(&serde_json::json!([]));
        assert!(!needs_resolving(&none));
        let quiet = status(&serde_json::json!([
            { "name": "a", "state": "stopped", "closePolicy": "ask", "operation": null },
            { "name": "b", "state": "stowed", "closePolicy": "stow", "operation": null },
            { "name": "c", "state": "missing" },
            { "name": "d", "state": "running", "closePolicy": "leave", "operation": null },
            { "name": "e", "state": "asleep", "closePolicy": "leave" },
        ]));
        assert!(!needs_resolving(&quiet));
        for live in ["running", "paused", "asleep"] {
            for policy in ["ask", "stow", "shutdown", "bogus"] {
                let one = status(&serde_json::json!([
                    { "name": "a", "state": live, "closePolicy": policy, "operation": null },
                ]));
                assert!(needs_resolving(&one), "{live} {policy}");
            }
            let older = status(&serde_json::json!([{ "name": "a", "state": live }]));
            assert!(needs_resolving(&older), "{live} with no policy is ask");
        }
        let busy = status(&serde_json::json!([
            { "name": "a", "state": "running", "closePolicy": "leave",
              "operation": { "operation": "save", "pid": 1, "startedAt": "x" } },
        ]));
        assert!(
            needs_resolving(&busy),
            "an operation under way is asked about"
        );
        let busy_off = status(&serde_json::json!([
            { "name": "a", "state": "stopped", "closePolicy": "ask",
              "operation": { "operation": "start", "pid": 1, "startedAt": "x" } },
        ]));
        assert!(
            !needs_resolving(&busy_off),
            "the window only resolves live machines, so neither does a logout"
        );
    }

    fn single(instance: &serde_json::Value) -> String {
        let mut one = instance.clone();
        one["timeMachine"] = serde_json::json!({ "enabled": false });
        one.to_string()
    }

    #[test]
    fn a_session_end_reads_the_single_machine_status_winvm_prints_for_one_machine() {
        let stopped = single(&serde_json::json!(
            { "name": "default", "state": "stopped", "closePolicy": "ask", "operation": null }
        ));
        assert!(!needs_resolving(&stopped));
        let left = single(&serde_json::json!(
            { "name": "default", "state": "running", "closePolicy": "leave", "operation": null }
        ));
        assert!(!needs_resolving(&left));
        let asked = single(&serde_json::json!(
            { "name": "default", "state": "running", "closePolicy": "ask", "operation": null }
        ));
        assert!(needs_resolving(&asked));
        let older = single(&serde_json::json!({ "name": "default", "state": "paused" }));
        assert!(needs_resolving(&older));
    }

    #[test]
    fn a_session_end_that_cannot_read_the_machines_runs_the_close() {
        for unreadable in [
            "",
            "not json",
            "{}",
            "{\"instances\": 3}",
            "[]",
            "{\"name\": \"a\"}",
            "{\"state\": 7}",
        ] {
            assert!(needs_resolving(unreadable), "{unreadable:?}");
        }
    }

    #[test]
    fn a_session_end_reads_what_status_printed_even_when_it_exited_nonzero() {
        let missing = single(&serde_json::json!({ "name": "default", "state": "missing" }));
        let exited = Err(Box::new(SidecarFailure::exit(
            "status",
            Some(1),
            None,
            missing,
            String::new(),
        )));
        assert!(!needs_from(&exited));
        let printed = Ok(Output {
            code: 0,
            stdout: status(&serde_json::json!([])),
            stderr: String::new(),
        });
        assert!(!needs_from(&printed));
        let unlaunched = Err(Box::new(SidecarFailure::launch("status", "gone".into())));
        assert!(needs_from(&unlaunched));
        let silent = Err(Box::new(SidecarFailure::exit(
            "status",
            Some(1),
            None,
            String::new(),
            "boom".into(),
        )));
        assert!(needs_from(&silent));
    }

    #[test]
    fn only_the_main_window_closing_is_a_viewer_close() {
        assert!(closes_viewer("main"));
        assert!(!closes_viewer("terminal"));
        assert!(!closes_viewer("files-win11"));
        assert!(!closes_viewer("main-2"));
    }

    #[test]
    fn file_close_routes_by_the_focused_window() {
        assert_eq!(
            route_close(Some("terminal"), "terminal"),
            CloseRoute::TerminalTab
        );
        assert_eq!(route_close(Some("main"), "terminal"), CloseRoute::Viewer);
        assert_eq!(
            route_close(Some("files-win11"), "terminal"),
            CloseRoute::Window
        );
        assert_eq!(route_close(None, "terminal"), CloseRoute::Nothing);
    }

    #[test]
    fn only_the_custom_quit_item_quits() {
        assert!(is_quit("quit"));
        for other in ["close", "new-tab", "check-updates", "Quit", ""] {
            assert!(!is_quit(other), "{other}");
        }
    }

    #[test]
    fn only_the_main_window_may_answer_a_close() {
        assert_eq!(caller_may_answer("main"), Ok(()));
        assert!(caller_may_answer("terminal").is_err());
        assert!(caller_may_answer("files-win11").is_err());
    }

    #[test]
    fn the_state_reports_a_requested_close_without_changing_it() {
        let close = CloseCoordinator::default();
        assert_eq!(close.snapshot().state, CloseState::Idle, "idle");
        close.request();
        assert_eq!(close.snapshot().state, CloseState::Requested);
        assert_eq!(close.snapshot().state, CloseState::Requested);
        assert_eq!(close.state(), CloseState::Requested);
        assert_eq!(close.request(), Request::Coalesced);
        assert_eq!(close.snapshot().state, CloseState::Requested);
        close.start().unwrap();
        assert_eq!(
            close.snapshot().state,
            CloseState::Running,
            "running: already acknowledged"
        );
        assert_eq!(close.state(), CloseState::Running);
        close.cancel().unwrap();
        assert_eq!(close.snapshot().state, CloseState::Idle, "cancelled");
        close.request();
        close.start().unwrap();
        close.complete().unwrap();
        assert_eq!(close.snapshot().state, CloseState::Authorized, "authorized");
        assert_eq!(close.state(), CloseState::Authorized);
    }

    #[test]
    fn only_the_main_window_may_ask_about_the_close() {
        assert_eq!(caller_may_answer("main"), Ok(()));
        assert!(caller_may_answer("terminal").is_err());
    }
}
