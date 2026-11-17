#[derive(Clone, Copy, Debug)]
pub struct Spec {
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
}

pub const TERMINAL: Spec = Spec {
    width: 820.0,
    height: 520.0,
    min_width: 420.0,
    min_height: 240.0,
};

pub const FILES: Spec = Spec {
    width: 920.0,
    height: 560.0,
    min_width: 560.0,
    min_height: 340.0,
};

pub const TRAFFIC_LIGHTS: (f64, f64) = (18.0, 26.0);

pub const GAP_BESIDE_MAIN: f64 = 8.0;

#[cfg(test)]
const MAIN_MIN_WIDTH: f64 = 700.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

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

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1728.0,
        height: 1117.0,
    };

    #[test]
    fn opens_right_of_the_main_window_level_with_its_top() {
        let main = Rect {
            x: 100.0,
            y: 80.0,
            width: 700.0,
            height: 600.0,
        };
        assert_eq!(
            beside(main, SCREEN, TERMINAL),
            Some((100.0 + 700.0 + GAP_BESIDE_MAIN, 80.0))
        );
    }

    #[test]
    fn declines_when_the_screen_has_no_room_on_the_right() {
        let main = Rect {
            x: 400.0,
            y: 80.0,
            width: 1024.0,
            height: 816.0,
        };
        assert_eq!(beside(main, SCREEN, TERMINAL), None);
        let main = Rect {
            x: 0.0,
            y: 0.0,
            width: SCREEN.width - TERMINAL.width - GAP_BESIDE_MAIN,
            height: 600.0,
        };
        assert!(beside(main, SCREEN, TERMINAL).is_some());
    }

    #[test]
    fn moves_up_rather_than_hang_off_the_bottom() {
        let main = Rect {
            x: 0.0,
            y: 900.0,
            width: 600.0,
            height: 200.0,
        };
        assert_eq!(
            beside(main, SCREEN, FILES).map(|p| p.1),
            Some(1117.0 - FILES.height)
        );
    }

    #[test]
    fn works_on_a_screen_that_is_not_at_the_origin() {
        let screen = Rect {
            x: -1920.0,
            y: -200.0,
            width: 1920.0,
            height: 1080.0,
        };
        let main = Rect {
            x: -1900.0,
            y: -150.0,
            width: 820.0,
            height: 520.0,
        };
        assert_eq!(
            beside(main, screen, TERMINAL),
            Some((-1900.0 + 820.0 + GAP_BESIDE_MAIN, -150.0))
        );
        let low = Rect {
            x: -1900.0,
            y: 800.0,
            width: 600.0,
            height: 200.0,
        };
        assert_eq!(
            beside(low, screen, TERMINAL).map(|p| p.1),
            Some(-200.0 + 1080.0 - TERMINAL.height)
        );
    }

    #[test]
    fn traffic_lights_match_the_main_windows_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let main = &conf["app"]["windows"][0];
        assert_eq!(main["label"], "main");
        assert_eq!(
            main["trafficLightPosition"]["x"].as_f64(),
            Some(TRAFFIC_LIGHTS.0)
        );
        assert_eq!(
            main["trafficLightPosition"]["y"].as_f64(),
            Some(TRAFFIC_LIGHTS.1)
        );
    }

    #[test]
    fn defaults_are_not_below_minimums() {
        for spec in [TERMINAL, FILES] {
            assert!(
                spec.width >= spec.min_width && spec.height >= spec.min_height,
                "{spec:?}"
            );
        }
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let main = &conf["app"]["windows"][0];
        assert!(main["width"].as_f64() >= main["minWidth"].as_f64());
        assert!(main["height"].as_f64() >= main["minHeight"].as_f64());
        assert!(main["minWidth"].as_f64() >= Some(MAIN_MIN_WIDTH));
    }
}
