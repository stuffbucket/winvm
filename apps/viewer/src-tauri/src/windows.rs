//! Where the app's windows open and how small they may get: the numbers that were
//! scattered through `lib.rs`, in one place, each with its reason.
//!
//! EVERY NUMBER HERE IS LOGICAL (points on a Mac), never device pixels. Tauri's
//! window builder takes logical sizes and positions, so these are right on any
//! display; AppKit lays out in points and does the 2x (or 1x, or 1.5x) itself.
//! Only a *read* of a window (`outer_position`, `outer_size`, a monitor's size) is
//! physical, and each of those is converted back with `scale_factor()` of the
//! monitor it belongs to (see `beside`), never with a constant.
//!
//! The main window is not built here: its size, minimum and traffic-light inset are
//! in `tauri.conf.json` (window properties belong in config). `TRAFFIC_LIGHTS` below
//! repeats the inset for the windows built in code, and a test keeps the two equal.

/// Where a window opens and the least it may be. Content size, not frame: the title
/// bar is an overlay, so the two are the same on macOS.
#[derive(Clone, Copy, Debug)]
pub struct Spec {
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

/// The Terminal window. 820x520 is a shell's comfortable 100 columns by 30 rows at the
/// default font; the minimum keeps the tab strip (which is the title bar) and one line
/// of output legible.
pub const TERMINAL: Spec = Spec { width: 820.0, height: 520.0, min_width: 420.0, min_height: 240.0 };

/// A Files window: a sidebar and a list, wider than the Terminal because its columns
/// (name, kind, size, date) want the room. The minimum is what the sidebar plus a
/// name column need.
pub const FILES: Spec = Spec { width: 920.0, height: 560.0, min_width: 560.0, min_height: 340.0 };

/// Where the macOS traffic lights sit in a window with an overlay title bar: inset
/// from the window's top-left corner, so they centre on the 48-point toolbar the UI
/// draws there. Must equal `trafficLightPosition` in `tauri.conf.json` (tested) and
/// the UI's `--lights-clearance` (`ui/src/styles/theme.ts`) must clear them.
pub const TRAFFIC_LIGHTS: (f64, f64) = (18.0, 26.0);

/// The space left between the main window and one that opens beside it.
pub const GAP_BESIDE_MAIN: f64 = 8.0;

/// The least width at which the main window's toolbar fits its buttons and still shows a
/// machine's name (`apps/viewer/scripts/render-sizes.mjs` measures it: the toolbar's own
/// parts come to about 570 points, a name wants 120 more). `minWidth` in `tauri.conf.json`
/// is at or above it, which a test checks.
#[cfg(test)]
const MAIN_MIN_WIDTH: f64 = 700.0;

/// A screen's work area, a window's frame: logical points, in one global space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where a window of `spec`'s size goes to sit just right of `main`, level with its top,
/// when `screen` has room for it there; `None` when it doesn't (the caller centres it).
/// If the window would hang off the bottom of the screen it is moved up, not dropped.
pub fn beside(main: Rect, screen: Rect, spec: Spec) -> Option<(f64, f64)> {
    let x = main.x + main.width + GAP_BESIDE_MAIN;
    if x + spec.width > screen.x + screen.width {
        return None;
    }
    let lowest = screen.y + screen.height - spec.height;
    Some((x, main.y.min(lowest).max(screen.y)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { x: 0.0, y: 0.0, width: 1728.0, height: 1117.0 };

    #[test]
    fn opens_right_of_the_main_window_level_with_its_top() {
        let main = Rect { x: 100.0, y: 80.0, width: 700.0, height: 600.0 };
        assert_eq!(beside(main, SCREEN, TERMINAL), Some((100.0 + 700.0 + GAP_BESIDE_MAIN, 80.0)));
    }

    #[test]
    fn declines_when_the_screen_has_no_room_on_the_right() {
        let main = Rect { x: 400.0, y: 80.0, width: 1024.0, height: 816.0 };
        assert_eq!(beside(main, SCREEN, TERMINAL), None);
        // Exactly fitting is room.
        let main = Rect { x: 0.0, y: 0.0, width: SCREEN.width - TERMINAL.width - GAP_BESIDE_MAIN, height: 600.0 };
        assert!(beside(main, SCREEN, TERMINAL).is_some());
    }

    #[test]
    fn moves_up_rather_than_hang_off_the_bottom() {
        let main = Rect { x: 0.0, y: 900.0, width: 600.0, height: 200.0 };
        assert_eq!(beside(main, SCREEN, FILES).map(|p| p.1), Some(1117.0 - FILES.height));
    }

    #[test]
    fn works_on_a_screen_that_is_not_at_the_origin() {
        // A display to the left of the primary one has negative coordinates, and one above it too.
        let screen = Rect { x: -1920.0, y: -200.0, width: 1920.0, height: 1080.0 };
        let main = Rect { x: -1900.0, y: -150.0, width: 820.0, height: 520.0 };
        assert_eq!(beside(main, screen, TERMINAL), Some((-1900.0 + 820.0 + GAP_BESIDE_MAIN, -150.0)));
        let low = Rect { x: -1900.0, y: 800.0, width: 600.0, height: 200.0 };
        assert_eq!(beside(low, screen, TERMINAL).map(|p| p.1), Some(-200.0 + 1080.0 - TERMINAL.height));
    }

    /// The main window's config and the windows built in code must not drift apart.
    #[test]
    fn traffic_lights_match_the_main_windows_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let main = &conf["app"]["windows"][0];
        assert_eq!(main["label"], "main");
        assert_eq!(main["trafficLightPosition"]["x"].as_f64(), Some(TRAFFIC_LIGHTS.0));
        assert_eq!(main["trafficLightPosition"]["y"].as_f64(), Some(TRAFFIC_LIGHTS.1));
    }

    /// Every window opens at least as large as its own minimum, and the main one no smaller than the toolbar needs.
    #[test]
    fn defaults_are_not_below_minimums() {
        for spec in [TERMINAL, FILES] {
            assert!(spec.width >= spec.min_width && spec.height >= spec.min_height, "{spec:?}");
        }
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let main = &conf["app"]["windows"][0];
        assert!(main["width"].as_f64() >= main["minWidth"].as_f64());
        assert!(main["height"].as_f64() >= main["minHeight"].as_f64());
        // The toolbar (traffic lights, 12 buttons, a machine name) needs MAIN_MIN_WIDTH points.
        assert!(main["minWidth"].as_f64() >= Some(MAIN_MIN_WIDTH));
    }
}
