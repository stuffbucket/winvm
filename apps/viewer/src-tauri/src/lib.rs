use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

const VERBS: &[&str] = &[
    "status", "doctor", "start", "stop", "reboot", "pause", "resume", "kill", "open", "setup", "exec", "put", "get",
    "dir", "save", "load", "saves", "help", "terminal", "config",
];

#[tauri::command]
async fn winvm(app: tauri::AppHandle, args: Vec<String>) -> Result<Output, String> {
    match args.first() {
        Some(verb) if VERBS.contains(&verb.as_str()) => {}
        _ => return Err(format!("not a winvm command this app runs: {:?}", args.first())),
    }
    let out = app
        .shell()
        .sidecar("winvm")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(Output {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// The `winvm cua serve` this app started, while the screen is shared with an agent.
#[derive(Default)]
struct Sharing(Mutex<Option<CommandChild>>);

fn stop_sharing(sharing: &Sharing) {
    if let Some(child) = sharing.0.lock().map(|mut c| c.take()).unwrap_or(None) {
        // SIGTERM, so the server removes its cua.json; CommandChild::kill is SIGKILL.
        let _ = std::process::Command::new("/bin/kill").arg(child.pid().to_string()).status();
    }
}

/// Starts `winvm cua serve` and returns what it printed once it is listening (or what it said before exiting).
#[tauri::command]
async fn share_start(app: tauri::AppHandle, instance: String) -> Result<Output, String> {
    let sharing = app.state::<Sharing>();
    stop_sharing(&sharing);
    let (mut rx, child) = app
        .shell()
        .sidecar("winvm")
        .map_err(|e| e.to_string())?
        .args(["cua", "serve", "-i", instance.as_str()])
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut code = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout.push_str(&String::from_utf8_lossy(&line));
                stdout.push('\n');
                if stdout.contains("  token ") {
                    break;
                }
            }
            CommandEvent::Stderr(line) => {
                stderr.push_str(&String::from_utf8_lossy(&line));
                stderr.push('\n');
            }
            CommandEvent::Terminated(t) => {
                code = Some(t.code.unwrap_or(-1));
                break;
            }
            _ => {}
        }
    }
    match code {
        Some(code) => Ok(Output { code, stdout, stderr }),
        None => {
            *sharing.0.lock().map_err(|e| e.to_string())? = Some(child);
            Ok(Output { code: 0, stdout, stderr })
        }
    }
}

#[tauri::command]
fn share_stop(app: tauri::AppHandle) {
    stop_sharing(&app.state::<Sharing>());
}

const TERMINAL: &str = "terminal";
const SHELLS: &[&str] = &["pwsh", "powershell", "cmd"];

/// One tab the Terminal window should open: a shell in an instance, started in `cwd` (home when absent),
/// with the shells that instance has when the main window already asked, and the instance's title.
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

/// Tabs asked for and not yet taken by the Terminal window, which may still be loading.
#[derive(Default)]
struct TerminalRequests(Mutex<Vec<TerminalRequest>>);

/// Brings the Terminal window forward, or opens it beside the main window.
fn show_terminal(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TERMINAL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return app.emit_to(TERMINAL, "terminal-open", ()).map_err(|e| e.to_string());
    }
    let mut builder = WebviewWindowBuilder::new(app, TERMINAL, WebviewUrl::App("terminal.html".into()))
        .title("Terminal")
        .inner_size(820.0, 520.0)
        .min_inner_size(420.0, 240.0)
        .visible(false);
    // Tabs in the title bar, beside traffic lights where the main window has them (tauri.conf.json).
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

/// Just right of the main window, when the screen has room for `width` there.
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
    app.state::<TerminalRequests>().0.lock().map_err(|e| e.to_string())?.push(request);
    show_terminal(&app)
}

#[tauri::command]
fn terminal_take(app: tauri::AppHandle) -> Vec<TerminalRequest> {
    app.state::<TerminalRequests>().0.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
}

/// The window with keyboard focus, if any of the app's has it.
fn focused_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
}

#[tauri::command]
fn downloads_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(Path::new(&home).join("Downloads").display().to_string())
}

/// `dir/name`, or Finder's "name 2", "name 3"... when that is taken, so a copy never replaces a Mac file.
#[tauri::command]
fn unused_path(dir: String, name: String, folder: bool) -> String {
    let dir = Path::new(&dir);
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !folder => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    let mut path = dir.join(&name);
    let mut n = 2;
    while path.symlink_metadata().is_ok() {
        path = dir.join(format!("{stem} {n}{ext}"));
        n += 1;
    }
    path.display().to_string()
}

/// Shows a file or folder in Finder, selected.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&path).status().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn install_cli() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let cli = exe.parent().ok_or("the app has no Contents/MacOS directory")?.join("winvm");
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let bin = Path::new(&home).join(".local").join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let link = bin.join("winvm");
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(&link).map_err(|e| e.to_string())?,
        Ok(_) => return Err(format!("{} exists and is not a link, so it was left alone", link.display())),
        Err(_) => {}
    }
    std::os::unix::fs::symlink(&cli, &link).map_err(|e| e.to_string())?;
    Ok(link.display().to_string())
}

/// Set while an update check or install is running, so a second one waits its turn.
#[derive(Default)]
struct Updating(AtomicBool);

/// Checks the release's latest.json for a newer signed winvm and offers to install it.
/// `asked`: the person chose Check for Updates, so say when there is nothing new or the check failed.
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
                    let done = tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {}));
                    match done {
                        Ok(()) => {
                            stop_sharing(&app.state::<Sharing>());
                            app.restart();
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
                    .message(format!("winvm {} is the latest version.", app.package_info().version))
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

/// The default menu, plus updates and the command line (app menu), terminal tabs (File) and the
/// command reference (Help). File's New Terminal Tab and Close act on the Terminal window's tabs when
/// it is in front, so Cmd-T and Cmd-W are tab keys there and window keys elsewhere.
fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let new_tab = MenuItem::with_id(app, "new-tab", "New Terminal Tab", true, Some("CmdOrCtrl+T"))?;
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
        file.append_items(&[&new_tab, &PredefinedMenuItem::separator(app)?, &close])?;
    }
    // The Window menu's own Close Window (after a separator) would take Cmd-W back from File's Close.
    // Rename Window… names the instance (main window) or the active tab (Terminal).
    let rename = MenuItem::with_id(app, "rename-window", "Rename Window…", true, None::<&str>)?;
    if let Some(window) = menu.get(WINDOW_SUBMENU_ID).and_then(|i| i.as_submenu().cloned()) {
        if window.items()?.len() == 4 {
            window.remove_at(3)?;
            window.remove_at(2)?;
        }
        window.append_items(&[&PredefinedMenuItem::separator(app)?, &rename])?;
    }
    let updates = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
    let install = MenuItem::with_id(app, "install-cli", "Install Command Line Tool…", true, None::<&str>)?;
    let reference = MenuItem::with_id(app, "reference", "winvm Command Reference", true, Some("CmdOrCtrl+Shift+/"))?;
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        app_menu.insert_items(&[&install, &PredefinedMenuItem::separator(app)?], 2)?;
        app_menu.insert(&updates, 1)?;
    }
    if let Some(help) = menu.get(HELP_SUBMENU_ID).and_then(|i| i.as_submenu().cloned()) {
        help.append(&reference)?;
    }
    Ok(menu)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sharing::default())
        .manage(Updating::default())
        .manage(TerminalRequests::default())
        .menu(menu)
        .on_window_event(|window, event| {
            // Tabs asked for and never taken die with the window, rather than open in the next one.
            if let (WindowEvent::Destroyed, TERMINAL) = (event, window.label()) {
                if let Ok(mut queue) = window.state::<TerminalRequests>().0.lock() {
                    queue.clear();
                }
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "install-cli" || id == "reference" {
                let _ = app.emit("menu", id);
            } else if id == "new-tab" || id == "close" {
                match focused_window(app) {
                    Some(w) if w.label() == TERMINAL => {
                        let _ = app.emit_to(TERMINAL, "terminal-menu", if id == "new-tab" { "new-tab" } else { "close-tab" });
                    }
                    Some(w) if id == "close" => {
                        let _ = w.close();
                    }
                    _ if id == "new-tab" => {
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
            } else if id == "check-updates" {
                check_for_update(app.clone(), true);
            }
        })
        .setup(|app| {
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
            terminal_take
        ])
        .build(tauri::generate_context!())
        .expect("winvm could not start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_sharing(&app.state::<Sharing>());
            }
        });
}
