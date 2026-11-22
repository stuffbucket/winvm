use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stroke {
    Down,
    Up,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Forward {
    pub code: &'static str,
    pub down: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Swallow(Option<Forward>),
}

const KEYCODES: usize = 256;

pub struct Filter {
    held: [bool; KEYCODES],
}

impl Default for Filter {
    fn default() -> Self {
        Self {
            held: [false; KEYCODES],
        }
    }
}

impl Filter {
    pub fn decide(&mut self, armed: bool, stroke: Stroke, keycode: u16, chorded: bool) -> Verdict {
        if !armed {
            self.reset();
            return Verdict::Pass;
        }
        let Some(held) = self.held.get_mut(usize::from(keycode)) else {
            return Verdict::Pass;
        };
        let down = match stroke {
            Stroke::Down if *held || intercepts(keycode, chorded) => true,
            Stroke::Up if *held => false,
            Stroke::Down | Stroke::Up => return Verdict::Pass,
        };
        *held = down;
        Verdict::Swallow(dom_code(keycode).map(|code| Forward { code, down }))
    }

    pub fn reset(&mut self) {
        self.held = [false; KEYCODES];
    }
}

pub fn intercepts(keycode: u16, chorded: bool) -> bool {
    chorded || is_function_key(keycode) || is_system_key(keycode)
}

fn is_function_key(keycode: u16) -> bool {
    dom_code(keycode).is_some_and(|code| {
        code.strip_prefix('F')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    })
}

const MISSION_CONTROL: u16 = 0xa0;
const LAUNCHPAD: u16 = 0x83;
const DICTATION: u16 = 0xb0;
const SPOTLIGHT: u16 = 0xb1;
const DO_NOT_DISTURB: u16 = 0xb2;

fn is_system_key(keycode: u16) -> bool {
    matches!(
        keycode,
        MISSION_CONTROL | LAUNCHPAD | DICTATION | SPOTLIGHT | DO_NOT_DISTURB
    )
}

const CODES: &[(u16, &str)] = &[
    (0x00, "KeyA"),
    (0x01, "KeyS"),
    (0x02, "KeyD"),
    (0x03, "KeyF"),
    (0x04, "KeyH"),
    (0x05, "KeyG"),
    (0x06, "KeyZ"),
    (0x07, "KeyX"),
    (0x08, "KeyC"),
    (0x09, "KeyV"),
    (0x0a, "IntlBackslash"),
    (0x0b, "KeyB"),
    (0x0c, "KeyQ"),
    (0x0d, "KeyW"),
    (0x0e, "KeyE"),
    (0x0f, "KeyR"),
    (0x10, "KeyY"),
    (0x11, "KeyT"),
    (0x12, "Digit1"),
    (0x13, "Digit2"),
    (0x14, "Digit3"),
    (0x15, "Digit4"),
    (0x16, "Digit6"),
    (0x17, "Digit5"),
    (0x18, "Equal"),
    (0x19, "Digit9"),
    (0x1a, "Digit7"),
    (0x1b, "Minus"),
    (0x1c, "Digit8"),
    (0x1d, "Digit0"),
    (0x1e, "BracketRight"),
    (0x1f, "KeyO"),
    (0x20, "KeyU"),
    (0x21, "BracketLeft"),
    (0x22, "KeyI"),
    (0x23, "KeyP"),
    (0x24, "Enter"),
    (0x25, "KeyL"),
    (0x26, "KeyJ"),
    (0x27, "Quote"),
    (0x28, "KeyK"),
    (0x29, "Semicolon"),
    (0x2a, "Backslash"),
    (0x2b, "Comma"),
    (0x2c, "Slash"),
    (0x2d, "KeyN"),
    (0x2e, "KeyM"),
    (0x2f, "Period"),
    (0x30, "Tab"),
    (0x31, "Space"),
    (0x32, "Backquote"),
    (0x33, "Backspace"),
    (0x35, "Escape"),
    (0x40, "F17"),
    (0x41, "NumpadDecimal"),
    (0x43, "NumpadMultiply"),
    (0x45, "NumpadAdd"),
    (0x47, "NumLock"),
    (0x4b, "NumpadDivide"),
    (0x4c, "NumpadEnter"),
    (0x4e, "NumpadSubtract"),
    (0x4f, "F18"),
    (0x50, "F19"),
    (0x51, "NumpadEqual"),
    (0x52, "Numpad0"),
    (0x53, "Numpad1"),
    (0x54, "Numpad2"),
    (0x55, "Numpad3"),
    (0x56, "Numpad4"),
    (0x57, "Numpad5"),
    (0x58, "Numpad6"),
    (0x59, "Numpad7"),
    (0x5a, "F20"),
    (0x5b, "Numpad8"),
    (0x5c, "Numpad9"),
    (0x5d, "IntlYen"),
    (0x5e, "IntlRo"),
    (0x5f, "NumpadComma"),
    (0x60, "F5"),
    (0x61, "F6"),
    (0x62, "F7"),
    (0x63, "F3"),
    (0x64, "F8"),
    (0x65, "F9"),
    (0x66, "Lang2"),
    (0x67, "F11"),
    (0x68, "Lang1"),
    (0x69, "F13"),
    (0x6a, "F16"),
    (0x6b, "F14"),
    (0x6d, "F10"),
    (0x6e, "ContextMenu"),
    (0x6f, "F12"),
    (0x71, "F15"),
    (0x72, "Insert"),
    (0x73, "Home"),
    (0x74, "PageUp"),
    (0x75, "Delete"),
    (0x76, "F4"),
    (0x77, "End"),
    (0x78, "F2"),
    (0x79, "PageDown"),
    (0x7a, "F1"),
    (0x7b, "ArrowLeft"),
    (0x7c, "ArrowRight"),
    (0x7d, "ArrowDown"),
    (0x7e, "ArrowUp"),
];

pub fn dom_code(keycode: u16) -> Option<&'static str> {
    CODES
        .iter()
        .find(|(key, _)| *key == keycode)
        .map(|(_, code)| *code)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemKeys {
    Allowed,
    NeedsPermission,
    Unavailable,
}

pub trait Switch: Send {
    fn set(&self, armed: bool);
}

pub trait Host {
    fn trusted(&self) -> bool;
    fn start(&self) -> Option<Box<dyn Switch>>;
}

#[derive(Default)]
pub struct Control {
    seq: u64,
    tap: Option<Box<dyn Switch>>,
    failed: bool,
}

impl Control {
    pub fn request(&mut self, host: &dyn Host, seq: u64, armed: bool) -> SystemKeys {
        if seq < self.seq {
            return self.status(host);
        }
        self.seq = seq;
        if !armed {
            self.release();
            return self.status(host);
        }
        if !host.trusted() {
            self.release();
            return SystemKeys::NeedsPermission;
        }
        if self.tap.is_none() {
            self.tap = host.start();
        }
        self.failed = self.tap.is_none();
        match &self.tap {
            Some(tap) => {
                tap.set(true);
                SystemKeys::Allowed
            }
            None => SystemKeys::Unavailable,
        }
    }

    pub fn release(&mut self) {
        if let Some(tap) = &self.tap {
            tap.set(false);
        }
    }

    pub fn status(&self, host: &dyn Host) -> SystemKeys {
        if !host.trusted() {
            SystemKeys::NeedsPermission
        } else if self.failed {
            SystemKeys::Unavailable
        } else {
            SystemKeys::Allowed
        }
    }
}

pub struct KeyTap {
    control: Mutex<Control>,
    host: platform::Platform,
}

impl KeyTap {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            control: Mutex::new(Control::default()),
            host: platform::Platform::new(app),
        }
    }

    pub fn release(&self) {
        if let Ok(mut control) = self.control.lock() {
            control.release();
        }
    }
}

pub const WINDOW: &str = "main";
const EVENT: &str = "system-key";

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects the window and state by value; a command cannot take references to them"
)]
pub fn system_keys(
    window: WebviewWindow,
    state: tauri::State<'_, KeyTap>,
    armed: bool,
    seq: u64,
) -> Result<SystemKeys, String> {
    let focused = window.label() == WINDOW && window.is_focused().unwrap_or(false);
    let mut control = state.control.lock().map_err(|e| e.to_string())?;
    Ok(control.request(&state.host, seq, armed && focused))
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects the state by value; a command cannot take a reference to it"
)]
pub fn system_keys_status(state: tauri::State<'_, KeyTap>) -> Result<SystemKeys, String> {
    let control = state.control.lock().map_err(|e| e.to_string())?;
    Ok(control.status(&state.host))
}

#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    platform::open_accessibility_settings()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Filter, Forward, Host, Stroke, Switch, Verdict, EVENT, WINDOW};
    use objc2_core_foundation::{
        kCFBooleanTrue, kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFBoolean, CFDictionary,
        CFMachPort, CFRetained, CFRunLoop, CFString,
    };
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventTapProxy, CGEventType,
    };
    use std::cell::{OnceCell, RefCell};
    use std::ffi::c_void;
    use std::ptr::{self, NonNull};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use tauri::{AppHandle, Emitter};

    const SLICE_SECONDS: f64 = 0.1;
    const ACCESSIBILITY_PANE: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: Option<&CFDictionary>) -> bool;
        static kAXTrustedCheckOptionPrompt: &'static CFString;
    }

    pub struct Platform {
        app: AppHandle,
    }

    impl Platform {
        pub fn new(app: &AppHandle) -> Self {
            Self { app: app.clone() }
        }
    }

    impl Host for Platform {
        fn trusted(&self) -> bool {
            // SAFETY: AXIsProcessTrusted takes no arguments and only reads this process's TCC state.
            unsafe { AXIsProcessTrusted() }
        }

        fn start(&self) -> Option<Box<dyn Switch>> {
            start(self.app.clone()).map(|tap| Box::new(tap) as Box<dyn Switch>)
        }
    }

    pub fn open_accessibility_settings() -> Result<(), String> {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSString, NSURL};

        // SAFETY: kAXTrustedCheckOptionPrompt is an immutable CFString constant; kCFBooleanTrue likewise.
        let prompt = unsafe { kAXTrustedCheckOptionPrompt };
        // SAFETY: as above, a static constant of the CoreFoundation framework.
        let yes: &CFBoolean = unsafe { kCFBooleanTrue }.ok_or("CoreFoundation has no true")?;
        let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[prompt], &[yes]);
        // SAFETY: the dictionary holds the one documented key with a CFBoolean value.
        if unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) } {
            return Ok(());
        }
        let url = NSURL::URLWithString(&NSString::from_str(ACCESSIBILITY_PANE))
            .ok_or("System Settings has no Accessibility pane")?;
        if NSWorkspace::sharedWorkspace().openURL(&url) {
            Ok(())
        } else {
            Err("Couldn't open System Settings".into())
        }
    }

    struct Tap {
        armed: Arc<AtomicBool>,
        wake: mpsc::Sender<()>,
    }

    impl Switch for Tap {
        fn set(&self, armed: bool) {
            if self.armed.swap(armed, Ordering::SeqCst) != armed && armed {
                let _ = self.wake.send(());
            }
        }
    }

    struct Context {
        armed: Arc<AtomicBool>,
        filter: RefCell<Filter>,
        keys: mpsc::Sender<Forward>,
        port: OnceCell<CFRetained<CFMachPort>>,
    }

    fn start(app: AppHandle) -> Option<Tap> {
        let armed = Arc::new(AtomicBool::new(false));
        let (wake, woken) = mpsc::channel::<()>();
        let (keys, forwarded) = mpsc::channel::<Forward>();
        let (ready, started) = mpsc::channel::<bool>();
        let flag = Arc::clone(&armed);
        thread::Builder::new()
            .name("winvm-key-forward".into())
            .spawn(move || {
                for key in forwarded {
                    let _ = app.emit_to(WINDOW, EVENT, key);
                }
            })
            .ok()?;
        thread::Builder::new()
            .name("winvm-key-tap".into())
            .spawn(move || run(flag, keys, &woken, &ready))
            .ok()?;
        if started.recv().unwrap_or(false) {
            Some(Tap { armed, wake })
        } else {
            None
        }
    }

    fn run(
        armed: Arc<AtomicBool>,
        keys: mpsc::Sender<Forward>,
        woken: &mpsc::Receiver<()>,
        ready: &mpsc::Sender<bool>,
    ) {
        let context: &'static Context = Box::leak(Box::new(Context {
            armed,
            filter: RefCell::new(Filter::default()),
            keys,
            port: OnceCell::new(),
        }));
        let mask = (1u64 << CGEventType::KeyDown.0) | (1u64 << CGEventType::KeyUp.0);
        // SAFETY: the callback matches CGEventTapCallBack and the context outlives the tap (it is leaked).
        let port = unsafe {
            CGEvent::tap_create(
                CGEventTapLocation::HIDEventTap,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::Default,
                mask,
                Some(callback),
                ptr::from_ref(context).cast_mut().cast(),
            )
        };
        let Some(port) = port else {
            let _ = ready.send(false);
            return;
        };
        CGEvent::tap_enable(&port, false);
        let Some(source) = CFMachPort::new_run_loop_source(None, Some(&port), 0) else {
            let _ = ready.send(false);
            return;
        };
        let Some(run_loop) = CFRunLoop::current() else {
            let _ = ready.send(false);
            return;
        };
        // SAFETY: kCFRunLoopCommonModes is an immutable CoreFoundation constant.
        run_loop.add_source(Some(&source), unsafe { kCFRunLoopCommonModes });
        let port = context.port.get_or_init(|| port);
        let _ = ready.send(true);
        while woken.recv().is_ok() {
            while context.armed.load(Ordering::SeqCst) {
                if !CGEvent::tap_is_enabled(port) {
                    CGEvent::tap_enable(port, true);
                }
                // SAFETY: kCFRunLoopDefaultMode is an immutable CoreFoundation constant.
                CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, SLICE_SECONDS, false);
            }
            CGEvent::tap_enable(port, false);
            if let Ok(mut filter) = context.filter.try_borrow_mut() {
                filter.reset();
            }
        }
    }

    pub fn chorded(flags: CGEventFlags) -> bool {
        flags.intersects(
            CGEventFlags::MaskCommand
                | CGEventFlags::MaskControl
                | CGEventFlags::MaskAlternate
                | CGEventFlags::MaskSecondaryFn,
        )
    }

    unsafe extern "C-unwind" fn callback(
        _proxy: CGEventTapProxy,
        kind: CGEventType,
        event: NonNull<CGEvent>,
        info: *mut c_void,
    ) -> *mut CGEvent {
        // SAFETY: info is the leaked Context of the tap thread, the only thread that runs this callback.
        let context = unsafe { &*info.cast::<Context>().cast_const() };
        let pass = event.as_ptr();
        let armed = context.armed.load(Ordering::SeqCst);
        if kind == CGEventType::TapDisabledByTimeout || kind == CGEventType::TapDisabledByUserInput
        {
            if let (true, Some(port)) = (armed, context.port.get()) {
                CGEvent::tap_enable(port, true);
            }
            return pass;
        }
        let stroke = match kind {
            CGEventType::KeyDown => Stroke::Down,
            CGEventType::KeyUp => Stroke::Up,
            _ => return pass,
        };
        // SAFETY: the event stays valid for the duration of the callback.
        let event = unsafe { event.as_ref() };
        let keycode = CGEvent::integer_value_field(Some(event), CGEventField::KeyboardEventKeycode);
        let flags = CGEvent::flags(Some(event));
        let Ok(mut filter) = context.filter.try_borrow_mut() else {
            return pass;
        };
        match filter.decide(
            armed,
            stroke,
            u16::try_from(keycode).unwrap_or(u16::MAX),
            chorded(flags),
        ) {
            Verdict::Pass => pass,
            Verdict::Swallow(forward) => {
                if let Some(key) = forward {
                    let _ = context.keys.send(key);
                }
                ptr::null_mut()
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod chord_tests {
    use super::platform::chorded;
    use objc2_core_graphics::CGEventFlags;

    #[test]
    fn command_control_option_and_fn_make_a_chord() {
        for flag in [
            CGEventFlags::MaskCommand,
            CGEventFlags::MaskControl,
            CGEventFlags::MaskAlternate,
            CGEventFlags::MaskSecondaryFn,
        ] {
            assert!(chorded(flag | CGEventFlags::MaskShift));
        }
    }

    #[test]
    fn shift_and_caps_lock_alone_do_not() {
        assert!(!chorded(CGEventFlags::empty()));
        assert!(!chorded(
            CGEventFlags::MaskShift | CGEventFlags::MaskAlphaShift
        ));
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{Host, Switch};
    use tauri::AppHandle;

    pub struct Platform;

    impl Platform {
        pub fn new(_app: &AppHandle) -> Self {
            Self
        }
    }

    impl Host for Platform {
        fn trusted(&self) -> bool {
            false
        }

        fn start(&self) -> Option<Box<dyn Switch>> {
            None
        }
    }

    pub fn open_accessibility_settings() -> Result<(), String> {
        Err("system shortcuts are captured on macOS only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    const TAB: u16 = 0x30;
    const SPACE: u16 = 0x31;
    const KEY_A: u16 = 0x00;
    const DIGIT_3: u16 = 0x14;
    const ARROW_UP: u16 = 0x7e;
    const F11: u16 = 0x67;
    const ESCAPE: u16 = 0x35;

    fn forward(code: &'static str, down: bool) -> Verdict {
        Verdict::Swallow(Some(Forward { code, down }))
    }

    #[test]
    fn intercepts_the_system_shortcuts() {
        for key in [TAB, SPACE, DIGIT_3, ESCAPE, ARROW_UP, KEY_A] {
            assert!(intercepts(key, true), "{key:#x}");
        }
        assert!(intercepts(F11, false));
        assert!(intercepts(MISSION_CONTROL, false));
        assert!(intercepts(LAUNCHPAD, false));
        assert!(intercepts(SPOTLIGHT, false));
    }

    #[test]
    fn leaves_plain_typing_to_the_webview() {
        assert!(!intercepts(KEY_A, false));
        assert!(!intercepts(TAB, false));
        assert!(!intercepts(SPACE, false));
        assert!(!intercepts(ESCAPE, false));
        assert!(!intercepts(DIGIT_3, false));
    }

    #[test]
    fn swallows_command_tab_and_forwards_both_edges() {
        let mut filter = Filter::default();
        assert_eq!(
            filter.decide(true, Stroke::Down, TAB, true),
            forward("Tab", true)
        );
        assert_eq!(
            filter.decide(true, Stroke::Down, TAB, true),
            forward("Tab", true)
        );
        assert_eq!(
            filter.decide(true, Stroke::Up, TAB, true),
            forward("Tab", false)
        );
    }

    #[test]
    fn keeps_swallowing_a_key_whose_down_it_took_after_the_modifier_lifts() {
        let mut filter = Filter::default();
        filter.decide(true, Stroke::Down, TAB, true);
        assert_eq!(
            filter.decide(true, Stroke::Down, TAB, false),
            forward("Tab", true)
        );
        assert_eq!(
            filter.decide(true, Stroke::Up, TAB, false),
            forward("Tab", false)
        );
        assert_eq!(filter.decide(true, Stroke::Up, TAB, false), Verdict::Pass);
    }

    #[test]
    fn passes_the_up_of_a_key_that_went_down_through_the_webview() {
        let mut filter = Filter::default();
        assert_eq!(filter.decide(true, Stroke::Down, TAB, false), Verdict::Pass);
        assert_eq!(filter.decide(true, Stroke::Up, TAB, true), Verdict::Pass);
    }

    #[test]
    fn passes_everything_and_forgets_held_keys_once_disarmed() {
        let mut filter = Filter::default();
        filter.decide(true, Stroke::Down, TAB, true);
        assert_eq!(
            filter.decide(false, Stroke::Down, SPACE, true),
            Verdict::Pass
        );
        assert_eq!(filter.decide(false, Stroke::Up, TAB, true), Verdict::Pass);
        assert_eq!(filter.decide(true, Stroke::Up, TAB, false), Verdict::Pass);
    }

    #[test]
    fn swallows_apple_function_keys_without_forwarding_them() {
        let mut filter = Filter::default();
        assert_eq!(
            filter.decide(true, Stroke::Down, MISSION_CONTROL, false),
            Verdict::Swallow(None)
        );
        assert_eq!(
            filter.decide(true, Stroke::Up, MISSION_CONTROL, false),
            Verdict::Swallow(None)
        );
    }

    #[test]
    fn passes_keycodes_outside_the_table() {
        let mut filter = Filter::default();
        assert_eq!(
            filter.decide(true, Stroke::Down, 0x1000, true),
            Verdict::Pass
        );
    }

    #[test]
    fn maps_every_function_key_to_its_code() {
        let codes: Vec<&str> = (0..=u16::MAX)
            .filter(|&k| is_function_key(k))
            .filter_map(dom_code)
            .collect();
        for n in 1..=20 {
            assert!(codes.contains(&format!("F{n}").as_str()), "F{n}");
        }
        assert_eq!(codes.len(), 20);
    }

    #[derive(Default)]
    struct Fake {
        trusted: Cell<bool>,
        startable: Cell<bool>,
        starts: Rc<Cell<usize>>,
        armed: Arc<AtomicBool>,
        sets: Arc<AtomicUsize>,
    }

    struct FakeSwitch {
        armed: Arc<AtomicBool>,
        sets: Arc<AtomicUsize>,
    }

    impl Switch for FakeSwitch {
        fn set(&self, armed: bool) {
            self.armed.store(armed, Ordering::SeqCst);
            self.sets.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl Host for Fake {
        fn trusted(&self) -> bool {
            self.trusted.get()
        }

        fn start(&self) -> Option<Box<dyn Switch>> {
            self.starts.set(self.starts.get() + 1);
            self.startable.get().then(|| {
                Box::new(FakeSwitch {
                    armed: Arc::clone(&self.armed),
                    sets: Arc::clone(&self.sets),
                }) as Box<dyn Switch>
            })
        }
    }

    fn host(trusted: bool, startable: bool) -> Fake {
        let fake = Fake::default();
        fake.trusted.set(trusted);
        fake.startable.set(startable);
        fake
    }

    #[test]
    fn asks_for_permission_without_creating_a_tap() {
        let fake = host(false, true);
        let mut control = Control::default();
        assert_eq!(control.request(&fake, 1, true), SystemKeys::NeedsPermission);
        assert_eq!(fake.starts.get(), 0);
        assert_eq!(control.status(&fake), SystemKeys::NeedsPermission);
    }

    #[test]
    fn creates_the_tap_once_and_arms_it_only_while_asked() {
        let fake = host(true, true);
        let mut control = Control::default();
        assert_eq!(control.request(&fake, 1, true), SystemKeys::Allowed);
        assert!(fake.armed.load(Ordering::SeqCst));
        assert_eq!(control.request(&fake, 2, false), SystemKeys::Allowed);
        assert!(!fake.armed.load(Ordering::SeqCst));
        assert_eq!(control.request(&fake, 3, true), SystemKeys::Allowed);
        assert!(fake.armed.load(Ordering::SeqCst));
        assert_eq!(fake.starts.get(), 1);
        control.release();
        assert!(!fake.armed.load(Ordering::SeqCst));
    }

    #[test]
    fn ignores_a_request_older_than_the_last() {
        let fake = host(true, true);
        let mut control = Control::default();
        control.request(&fake, 2, false);
        control.request(&fake, 1, true);
        assert!(!fake.armed.load(Ordering::SeqCst));
        assert_eq!(fake.starts.get(), 0);
    }

    #[test]
    fn disarms_when_permission_is_withdrawn() {
        let fake = host(true, true);
        let mut control = Control::default();
        control.request(&fake, 1, true);
        fake.trusted.set(false);
        assert_eq!(control.request(&fake, 2, true), SystemKeys::NeedsPermission);
        assert!(!fake.armed.load(Ordering::SeqCst));
    }

    #[test]
    fn reports_a_tap_macos_refused_and_tries_again_next_time() {
        let fake = host(true, false);
        let mut control = Control::default();
        assert_eq!(control.request(&fake, 1, true), SystemKeys::Unavailable);
        assert_eq!(control.status(&fake), SystemKeys::Unavailable);
        fake.startable.set(true);
        assert_eq!(control.request(&fake, 2, true), SystemKeys::Allowed);
        assert_eq!(fake.starts.get(), 2);
        assert_eq!(control.status(&fake), SystemKeys::Allowed);
    }

    #[test]
    fn release_without_a_tap_does_nothing() {
        let fake = host(true, true);
        let mut control = Control::default();
        control.release();
        assert_eq!(fake.sets.load(Ordering::SeqCst), 0);
    }
}
