use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
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

#[derive(Default)]
pub struct CloseCoordinator(Mutex<CloseState>);

impl CloseCoordinator {
    fn lock(&self) -> std::sync::MutexGuard<'_, CloseState> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    pub fn state(&self) -> CloseState {
        *self.lock()
    }

    pub fn request(&self) -> Request {
        let mut state = self.lock();
        match *state {
            CloseState::Idle => {
                *state = CloseState::Requested;
                Request::Emit
            }
            CloseState::Requested | CloseState::Running => Request::Coalesced,
            CloseState::Authorized => Request::Allow,
        }
    }

    pub fn authorize_bypass(&self) {
        *self.lock() = CloseState::Authorized;
    }

    pub fn start(&self) -> Result<(), String> {
        let mut state = self.lock();
        match *state {
            CloseState::Requested => {
                *state = CloseState::Running;
                Ok(())
            }
            other => Err(out_of_order("start", other)),
        }
    }

    pub fn pending(&self) -> bool {
        *self.lock() == CloseState::Requested
    }

    pub fn cancel(&self) -> Result<(), String> {
        let mut state = self.lock();
        match *state {
            CloseState::Requested | CloseState::Running => {
                *state = CloseState::Idle;
                Ok(())
            }
            other => Err(out_of_order("cancel", other)),
        }
    }

    pub fn complete(&self) -> Result<(), String> {
        let mut state = self.lock();
        match *state {
            CloseState::Running => {
                *state = CloseState::Authorized;
                Ok(())
            }
            other => Err(out_of_order("complete", other)),
        }
    }
}

fn out_of_order(what: &str, state: CloseState) -> String {
    format!("close {what} arrived while the close was {state:?}")
}

pub const MAIN: &str = "main";
pub const REQUESTED_EVENT: &str = "viewer-close-requested";
pub const QUIT_ID: &str = "quit";

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

pub fn request<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::{Emitter, Manager};
    let close = app.state::<CloseCoordinator>();
    let Some(main) = app.get_webview_window(MAIN) else {
        close.authorize_bypass();
        return false;
    };
    let request = close.request();
    if request == Request::Emit {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        if app.emit_to(MAIN, REQUESTED_EVENT, ()).is_err() {
            let _ = close.cancel();
        }
    }
    request.keeps_app_open()
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects these extractors by value; a command cannot take a reference to them"
)]
pub fn close_pending(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
) -> Result<bool, String> {
    caller_may_answer(window.label())?;
    Ok(close.pending())
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
pub fn close_cancel(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    close.cancel()
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
    close.complete()?;
    app.exit(0);
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
        assert_eq!(close.cancel(), Ok(()));
        assert_eq!(close.state(), CloseState::Idle);
        assert_eq!(close.request(), Request::Emit);
        assert_eq!(close.cancel(), Ok(()));
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
        assert_eq!(close.complete(), Ok(()));
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
    fn the_updater_bypass_authorizes_from_any_state_without_asking() {
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
    fn pending_reports_only_a_requested_close_and_changes_nothing() {
        let close = CloseCoordinator::default();
        assert!(!close.pending(), "idle");
        close.request();
        assert!(close.pending());
        assert!(close.pending());
        assert_eq!(close.state(), CloseState::Requested);
        assert_eq!(close.request(), Request::Coalesced);
        assert!(close.pending());
        close.start().unwrap();
        assert!(!close.pending(), "running: already acknowledged");
        assert_eq!(close.state(), CloseState::Running);
        close.cancel().unwrap();
        assert!(!close.pending(), "cancelled");
        close.request();
        close.start().unwrap();
        close.complete().unwrap();
        assert!(!close.pending(), "authorized");
        assert_eq!(close.state(), CloseState::Authorized);
    }

    #[test]
    fn only_the_main_window_may_ask_whether_a_close_is_pending() {
        assert_eq!(caller_may_answer("main"), Ok(()));
        assert!(caller_may_answer("terminal").is_err());
    }
}
