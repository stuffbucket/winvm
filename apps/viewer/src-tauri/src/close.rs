//! The one place that decides whether the viewer may close.

use std::sync::Mutex;

/// Where the one close transaction stands.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CloseState {
    /// Nothing asked to close.
    #[default]
    Idle,
    /// Asked, and the window has been told once; it has not answered.
    Requested,
    /// The window answered and is running its close flow.
    Running,
    /// The window finished. Every callback of the terminating exit or restart passes.
    Authorized,
}

/// What a native request to close came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    /// A new transaction: tell the main window, and keep the app open.
    Emit,
    /// A transaction is already underway: keep the app open and say nothing.
    Coalesced,
    /// The close is authorized: let it through.
    Allow,
}

impl Request {
    /// Whether the window or exit that asked must be prevented.
    pub fn keeps_app_open(self) -> bool {
        self != Request::Allow
    }
}

/// Close state behind one lock, so a double-tap of Cmd-W and a Quit racing a window close are one request.
#[derive(Default)]
pub struct CloseCoordinator(Mutex<CloseState>);

impl CloseCoordinator {
    fn lock(&self) -> std::sync::MutexGuard<'_, CloseState> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub fn state(&self) -> CloseState {
        *self.lock()
    }

    /// A native close, quit or exit asks to go ahead.
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

    /// An update is about to restart the app. Updating never opens the close flow or touches a VM, so
    /// this authorizes without asking, whatever the close was doing.
    pub fn authorize_bypass(&self) {
        *self.lock() = CloseState::Authorized;
    }

    /// The window heard the request and is running its close flow.
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

    /// The person backed out, or the flow could not begin: the app stays open and may be asked again.
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

    /// The flow finished: from here the app may exit.
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

/// The window whose close is the viewer's close; the others close themselves.
pub const MAIN: &str = "main";
/// Told to the main window once per close transaction.
pub const REQUESTED_EVENT: &str = "viewer-close-requested";
/// The app menu's Quit, which replaces the predefined one so Cmd-Q joins the same transaction.
pub const QUIT_ID: &str = "quit";

/// Whether a window's close is the viewer's close.
pub fn closes_viewer(label: &str) -> bool {
    label == MAIN
}

pub fn is_quit(menu_id: &str) -> bool {
    menu_id == QUIT_ID
}

/// What File > Close (Cmd-W) does, by the window in front.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseRoute {
    /// The Terminal window closes a tab.
    TerminalTab,
    /// The main window asks the viewer to close.
    Viewer,
    /// Any other window closes itself.
    Window,
    /// No window of the app has focus.
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

/// Only the main window runs the close flow, so only it may answer it.
pub fn caller_may_answer(label: &str) -> Result<(), String> {
    if closes_viewer(label) {
        Ok(())
    } else {
        Err(format!("only the main window answers a close, not {label}"))
    }
}

/// A native close, quit or exit asks to go ahead. Returns whether it must be prevented. The first
/// request of a transaction brings the main window forward and tells it once.
pub fn request<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::{Emitter, Manager};
    let close = app.state::<CloseCoordinator>();
    let Some(main) = app.get_webview_window(MAIN) else {
        // Nothing left to ask: let the app go rather than hold it open with no one to answer.
        close.authorize_bypass();
        return false;
    };
    let request = close.request();
    if request == Request::Emit {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        if app.emit_to(MAIN, REQUESTED_EVENT, ()).is_err() {
            // The window was never told, so no answer is coming: allow the next request to try again.
            let _ = close.cancel();
        }
    }
    request.keeps_app_open()
}

/// The main window heard the request and is running its close flow.
#[tauri::command]
pub fn close_start(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    close.start()
}

/// The person backed out of closing.
#[tauri::command]
pub fn close_cancel(
    window: tauri::WebviewWindow,
    close: tauri::State<CloseCoordinator>,
) -> Result<(), String> {
    caller_may_answer(window.label())?;
    close.cancel()
}

/// The close flow finished: authorize, then exit. This never touches a VM; the flow already decided that.
#[tauri::command]
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
        // A request the window never answered can be cancelled too.
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
        // Window close, ExitRequested(code), ExitRequested(None) after the last window goes...
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
}
