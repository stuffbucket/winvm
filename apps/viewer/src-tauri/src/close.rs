use crate::sidecar::{self, Output, SidecarFailure};
use serde::{Deserialize, Serialize};
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
    Later { id: u64, emit: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Finish {
    Exit,
    Reply,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Command {
    pub machine: String,
    pub verb: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub machine: String,
    pub verb: String,
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
}

#[derive(Default)]
struct Inner {
    now: Snapshot,
    owed: Option<u64>,
    sessions: u64,
}

impl Inner {
    fn request(&mut self) -> Request {
        match self.now.state {
            CloseState::Idle => {
                self.now = Snapshot {
                    state: CloseState::Requested,
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

    fn defer(&mut self, deadline: u64, emit: bool) -> Terminate {
        self.sessions += 1;
        let id = self.sessions;
        self.owed = Some(id);
        self.now.session = Some(Session::Waiting { deadline });
        Terminate::Later { id, emit }
    }

    fn terminate_at_once(
        &mut self,
        quit: Quit,
        has_window: bool,
        deadline: u64,
    ) -> Option<Terminate> {
        if self.now.state == CloseState::Authorized {
            return Some(Terminate::Now);
        }
        if self.owed.is_some() {
            return Some(Terminate::Cancel { emit: false });
        }
        if !has_window {
            self.now.state = CloseState::Authorized;
            return Some(Terminate::Now);
        }
        match (quit, self.now.state) {
            (Quit::User, _) => Some(Terminate::Cancel {
                emit: self.request() == Request::Emit,
            }),
            (Quit::SessionEnd, CloseState::Requested | CloseState::Running) => {
                Some(self.defer(deadline, false))
            }
            (Quit::SessionEnd, _) => None,
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
        self.lock().now.clone()
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
            Ok(command)
        })
    }

    pub fn end(&self, outcome: Outcome) {
        self.change(|i| {
            i.now.command = None;
            i.now.last = Some(outcome);
        });
    }

    pub fn on_terminate(
        &self,
        quit: Quit,
        has_window: bool,
        deadline: u64,
        needs: impl FnOnce() -> bool,
    ) -> Terminate {
        if let Some(now) = self.change(|i| i.terminate_at_once(quit, has_window, deadline)) {
            return now;
        }
        let needed = needs();
        self.change(|i| {
            if let Some(now) = i.terminate_at_once(quit, has_window, deadline) {
                return now;
            }
            if needed {
                i.request();
                i.defer(deadline, true)
            } else {
                i.now.state = CloseState::Authorized;
                Terminate::Now
            }
        })
    }

    pub fn expire(&self, id: u64) -> bool {
        self.change(|i| {
            if i.owed != Some(id) {
                return false;
            }
            i.owed = None;
            i.now.session = Some(Session::Missed);
            true
        })
    }

    pub fn wait_to_restart(&self) -> bool {
        let mut inner = self
            .changed
            .wait_while(self.lock(), |i| {
                matches!(i.now.state, CloseState::Requested | CloseState::Running)
            })
            .unwrap_or_else(PoisonError::into_inner);
        let restart = inner.now.state != CloseState::Authorized;
        inner.now.state = CloseState::Authorized;
        drop(inner);
        self.changed.notify_all();
        restart
    }
}

fn out_of_order(what: &str, state: CloseState) -> String {
    format!("close {what} arrived while the close was {state:?}")
}

fn close_command(args: &[String]) -> Result<Command, String> {
    match args {
        [verb, flag, machine]
            if (verb == "stow" || verb == "stop") && flag == "-i" && !machine.is_empty() =>
        {
            Ok(Command {
                machine: machine.clone(),
                verb: verb.clone(),
            })
        }
        _ => Err(format!(
            "the close only runs winvm stow or stop on one machine, not {args:?}"
        )),
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

fn bring_forward<R: tauri::Runtime>(main: &tauri::WebviewWindow<R>) {
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
}

fn ask_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    match app.emit_to(MAIN, REQUESTED_EVENT, ()) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("winvm: the close request did not reach the main window, so the close was called off: {e}");
            false
        }
    }
}

fn tell_session<R: tauri::Runtime>(app: &tauri::AppHandle<R>, close: &CloseCoordinator) {
    if let Err(e) = app.emit_to(MAIN, SESSION_EVENT, close.snapshot().session) {
        eprintln!("winvm: the logout deadline did not reach the main window: {e}");
    }
}

fn answer_termination<R: tauri::Runtime>(app: &tauri::AppHandle<R>, terminate: bool) {
    if let Err(e) = app.run_on_main_thread(move || crate::terminate::reply(terminate)) {
        eprintln!("winvm: couldn't answer macOS's request to quit: {e}");
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

fn session_needs_close(app: &tauri::AppHandle) -> bool {
    let args = ["status", "--json"].map(String::from);
    let read = tauri::async_runtime::block_on(sidecar::run_sidecar(
        app,
        &args,
        Some(SESSION_STATUS_TIMEOUT),
    ));
    needs_from(&read)
}

fn needs_from(read: &Result<Output, Box<SidecarFailure>>) -> bool {
    match read {
        Ok(out) => needs_resolving(&out.stdout),
        Err(failure) if failure.code.is_some() => needs_resolving(&failure.stdout),
        Err(_) => true,
    }
}

fn expire_after(app: &tauri::AppHandle, id: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SESSION_END_BUDGET).await;
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
    let deadline = epoch_ms(SystemTime::now() + SESSION_END_BUDGET);
    let decided = close.on_terminate(quit, main.is_some(), deadline, || session_needs_close(app));
    let emit = matches!(
        decided,
        Terminate::Cancel { emit: true } | Terminate::Later { emit: true, .. }
    );
    if emit {
        if let Some(main) = &main {
            bring_forward(main);
        }
        if !ask_window(app) {
            let _ = close.cancel();
            return Terminate::Cancel { emit: false };
        }
    }
    if let Terminate::Later { id, .. } = decided {
        tell_session(app, &close);
        expire_after(app, id);
    }
    eprintln!("winvm: macOS asked winvm to quit ({quit:?}); answered {decided:?}");
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
pub async fn close_run(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    args: Vec<String>,
) -> Result<Output, Box<SidecarFailure>> {
    let operation = sidecar::operation_of(&args);
    let refuse = |why: String| Box::new(SidecarFailure::rejected(&operation, why));
    caller_may_answer(window.label()).map_err(refuse)?;
    let command = app
        .state::<CloseCoordinator>()
        .begin(&args)
        .map_err(refuse)?;
    let ran = sidecar::run_sidecar(&app, &args, None).await;
    app.state::<CloseCoordinator>()
        .end(Outcome::of(command, &ran));
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
            code,
            output: String::new(),
        }
    }

    const DEADLINE: u64 = 1_800_000_040_000;

    fn never() -> bool {
        panic!("the machines are only read when no close is under way")
    }

    #[test]
    fn a_user_quit_starts_the_close_like_cmd_q_and_cancels_the_termination() {
        let close = CloseCoordinator::default();
        assert_eq!(
            close.on_terminate(Quit::User, true, DEADLINE, never),
            Terminate::Cancel { emit: true }
        );
        assert_eq!(close.state(), CloseState::Requested);
        assert_eq!(
            close.on_terminate(Quit::User, true, DEADLINE, never),
            Terminate::Cancel { emit: false }
        );
        close.start().unwrap();
        assert_eq!(
            close.on_terminate(Quit::User, true, DEADLINE, never),
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
            assert_eq!(
                close.on_terminate(quit, true, DEADLINE, never),
                Terminate::Now
            );
            assert_eq!(close.state(), CloseState::Authorized);
        }
    }

    #[test]
    fn with_no_main_window_any_quit_terminates_now() {
        for quit in [Quit::User, Quit::SessionEnd] {
            let close = CloseCoordinator::default();
            assert_eq!(
                close.on_terminate(quit, false, DEADLINE, never),
                Terminate::Now
            );
            assert_eq!(close.state(), CloseState::Authorized);
        }
    }

    #[test]
    fn a_session_end_with_nothing_to_resolve_terminates_now() {
        let close = CloseCoordinator::default();
        assert_eq!(
            close.on_terminate(Quit::SessionEnd, true, DEADLINE, || false),
            Terminate::Now
        );
        assert_eq!(close.state(), CloseState::Authorized);
        assert_eq!(close.request(), Request::Allow);
    }

    #[test]
    fn a_session_end_with_machines_to_resolve_defers_and_requests_the_close_with_a_deadline() {
        let close = CloseCoordinator::default();
        let Terminate::Later { emit: true, .. } =
            close.on_terminate(Quit::SessionEnd, true, DEADLINE, || true)
        else {
            panic!("a session end with live machines waits for the close");
        };
        assert_eq!(close.state(), CloseState::Requested);
        assert_eq!(
            close.snapshot().session,
            Some(Session::Waiting { deadline: DEADLINE })
        );
        assert_eq!(close.request(), Request::Coalesced);
    }

    #[test]
    fn a_session_end_during_a_close_joins_it_without_reading_the_machines_or_asking_again() {
        let requested = CloseCoordinator::default();
        requested.request();
        let running = running();
        for close in [requested, running] {
            let before = close.state();
            let Terminate::Later { emit: false, .. } =
                close.on_terminate(Quit::SessionEnd, true, DEADLINE, never)
            else {
                panic!("a session end joins the close under way");
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
        close.on_terminate(Quit::SessionEnd, true, DEADLINE, never);
        for quit in [Quit::User, Quit::SessionEnd] {
            assert_eq!(
                close.on_terminate(quit, true, DEADLINE, never),
                Terminate::Cancel { emit: false }
            );
        }
        assert_eq!(close.state(), CloseState::Running);
    }

    #[test]
    fn completing_a_session_end_replies_yes_instead_of_exiting() {
        let close = running();
        close.on_terminate(Quit::SessionEnd, true, DEADLINE, never);
        assert_eq!(close.complete(), Ok(Finish::Reply));
        assert_eq!(close.state(), CloseState::Authorized);
        assert_eq!(close.snapshot().session, None);

        let ordinary = running();
        assert_eq!(ordinary.complete(), Ok(Finish::Exit));
    }

    #[test]
    fn cancelling_a_session_end_replies_no_and_an_ordinary_cancel_replies_nothing() {
        let close = running();
        close.on_terminate(Quit::SessionEnd, true, DEADLINE, never);
        assert_eq!(close.cancel(), Ok(Some(false)));
        assert_eq!(close.state(), CloseState::Idle);
        assert_eq!(close.snapshot().session, None);

        let ordinary = running();
        assert_eq!(ordinary.cancel(), Ok(None));
    }

    #[test]
    fn an_expired_session_end_replies_no_once_and_the_close_goes_on() {
        let close = running();
        let Terminate::Later { id, .. } =
            close.on_terminate(Quit::SessionEnd, true, DEADLINE, never)
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
        let Terminate::Later { id, .. } =
            close.on_terminate(Quit::SessionEnd, true, DEADLINE, never)
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
            close.on_terminate(Quit::SessionEnd, true, DEADLINE, never)
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
                verb: "stow".into()
            })
        );
        let during = close.snapshot();
        assert_eq!(during.machine.as_deref(), Some("a"));
        assert_eq!(
            during.command,
            Some(Command {
                machine: "a".into(),
                verb: "stow".into()
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
    fn nothing_ends_the_close_while_its_own_command_runs() {
        let close = running();
        close.on_terminate(Quit::SessionEnd, true, DEADLINE, never);
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
                "command": { "machine": "b", "verb": "stow" },
                "last": null,
                "resolved": ["a"],
                "session": null,
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
        close.on_terminate(Quit::SessionEnd, true, DEADLINE, never);
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
