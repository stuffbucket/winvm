use serde::Serialize;
use std::path::Path;
use tauri_plugin_shell::ShellExt;

#[derive(Serialize)]
struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

const VERBS: &[&str] = &["status", "doctor", "start", "stop", "reboot", "pause", "resume", "kill", "open", "setup"];

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![winvm, install_cli])
        .run(tauri::generate_context!())
        .expect("winvm could not start");
}
