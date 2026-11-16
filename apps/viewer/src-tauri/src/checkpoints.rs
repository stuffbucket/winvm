use std::path::Path;

const IMAGES: &[&str] = &["thumb.png", "screen.png"];
const MAX_IMAGE_BYTES: u64 = 96 * 1024 * 1024;

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
}
