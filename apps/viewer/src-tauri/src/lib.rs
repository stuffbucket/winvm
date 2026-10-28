use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, HELP_SUBMENU_ID};
use tauri::{Emitter, Manager, RunEvent};
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
    "dir", "save", "load", "saves", "help",
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

/// The default menu, plus updates and the command line (app menu) and the command reference (Help).
fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
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
        .menu(menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "install-cli" || id == "reference" {
                let _ = app.emit("menu", id);
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
        .invoke_handler(tauri::generate_handler![winvm, install_cli, share_start, share_stop, downloads_dir, unused_path, reveal])
        .build(tauri::generate_context!())
        .expect("winvm could not start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_sharing(&app.state::<Sharing>());
            }
        });
}
