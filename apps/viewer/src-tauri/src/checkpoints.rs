//! What the checkpoints view needs from the app beyond `winvm saves`: a checkpoint's screenshot
//! bytes, and the person's settings for the view.
//!
//! Screenshots are files in a save's directory (`$WINVM_HOME/saves/<instance>/<save>/screen.png` and
//! `thumb.png`, written by `winvm save`), named by `winvm saves --json`. The page reads them through
//! `checkpoint_image` as raw bytes and shows them as blob: URLs, which the CSP already allows, so no
//! asset protocol (and no scope over the whole disk) is needed. Only those two file names, inside a
//! `saves/<instance>/<save>/` directory, are served.
//!
//! Settings live in `$XDG_CONFIG_HOME/winvm/settings.json` (default `~/.config/winvm/settings.json`),
//! the same path `packages/core/src/xdg.ts` gives the CLI. Each part of the app owns one top-level
//! key ("checkpoints"); a write replaces that key and keeps the rest.

use std::path::{Path, PathBuf};

const IMAGES: &[&str] = &["thumb.png", "screen.png"];
/// Far bigger than any framebuffer PNG (5120x2160 is the largest screen winvm allows).
const MAX_IMAGE_BYTES: u64 = 96 * 1024 * 1024;

/// Whether `path` names a checkpoint image: `…/saves/<instance>/<save>/{thumb,screen}.png`.
fn is_checkpoint_image(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !IMAGES.contains(&name) {
        return false;
    }
    let mut up = path.ancestors().skip(1);
    let (Some(save), Some(instance), Some(saves)) = (up.next(), up.next(), up.next()) else {
        return false;
    };
    let named = |p: &Path| p.file_name().and_then(|n| n.to_str()).map(str::to_owned);
    match (named(save), named(instance), named(saves)) {
        (Some(s), Some(i), Some(root)) => root == "saves" && !s.starts_with('.') && !i.starts_with('.'),
        _ => false,
    }
}

/// A checkpoint's screenshot or thumbnail, as raw PNG bytes.
#[tauri::command]
pub async fn checkpoint_image(path: String) -> Result<tauri::ipc::Response, String> {
    let real = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if !is_checkpoint_image(&real) {
        return Err(format!("not a checkpoint image: {path}"));
    }
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("not a checkpoint image: {path}"));
    }
    std::fs::read(&real).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// `$XDG_CONFIG_HOME/winvm`, or `~/.config/winvm`: a relative or empty XDG_CONFIG_HOME is ignored,
/// as the XDG Base Directory spec says.
fn config_dir(xdg: Option<String>, home: Option<String>) -> Option<PathBuf> {
    match xdg {
        Some(x) if Path::new(&x).is_absolute() => Some(Path::new(&x).join("winvm")),
        _ => home.filter(|h| !h.is_empty()).map(|h| Path::new(&h).join(".config").join("winvm")),
    }
}

fn settings_path() -> Result<PathBuf, String> {
    config_dir(std::env::var("XDG_CONFIG_HOME").ok(), std::env::var("HOME").ok())
        .map(|d| d.join("settings.json"))
        .ok_or_else(|| "no home directory".to_string())
}

fn read_settings(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// One part of the settings (`section`), or null when it has none.
#[tauri::command]
pub fn settings_read(section: String) -> Result<serde_json::Value, String> {
    Ok(read_settings(&settings_path()?).remove(&section).unwrap_or(serde_json::Value::Null))
}

/// Replaces one part of the settings, keeping the others; written whole to a temporary file and renamed.
fn write_section(path: &Path, section: &str, value: serde_json::Value) -> Result<(), String> {
    let mut all = read_settings(path);
    all.insert(section.to_owned(), value);
    let dir = path.parent().ok_or("settings have no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".settings.json.{}", std::process::id()));
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(all)).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, format!("{text}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_write(section: String, value: serde_json::Value) -> Result<(), String> {
    if section.is_empty() || section.len() > 64 {
        return Err("no settings section named".into());
    }
    write_section(&settings_path()?, &section, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_checkpoint_images() {
        assert!(is_checkpoint_image(Path::new("/h/saves/canvas-test/before/thumb.png")));
        assert!(is_checkpoint_image(Path::new("/h/saves/canvas-test/before/screen.png")));
        assert!(!is_checkpoint_image(Path::new("/h/saves/canvas-test/before/manifest.json")));
        assert!(!is_checkpoint_image(Path::new("/h/saves/canvas-test/before/vmstate.zst")));
        assert!(!is_checkpoint_image(Path::new("/h/instances/canvas-test/before/thumb.png")));
        assert!(!is_checkpoint_image(Path::new("/h/saves/canvas-test/.before.partial-1/thumb.png")));
        assert!(!is_checkpoint_image(Path::new("/thumb.png")));
        assert!(!is_checkpoint_image(Path::new("/Users/x/Pictures/thumb.png")));
    }

    #[test]
    fn honours_xdg_config_home_and_its_default() {
        assert_eq!(config_dir(Some("/x/cfg".into()), Some("/home/a".into())), Some(PathBuf::from("/x/cfg/winvm")));
        assert_eq!(config_dir(Some("relative".into()), Some("/home/a".into())), Some(PathBuf::from("/home/a/.config/winvm")));
        assert_eq!(config_dir(Some(String::new()), Some("/home/a".into())), Some(PathBuf::from("/home/a/.config/winvm")));
        assert_eq!(config_dir(None, Some("/home/a".into())), Some(PathBuf::from("/home/a/.config/winvm")));
        assert_eq!(config_dir(None, None), None);
    }

    #[test]
    fn writes_one_section_and_keeps_the_rest() {
        let dir = std::env::temp_dir().join(format!("winvm-settings-test-{}", std::process::id()));
        let path = dir.join("winvm").join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        write_section(&path, "other", serde_json::json!({ "keep": true })).unwrap();
        write_section(&path, "checkpoints", serde_json::json!({ "zoom": 1.5 })).unwrap();
        write_section(&path, "checkpoints", serde_json::json!({ "zoom": 0.5 })).unwrap();
        let all = read_settings(&path);
        assert_eq!(all.get("other"), Some(&serde_json::json!({ "keep": true })));
        assert_eq!(all.get("checkpoints"), Some(&serde_json::json!({ "zoom": 0.5 })));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
