use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const MENU_ID: &str = "about";
const LABEL: &str = "about";
const WIDTH: f64 = 680.0;
const HEIGHT: f64 = 360.0;

const LINKS: &[&str] = &[
    "https://stuffbucket.github.io/winvm/",
    "https://github.com/stuffbucket/winvm",
    "https://github.com/stuffbucket",
];

pub fn replace_menu_item(
    app: &tauri::AppHandle,
    app_menu: &tauri::menu::Submenu<tauri::Wry>,
) -> tauri::Result<()> {
    let items = app_menu.items()?;
    let predefined = items.first().filter(|i| {
        i.as_predefined_menuitem()
            .is_some_and(|a| a.text().is_ok_and(|t| t.starts_with("About")))
    });
    if let Some(item) = predefined {
        app_menu.remove(item)?;
        let name = app.package_info().name.clone();
        app_menu.insert(
            &tauri::menu::MenuItem::with_id(
                app,
                MENU_ID,
                format!("About {name}"),
                true,
                None::<&str>,
            )?,
            0,
        )?;
    }
    Ok(())
}

pub fn is_menu(id: &str) -> bool {
    id == MENU_ID
}

pub fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let name = app.package_info().name.clone();
    let url = format!(
        "about.html?version={}",
        crate::query_value(&app.package_info().version.to_string())
    );
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
        .title(format!("About {name}"))
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .visible(false)
        .center();
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    match builder.build() {
        Ok(window) => hide_window_buttons(&window),
        Err(e) => eprintln!("about: the window didn't open: {e}"),
    }
}

#[cfg(target_os = "macos")]
fn hide_window_buttons(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(ns_window) = target.ns_window() else {
            return;
        };
        // SAFETY: tauri hands out the window's live NSWindow, and this runs on the main thread.
        let ns_window = unsafe { &*ns_window.cast::<NSWindow>() };
        for kind in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            if let Some(button) = ns_window.standardWindowButton(kind) {
                button.setHidden(true);
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn hide_window_buttons(_window: &tauri::WebviewWindow) {}

fn opens(url: &str) -> bool {
    LINKS.contains(&url)
}

#[tauri::command]
pub fn open_link(url: &str) -> Result<(), String> {
    if !opens(url) {
        return Err(format!("not a link this app opens: {url}"));
    }
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn cli_link(home: &Path) -> PathBuf {
    home.join(".local").join("bin").join("winvm")
}

fn installed_in(home: &Path) -> Option<String> {
    let link = cli_link(home);
    if !link.is_file() {
        return None;
    }
    Some(format!("~/{}", link.strip_prefix(home).ok()?.display()))
}

#[tauri::command]
pub fn installed_cli() -> Option<String> {
    installed_in(Path::new(&std::env::var("HOME").ok()?))
}

#[cfg(test)]
mod tests {
    use super::{installed_in, opens, LINKS};

    #[test]
    fn opens_only_the_about_windows_own_links() {
        for url in LINKS {
            assert!(opens(url), "{url}");
        }
        for url in [
            "https://github.com/stuffbucket/winvm/../evil",
            "https://github.com/stuffbucket/winvm ",
            "http://github.com/stuffbucket/winvm",
            "file:///etc/passwd",
            "/Applications/Calculator.app",
            "-a Calculator",
            "",
        ] {
            assert!(!opens(url), "{url}");
        }
    }

    #[test]
    fn says_where_the_command_line_tool_is_only_when_it_is_there() {
        let home = std::env::temp_dir().join(format!("winvm-about-{}", std::process::id()));
        let bin = home.join(".local").join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        assert_eq!(installed_in(&home), None);
        std::os::unix::fs::symlink(home.join("gone"), bin.join("winvm")).expect("link");
        assert_eq!(installed_in(&home), None);
        std::fs::write(home.join("gone"), "").expect("target");
        assert_eq!(installed_in(&home).as_deref(), Some("~/.local/bin/winvm"));
        std::fs::remove_dir_all(&home).expect("clean up");
    }
}
