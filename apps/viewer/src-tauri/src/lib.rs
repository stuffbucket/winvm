mod agent;
mod checkpoints;
mod close;
mod dragout;
mod events;
mod liveresize;
mod sidecar;
pub mod terminate;
mod usage;

use serde::{Deserialize, Serialize};
use sidecar::{Finished, Output, SidecarFailure};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{
    Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_updater::UpdaterExt;

const VERBS: &[&str] = &[
    "status",
    "info",
    "doctor",
    "start",
    "stop",
    "stow",
    "reboot",
    "pause",
    "resume",
    "kill",
    "open",
    "setup",
    "exec",
    "put",
    "get",
    "dir",
    "mkdir",
    "mv",
    "cp",
    "rm",
    "save",
    "load",
    "saves",
    "help",
    "terminal",
    "config",
    "display",
    "create",
    "destroy",
    "ls",
    "mcp",
    "sleep",
    "wake",
    "lock",
    "settings",
    "files",
    "share",
    "events",
    "reconcile",
];

fn permitted(args: &[String]) -> Result<(), String> {
    match args.first() {
        Some(verb) if VERBS.contains(&verb.as_str()) => {}
        _ => {
            return Err(format!(
                "not a winvm command this app runs: {:?}",
                args.first()
            ))
        }
    }
    if events::follows(args) {
        return Err("`winvm events --follow` never ends, so the app runs it once, as its event stream, not as a command".into());
    }
    Ok(())
}

#[cfg(test)]
mod command_allowlist_tests {
    use super::{events, permitted, sidecar, VERBS};

    #[test]
    fn permits_every_close_policy_command_without_timing_out_vm_mutations() {
        for verb in ["stow", "stop"] {
            assert!(
                VERBS.contains(&verb),
                "{verb} must be available to the close flow"
            );
            assert_eq!(
                sidecar::timeout_for(&[verb.to_owned()]),
                None,
                "{verb} must not be killed mid-mutation"
            );
        }
        assert!(
            VERBS.contains(&"config"),
            "remembering a close policy needs config"
        );
    }

    #[test]
    fn runs_the_event_stream_only_as_the_stream_and_reconcile_without_a_deadline() {
        let args = |a: &[&str]| a.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert!(permitted(&args(&["events", "--json", "--since=eyJ2IjoxfQ"])).is_ok());
        assert_eq!(
            sidecar::timeout_for(&args(&["events", "--json"])),
            Some(sidecar::READ_TIMEOUT)
        );
        let stream = events::stream_args(None);
        assert!(
            permitted(&stream).is_err(),
            "a follow through `winvm` would never return"
        );
        assert_eq!(
            sidecar::timeout_for(&stream),
            None,
            "the stream has no deadline"
        );
        assert!(permitted(&args(&["reconcile", "-i", "demo"])).is_ok());
        assert_eq!(
            sidecar::timeout_for(&args(&["reconcile", "-i", "demo"])),
            None
        );
        assert!(permitted(&args(&["serve", "-i", "demo"])).is_err());
        assert!(permitted(&[]).is_err());
    }
}

#[tauri::command]
async fn winvm(app: tauri::AppHandle, args: Vec<String>) -> Result<Output, Box<SidecarFailure>> {
    permitted(&args)
        .map_err(|why| Box::new(SidecarFailure::rejected(&sidecar::operation_of(&args), why)))?;
    sidecar::run_sidecar(&app, &args, sidecar::timeout_for(&args)).await
}

#[derive(Default)]
struct Sharing(Mutex<Option<CommandChild>>);

fn stop_sharing(sharing: &Sharing) {
    if let Some(child) = sharing.0.lock().ok().and_then(|mut c| c.take()) {
        let _ = sidecar::terminate_child(child.pid());
    }
}

#[tauri::command]
async fn share_start(
    app: tauri::AppHandle,
    instance: String,
) -> Result<Output, Box<SidecarFailure>> {
    let sharing = app.state::<Sharing>();
    stop_sharing(&sharing);
    let args = ["cua", "serve", "-i", instance.as_str()].map(String::from);
    let ready = |stdout: &str| stdout.contains("  token ");
    match sidecar::start_sidecar(&app, &args, sidecar::SHARE_HANDSHAKE_TIMEOUT, &ready).await? {
        Finished::Exited(out) => Ok(out),
        Finished::Ready { output, child } => {
            *sharing
                .0
                .lock()
                .map_err(|e| SidecarFailure::rejected("cua serve", e.to_string()))? = Some(child);
            Ok(output)
        }
    }
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects the AppHandle by value; a command cannot take a reference to it"
)]
fn share_stop(app: tauri::AppHandle) {
    stop_sharing(&app.state::<Sharing>());
}

const TERMINAL: &str = "terminal";
const SHELLS: &[&str] = &["pwsh", "powershell", "cmd"];

#[derive(Clone, Deserialize, Serialize)]
struct TerminalRequest {
    instance: String,
    shell: String,
    cwd: Option<String>,
    #[serde(default)]
    installed: Option<Vec<String>>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Default)]
struct TerminalRequests(Mutex<Vec<TerminalRequest>>);

fn show_terminal(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TERMINAL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return app
            .emit_to(TERMINAL, "terminal-open", ())
            .map_err(|e| e.to_string());
    }
    let mut builder =
        WebviewWindowBuilder::new(app, TERMINAL, WebviewUrl::App("terminal.html".into()))
            .title("Terminal")
            .inner_size(820.0, 520.0)
            .min_inner_size(420.0, 240.0)
            .visible(false);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 26.0));
    }
    if let Some((x, y)) = beside_main(app, 820.0) {
        builder = builder.position(x, y);
    }
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

fn beside_main(app: &tauri::AppHandle, width: f64) -> Option<(f64, f64)> {
    let main = app.get_webview_window("main")?;
    let scale = main.scale_factor().ok()?;
    let at = main.outer_position().ok()?.to_logical::<f64>(scale);
    let size = main.outer_size().ok()?.to_logical::<f64>(scale);
    let monitor = main.current_monitor().ok()??;
    let screen_at = monitor.position().to_logical::<f64>(scale);
    let screen = monitor.size().to_logical::<f64>(scale);
    let x = at.x + size.width + 8.0;
    (x + width <= screen_at.x + screen.width).then_some((x, at.y))
}

#[tauri::command]
async fn terminal_open(app: tauri::AppHandle, request: TerminalRequest) -> Result<(), String> {
    if !SHELLS.contains(&request.shell.as_str()) {
        return Err(format!("not a shell this app opens: {}", request.shell));
    }
    app.state::<TerminalRequests>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .push(request);
    show_terminal(&app)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects the AppHandle by value; a command cannot take a reference to it"
)]
fn terminal_take(app: tauri::AppHandle) -> Vec<TerminalRequest> {
    app.state::<TerminalRequests>()
        .0
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

fn focused_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

fn files_label(instance: &str) -> String {
    let safe: String = instance
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("files-{safe}")
}

fn query_value(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[tauri::command]
async fn files_open(
    app: tauri::AppHandle,
    instance: String,
    title: Option<String>,
) -> Result<(), String> {
    if instance.is_empty() || instance.len() > 64 {
        return Err("no instance named".into());
    }
    let label = files_label(&instance);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let shown = title.clone().unwrap_or_else(|| instance.clone());
    let url = format!(
        "files.html?instance={}&title={}",
        query_value(&instance),
        query_value(title.as_deref().unwrap_or(""))
    );
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(format!("Files in Windows — {shown}"))
        .inner_size(920.0, 560.0)
        .min_inner_size(560.0, 340.0)
        .visible(false);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 26.0));
    }
    if let Some((x, y)) = beside_main(&app, 920.0) {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_text(text: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new("/usr/bin/pbcopy")
        .env("LANG", "en_US.UTF-8")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("pbcopy has no stdin")?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn read_text() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = std::process::Command::new("/usr/bin/pbpaste")
            .args(["-Prefer", "txt"])
            .env("LANG", "en_US.UTF-8")
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|e| e.to_string())
}

#[tauri::command]
fn downloads_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(Path::new(&home).join("Downloads").display().to_string())
}

#[tauri::command]
fn unused_path(dir: &str, name: &str, folder: bool) -> String {
    let dir = Path::new(dir);
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !folder => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut path = dir.join(name);
    let mut n = 2;
    while path.symlink_metadata().is_ok() {
        path = dir.join(format!("{stem} {n}{ext}"));
        n += 1;
    }
    path.display().to_string()
}

#[tauri::command]
fn reveal(path: &str) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn install_cli() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let cli = exe
        .parent()
        .ok_or("the app has no Contents/MacOS directory")?
        .join("winvm");
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let bin = Path::new(&home).join(".local").join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let link = bin.join("winvm");
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => {
            std::fs::remove_file(&link).map_err(|e| e.to_string())?;
        }
        Ok(_) => {
            return Err(format!(
                "{} exists and is not a link, so it was left alone",
                link.display()
            ))
        }
        Err(_) => {}
    }
    std::os::unix::fs::symlink(&cli, &link).map_err(|e| e.to_string())?;
    Ok(link.display().to_string())
}

#[derive(Default)]
struct Updating(AtomicBool);

fn check_for_update(app: tauri::AppHandle, asked: bool) {
    if app.state::<Updating>().0.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let found = tauri::async_runtime::block_on(async { app.updater()?.check().await });
        match found {
            Ok(Some(update)) => {
                let install = app
                    .dialog()
                    .message(format!(
                        "winvm {} is available. You have {}. Install it now? winvm restarts when it's done.",
                        update.version, update.current_version
                    ))
                    .title("Update available")
                    .buttons(MessageDialogButtons::OkCancelCustom("Install and Restart".into(), "Later".into()))
                    .blocking_show();
                if install {
                    let done = tauri::async_runtime::block_on(
                        update.download_and_install(|_, _| {}, || {}),
                    );
                    match done {
                        Ok(()) => {
                            if app.state::<close::CloseCoordinator>().wait_to_restart() {
                                stop_sharing(&app.state::<Sharing>());
                                events::stop(&app);
                                app.restart();
                            }
                        }
                        Err(e) => {
                            app.dialog()
                                .message(format!("The update didn't install: {e}"))
                                .title("Update failed")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                        }
                    }
                }
            }
            Ok(None) if asked => {
                app.dialog()
                    .message(format!(
                        "winvm {} is the latest version.",
                        app.package_info().version
                    ))
                    .title("No update")
                    .blocking_show();
            }
            Err(e) if asked => {
                app.dialog()
                    .message(format!("Couldn't check for updates: {e}"))
                    .title("Update check failed")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
            _ => {}
        }
        app.state::<Updating>().0.store(false, Ordering::SeqCst);
    });
}

fn input_menu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let capture = MenuItem::with_id(
        app,
        "capture-keyboard",
        "Capture Keyboard",
        true,
        None::<&str>,
    )?;
    let windows_key = MenuItem::with_id(
        app,
        "send-windows-key",
        "Send Windows Key",
        true,
        None::<&str>,
    )?;
    let ctrl_alt_delete = MenuItem::with_id(
        app,
        "send-ctrl-alt-delete",
        "Send Ctrl-Alt-Delete",
        true,
        None::<&str>,
    )?;
    let release = MenuItem::with_id(
        app,
        "release-keyboard",
        "Release Keyboard",
        true,
        None::<&str>,
    )?;
    Submenu::with_items(
        app,
        "Input",
        true,
        &[
            &capture,
            &PredefinedMenuItem::separator(app)?,
            &windows_key,
            &ctrl_alt_delete,
            &PredefinedMenuItem::separator(app)?,
            &release,
        ],
    )
}

fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let new_tab = MenuItem::with_id(
        app,
        "new-tab",
        "New Terminal Tab",
        true,
        Some("CmdOrCtrl+T"),
    )?;
    let checkpoints = MenuItem::with_id(
        app,
        "checkpoints",
        "Checkpoints…",
        true,
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let close = MenuItem::with_id(app, "close", "Close", true, Some("CmdOrCtrl+W"))?;
    let file = menu
        .items()?
        .into_iter()
        .filter_map(|i| i.as_submenu().cloned())
        .find(|m| m.text().is_ok_and(|t| t == "File"));
    if let Some(file) = file {
        for item in file.items()? {
            file.remove(&item)?;
        }
        file.append_items(&[
            &new_tab,
            &checkpoints,
            &PredefinedMenuItem::separator(app)?,
            &close,
        ])?;
    }
    let rename = MenuItem::with_id(app, "rename-window", "Rename Window…", true, None::<&str>)?;
    if let Some(window) = menu
        .get(WINDOW_SUBMENU_ID)
        .and_then(|i| i.as_submenu().cloned())
    {
        if window.items()?.len() == 4 {
            window.remove_at(3)?;
            window.remove_at(2)?;
        }
        window.append_items(&[&PredefinedMenuItem::separator(app)?, &rename])?;
    }
    let updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let install = MenuItem::with_id(
        app,
        "install-cli",
        "Install Command Line Tool…",
        true,
        None::<&str>,
    )?;
    let reference = MenuItem::with_id(
        app,
        "reference",
        "winvm Command Reference",
        true,
        Some("CmdOrCtrl+Shift+/"),
    )?;
    let input = input_menu(app)?;
    let input_index = menu.items()?.len().saturating_sub(2);
    menu.insert(&input, input_index)?;
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        let items = app_menu.items()?;
        let predefined_quit = items.last().filter(|i| {
            i.as_predefined_menuitem()
                .is_some_and(|q| q.text().is_ok_and(|t| t.starts_with("Quit")))
        });
        if let Some(quit) = predefined_quit {
            app_menu.remove(quit)?;
            let name = app.package_info().name.clone();
            app_menu.append(&MenuItem::with_id(
                app,
                close::QUIT_ID,
                format!("Quit {name}"),
                true,
                Some("CmdOrCtrl+Q"),
            )?)?;
        }
        app_menu.insert_items(&[&install, &PredefinedMenuItem::separator(app)?], 2)?;
        app_menu.insert(&updates, 1)?;
    }
    if let Some(help) = menu
        .get(HELP_SUBMENU_ID)
        .and_then(|i| i.as_submenu().cloned())
    {
        help.append(&reference)?;
    }
    Ok(menu)
}

#[tauri::command]
fn trace(line: &str) {
    eprintln!("{line}");
}

#[tauri::command]
fn set_system_keyboard_capture(captured: bool) -> Result<(), String> {
    system_keyboard_capture(captured)
}

fn system_keyboard_capture(captured: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        type Connection = u32;
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGSMainConnectionID() -> Connection;
            fn CGSSetGlobalHotKeyOperatingMode(connection: Connection, mode: u32) -> i32;
        }
        // SAFETY: both functions take and return plain integers and have no preconditions.
        let result =
            unsafe { CGSSetGlobalHotKeyOperatingMode(CGSMainConnectionID(), u32::from(captured)) };
        if result != 0 {
            return Err(format!("CoreGraphics rejected keyboard capture ({result})"));
        }
    }
    Ok(())
}

fn handle_menu(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if matches!(
        id,
        "install-cli"
            | "reference"
            | "capture-keyboard"
            | "release-keyboard"
            | "send-windows-key"
            | "send-ctrl-alt-delete"
    ) {
        let _ = app.emit("menu", id);
    } else if close::is_quit(id) {
        close::request(app);
    } else if id == "new-tab" || id == "close" {
        let focused = focused_window(app);
        match (
            id,
            close::route_close(focused.as_ref().map(tauri::WebviewWindow::label), TERMINAL),
        ) {
            (_, close::CloseRoute::TerminalTab) => {
                let _ = app.emit_to(
                    TERMINAL,
                    "terminal-menu",
                    if id == "new-tab" {
                        "new-tab"
                    } else {
                        "close-tab"
                    },
                );
            }
            ("close", close::CloseRoute::Viewer) => {
                close::request(app);
            }
            ("close", close::CloseRoute::Window) => {
                if let Some(w) = focused {
                    let _ = w.close();
                }
            }
            ("new-tab", _) => {
                let _ = app.emit_to("main", "menu", "new-terminal");
            }
            _ => {}
        }
    } else if id == "rename-window" {
        match focused_window(app) {
            Some(w) if w.label() == TERMINAL => {
                let _ = app.emit_to(TERMINAL, "terminal-menu", "rename-tab");
            }
            _ => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.unminimize();
                    let _ = main.show();
                    let _ = main.set_focus();
                }
                let _ = app.emit_to("main", "menu", "rename-window");
            }
        }
    } else if id == "checkpoints" {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
        let _ = app.emit_to("main", "menu", "checkpoints");
    } else if id == "check-updates" {
        check_for_update(app.clone(), true);
    }
}

#[expect(
    clippy::missing_panics_doc,
    reason = "run is the binary's entry point rather than an API, and its only panic is a startup failure the app cannot continue past"
)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sharing::default())
        .manage(Updating::default())
        .manage(close::CloseCoordinator::default())
        .manage(TerminalRequests::default())
        .manage(agent::Agents::default())
        .manage(events::AppStream::default())
        .menu(menu)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if close::closes_viewer(window.label()) && close::request(window.app_handle()) {
                    api.prevent_close();
                }
            }
            if let (WindowEvent::Destroyed, TERMINAL) = (event, window.label()) {
                if let Ok(mut queue) = window.state::<TerminalRequests>().0.lock() {
                    queue.clear();
                }
            }
        })
        .on_menu_event(|app, event| handle_menu(app, &event))
        .setup(|app| {
            let handle = app.handle().clone();
            terminate::settle_install(
                terminate::install(move |quit| close::should_terminate(&handle, quit)),
                terminate::Fatality::of_this_build(),
            )?;
            if let Some(main) = app.get_webview_window("main") {
                liveresize::watch(&main);
            }
            events::start(app.handle());
            if !cfg!(debug_assertions) {
                check_for_update(app.handle().clone(), false);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            winvm,
            install_cli,
            share_start,
            share_stop,
            downloads_dir,
            unused_path,
            reveal,
            terminal_open,
            terminal_take,
            agent::agent_fetch,
            checkpoints::checkpoint_image,
            usage::instance_usage,
            files_open,
            copy_text,
            read_text,
            home_dir,
            dragout::files_drag_out,
            trace,
            set_system_keyboard_capture,
            close::close_state,
            close::close_start,
            close::close_at,
            close::close_resolved,
            close::close_run,
            close::close_cancel,
            close::close_complete,
            events::events_state
        ])
        .build(tauri::generate_context!())
        .expect("winvm could not start")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                if close::request(app) {
                    api.prevent_exit();
                }
            }
            RunEvent::Exit => {
                let _ = system_keyboard_capture(false);
                stop_sharing(&app.state::<Sharing>());
                events::stop(app);
            }
            _ => {}
        });
}
