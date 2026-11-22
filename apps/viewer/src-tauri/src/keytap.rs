use serde::{Serialize, Serializer};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::WebviewWindow;

pub const WINDOW: &str = "main";
pub const LEASE: Duration = Duration::from_millis(750);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods(u8);

impl Mods {
    pub const SHIFT: Self = Self(1);
    pub const CONTROL: Self = Self(1 << 1);
    pub const OPTION: Self = Self(1 << 2);
    pub const COMMAND: Self = Self(1 << 3);
    pub const FUNCTION: Self = Self(1 << 4);
    const NAMED: [(Self, &'static str); 4] = [
        (Self::SHIFT, "shift"),
        (Self::CONTROL, "control"),
        (Self::OPTION, "option"),
        (Self::COMMAND, "command"),
    ];

    #[must_use]
    pub const fn with(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn has(self, any: Self) -> bool {
        self.0 & any.0 != 0
    }
}

impl Serialize for Mods {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(
            Self::NAMED
                .iter()
                .filter(|(mods, _)| self.has(*mods))
                .map(|(_, name)| name),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stroke {
    Down,
    Repeat,
    Up,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Forward {
    pub code: &'static str,
    pub down: bool,
    pub modifiers: Mods,
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
    pub fn decide(&mut self, armed: bool, stroke: Stroke, keycode: u16, mods: Mods) -> Verdict {
        if !armed {
            self.reset();
            return Verdict::Pass;
        }
        let code = dom_code(keycode);
        if code.is_none() && !is_system_key(keycode) {
            return Verdict::Pass;
        }
        let Some(held) = self.held.get_mut(usize::from(keycode)) else {
            return Verdict::Pass;
        };
        let down = match (stroke, *held) {
            (Stroke::Down | Stroke::Repeat, true) => true,
            (Stroke::Down, false) if intercepts(keycode, mods) => true,
            (Stroke::Up, true) => false,
            _ => return Verdict::Pass,
        };
        *held = down;
        Verdict::Swallow(code.map(|code| Forward {
            code,
            down,
            modifiers: mods,
        }))
    }

    pub fn reset(&mut self) {
        self.held = [false; KEYCODES];
    }
}

pub fn intercepts(keycode: u16, mods: Mods) -> bool {
    let chord = Mods::CONTROL.with(Mods::OPTION).with(Mods::COMMAND);
    mods.has(chord)
        || (mods.has(Mods::FUNCTION) && !carries_fn(keycode))
        || is_function_key(keycode)
        || is_system_key(keycode)
}

fn carries_fn(keycode: u16) -> bool {
    matches!(
        dom_code(keycode),
        Some(
            "ArrowLeft"
                | "ArrowRight"
                | "ArrowUp"
                | "ArrowDown"
                | "Home"
                | "End"
                | "PageUp"
                | "PageDown"
                | "Delete"
                | "Insert"
        )
    )
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

pub struct Lease {
    epoch: Instant,
    until: AtomicU64,
}

impl Default for Lease {
    fn default() -> Self {
        Self {
            epoch: Instant::now(),
            until: AtomicU64::new(0),
        }
    }
}

impl Lease {
    fn now(&self) -> Duration {
        self.epoch.elapsed()
    }

    pub fn live(&self) -> bool {
        self.live_at(self.now())
    }

    pub fn extend(&self, length: Duration) -> bool {
        self.extend_at(self.now(), length)
    }

    pub fn end(&self) {
        self.until.store(0, Ordering::SeqCst);
    }

    fn live_at(&self, now: Duration) -> bool {
        nanos(now) < self.until.load(Ordering::SeqCst)
    }

    fn extend_at(&self, now: Duration, length: Duration) -> bool {
        let lapsed = !self.live_at(now);
        self.until
            .store(nanos(now.saturating_add(length)), Ordering::SeqCst);
        lapsed
    }
}

fn nanos(at: Duration) -> u64 {
    u64::try_from(at.as_nanos()).unwrap_or(u64::MAX)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemKeys {
    Allowed,
    NeedsPermission,
    Unavailable,
}

pub trait Switch: Send {
    fn arm(&self);
    fn disarm(&self);
}

pub trait Host {
    fn trusted(&self) -> bool;
    fn start(&self) -> Option<Box<dyn Switch>>;
}

#[derive(Default)]
pub struct Control {
    seq: u64,
    armed: bool,
    tap: Option<Box<dyn Switch>>,
    failed: bool,
}

impl Control {
    pub fn request(&mut self, host: &dyn Host, seq: u64, armed: bool) -> SystemKeys {
        if armed && seq < self.seq {
            return self.status(host);
        }
        self.seq = self.seq.max(seq);
        if !armed {
            self.release();
            return self.status(host);
        }
        if !host.trusted() {
            self.release();
            return SystemKeys::NeedsPermission;
        }
        let rising = !self.armed;
        self.armed = true;
        if self.tap.is_none() && (rising || !self.failed) {
            self.tap = host.start();
            self.failed = self.tap.is_none();
        }
        match &self.tap {
            Some(tap) => {
                tap.arm();
                SystemKeys::Allowed
            }
            None => SystemKeys::Unavailable,
        }
    }

    pub fn release(&mut self) {
        self.armed = false;
        if let Some(tap) = &self.tap {
            tap.disarm();
        }
    }

    pub fn restart(&mut self) {
        self.release();
        self.seq = 0;
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

type Sink = Arc<Mutex<Option<Channel<Forward>>>>;

pub struct KeyTap {
    control: Mutex<Control>,
    sink: Sink,
    host: platform::Platform,
}

impl Default for KeyTap {
    fn default() -> Self {
        let sink = Sink::default();
        Self {
            control: Mutex::new(Control::default()),
            host: platform::Platform::new(Arc::clone(&sink)),
            sink,
        }
    }
}

impl KeyTap {
    pub fn release(&self) {
        if let Ok(mut control) = self.control.lock() {
            control.release();
        }
    }

    pub fn restart(&self) {
        if let Ok(mut control) = self.control.lock() {
            control.restart();
        }
        if let Ok(mut sink) = self.sink.lock() {
            *sink = None;
        }
    }

    fn listening(&self) -> bool {
        self.sink.lock().is_ok_and(|sink| sink.is_some())
    }
}

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
    let armed = armed && focused && state.listening();
    let mut control = state.control.lock().map_err(|e| e.to_string())?;
    Ok(control.request(&state.host, seq, armed))
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri injects the window and state by value; a command cannot take references to them"
)]
pub fn system_keys_channel(
    window: WebviewWindow,
    state: tauri::State<'_, KeyTap>,
    keys: Channel<Forward>,
) -> Result<(), String> {
    if window.label() != WINDOW {
        return Err("system shortcuts go to the main window only".into());
    }
    *state.sink.lock().map_err(|e| e.to_string())? = Some(keys);
    Ok(())
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

pub use platform::watch;

#[cfg(target_os = "macos")]
mod platform {
    use super::{
        Filter, Forward, Host, KeyTap, Lease, Mods, Sink, Stroke, Switch, Verdict, LEASE, WINDOW,
    };
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
    use std::sync::{mpsc, Arc};
    use std::thread;
    use tauri::{AppHandle, Emitter, Manager};

    const SLICE_SECONDS: f64 = 0.1;
    const ACCESSIBILITY_PANE: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: Option<&CFDictionary>) -> bool;
        static kAXTrustedCheckOptionPrompt: &'static CFString;
    }

    fn trusted() -> bool {
        // SAFETY: AXIsProcessTrusted takes no arguments and only reads this process's TCC state.
        unsafe { AXIsProcessTrusted() }
    }

    pub struct Platform {
        sink: Sink,
    }

    impl Platform {
        pub fn new(sink: Sink) -> Self {
            Self { sink }
        }
    }

    impl Host for Platform {
        fn trusted(&self) -> bool {
            trusted()
        }

        fn start(&self) -> Option<Box<dyn Switch>> {
            start(Arc::clone(&self.sink)).map(|tap| Box::new(tap) as Box<dyn Switch>)
        }
    }

    pub fn watch(app: &AppHandle) {
        use block2::RcBlock;
        use objc2_app_kit::{
            NSWorkspace, NSWorkspaceSessionDidResignActiveNotification,
            NSWorkspaceWillSleepNotification,
        };
        use objc2_foundation::NSNotification;

        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: AppKit's notification names are immutable statics.
        let names = unsafe {
            [
                NSWorkspaceSessionDidResignActiveNotification,
                NSWorkspaceWillSleepNotification,
            ]
        };
        for name in names {
            let app = app.clone();
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                if let Some(tap) = app.try_state::<KeyTap>() {
                    tap.release();
                }
                let _ = app.emit_to(WINDOW, "menu", "release-keyboard");
            });
            // SAFETY: NSWorkspace posts these on the main thread, where the block runs.
            let observer = unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
            };
            std::mem::forget(observer);
        }
    }

    pub fn open_accessibility_settings() -> Result<(), String> {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSString, NSURL};

        // SAFETY: kAXTrustedCheckOptionPrompt is an immutable CFString constant.
        let prompt = unsafe { kAXTrustedCheckOptionPrompt };
        // SAFETY: kCFBooleanTrue is an immutable CoreFoundation constant.
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
        lease: Arc<Lease>,
        wake: mpsc::Sender<()>,
    }

    impl Switch for Tap {
        fn arm(&self) {
            if self.lease.extend(LEASE) {
                let _ = self.wake.send(());
            }
        }

        fn disarm(&self) {
            self.lease.end();
        }
    }

    struct Context {
        lease: Arc<Lease>,
        filter: RefCell<Filter>,
        keys: mpsc::Sender<Forward>,
        port: OnceCell<CFRetained<CFMachPort>>,
        pid: i64,
    }

    fn start(sink: Sink) -> Option<Tap> {
        let lease = Arc::new(Lease::default());
        let (wake, woken) = mpsc::channel::<()>();
        let (keys, forwarded) = mpsc::channel::<Forward>();
        let (ready, started) = mpsc::channel::<bool>();
        let shared = Arc::clone(&lease);
        thread::Builder::new()
            .name("winvm-key-tap".into())
            .spawn(move || run(shared, keys, &woken, &ready))
            .ok()?;
        if !started.recv().unwrap_or(false) {
            return None;
        }
        thread::Builder::new()
            .name("winvm-key-forward".into())
            .spawn(move || {
                for key in forwarded {
                    if let Ok(sink) = sink.lock() {
                        if let Some(channel) = sink.as_ref() {
                            let _ = channel.send(key);
                        }
                    }
                }
            })
            .ok()?;
        Some(Tap { lease, wake })
    }

    fn run(
        lease: Arc<Lease>,
        keys: mpsc::Sender<Forward>,
        woken: &mpsc::Receiver<()>,
        ready: &mpsc::Sender<bool>,
    ) {
        let info = Box::into_raw(Box::new(Context {
            lease,
            filter: RefCell::new(Filter::default()),
            keys,
            port: OnceCell::new(),
            pid: i64::from(std::process::id()),
        }));
        let mask = (1u64 << CGEventType::KeyDown.0) | (1u64 << CGEventType::KeyUp.0);
        // SAFETY: the callback matches CGEventTapCallBack, and info stays valid for as long as the tap exists.
        let port = unsafe {
            CGEvent::tap_create(
                CGEventTapLocation::HIDEventTap,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::Default,
                mask,
                Some(callback),
                info.cast(),
            )
        };
        let Some(port) = port else {
            // SAFETY: no tap was created, so this thread holds the only pointer to the context.
            drop(unsafe { Box::from_raw(info) });
            let _ = ready.send(false);
            return;
        };
        CGEvent::tap_enable(&port, false);
        // SAFETY: the tap exists for the rest of the process, so the context is never freed.
        let context: &'static Context = unsafe { &*info };
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
            while context.lease.live() {
                if !trusted() {
                    context.lease.end();
                    break;
                }
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

    pub fn mods(flags: CGEventFlags) -> Mods {
        [
            (CGEventFlags::MaskShift, Mods::SHIFT),
            (CGEventFlags::MaskControl, Mods::CONTROL),
            (CGEventFlags::MaskAlternate, Mods::OPTION),
            (CGEventFlags::MaskCommand, Mods::COMMAND),
            (CGEventFlags::MaskSecondaryFn, Mods::FUNCTION),
        ]
        .into_iter()
        .filter(|(flag, _)| flags.contains(*flag))
        .fold(Mods::default(), |held, (_, more)| held.with(more))
    }

    pub fn ours(target: i64, pid: i64) -> bool {
        target == 0 || target == pid
    }

    unsafe extern "C-unwind" fn callback(
        _proxy: CGEventTapProxy,
        kind: CGEventType,
        event: NonNull<CGEvent>,
        info: *mut c_void,
    ) -> *mut CGEvent {
        // SAFETY: info is the tap thread's Context, kept alive for the tap's lifetime; only that thread runs this callback.
        let context = unsafe { &*info.cast::<Context>().cast_const() };
        let pass = event.as_ptr();
        let armed = context.lease.live();
        if kind == CGEventType::TapDisabledByTimeout || kind == CGEventType::TapDisabledByUserInput
        {
            if let (true, Some(port)) = (armed, context.port.get()) {
                CGEvent::tap_enable(port, true);
            }
            return pass;
        }
        // SAFETY: the event stays valid for the duration of the callback.
        let event = unsafe { event.as_ref() };
        let field = |name| CGEvent::integer_value_field(Some(event), name);
        if !ours(field(CGEventField::EventTargetUnixProcessID), context.pid) {
            return pass;
        }
        let stroke = match kind {
            CGEventType::KeyDown if field(CGEventField::KeyboardEventAutorepeat) != 0 => {
                Stroke::Repeat
            }
            CGEventType::KeyDown => Stroke::Down,
            CGEventType::KeyUp => Stroke::Up,
            _ => return pass,
        };
        let keycode = u16::try_from(field(CGEventField::KeyboardEventKeycode)).unwrap_or(u16::MAX);
        let Ok(mut filter) = context.filter.try_borrow_mut() else {
            return pass;
        };
        match filter.decide(armed, stroke, keycode, mods(CGEvent::flags(Some(event)))) {
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
mod platform_tests {
    use super::platform::{mods, ours};
    use super::Mods;
    use objc2_core_graphics::CGEventFlags;

    #[test]
    fn reads_each_modifier_from_the_flags() {
        let all = mods(
            CGEventFlags::MaskShift
                | CGEventFlags::MaskControl
                | CGEventFlags::MaskAlternate
                | CGEventFlags::MaskCommand
                | CGEventFlags::MaskSecondaryFn,
        );
        for one in [
            Mods::SHIFT,
            Mods::CONTROL,
            Mods::OPTION,
            Mods::COMMAND,
            Mods::FUNCTION,
        ] {
            assert!(all.has(one));
        }
        assert_eq!(mods(CGEventFlags::MaskAlphaShift), Mods::default());
    }

    #[test]
    fn takes_only_events_headed_for_this_process() {
        assert!(ours(42, 42));
        assert!(ours(0, 42));
        assert!(!ours(7, 42));
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{Host, Sink, Switch};
    use tauri::AppHandle;

    pub struct Platform;

    impl Platform {
        pub fn new(_sink: Sink) -> Self {
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

    pub fn watch(_app: &AppHandle) {}

    pub fn open_accessibility_settings() -> Result<(), String> {
        Err("system shortcuts are captured on macOS only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    const TAB: u16 = 0x30;
    const SPACE: u16 = 0x31;
    const KEY_A: u16 = 0x00;
    const DIGIT_3: u16 = 0x14;
    const ARROW_UP: u16 = 0x7e;
    const HOME: u16 = 0x73;
    const FORWARD_DELETE: u16 = 0x75;
    const F11: u16 = 0x67;
    const ESCAPE: u16 = 0x35;
    const VOLUME_UP: u16 = 0x48;

    const NONE: Mods = Mods(0);

    fn forward(code: &'static str, down: bool, modifiers: Mods) -> Verdict {
        Verdict::Swallow(Some(Forward {
            code,
            down,
            modifiers,
        }))
    }

    #[test]
    fn intercepts_the_system_shortcuts() {
        for key in [TAB, SPACE, DIGIT_3, ESCAPE, ARROW_UP, KEY_A] {
            for held in [Mods::COMMAND, Mods::CONTROL, Mods::OPTION] {
                assert!(intercepts(key, held), "{key:#x}");
            }
        }
        assert!(intercepts(KEY_A, Mods::FUNCTION));
        assert!(intercepts(F11, NONE));
        assert!(intercepts(MISSION_CONTROL, NONE));
        assert!(intercepts(LAUNCHPAD, NONE));
        assert!(intercepts(SPOTLIGHT, NONE));
    }

    #[test]
    fn leaves_plain_typing_and_shift_to_the_webview() {
        for key in [KEY_A, TAB, SPACE, ESCAPE, DIGIT_3, ARROW_UP] {
            assert!(!intercepts(key, NONE), "{key:#x}");
            assert!(!intercepts(key, Mods::SHIFT), "{key:#x}");
        }
    }

    #[test]
    fn leaves_keys_that_carry_fn_themselves_to_the_webview() {
        for key in [ARROW_UP, HOME, FORWARD_DELETE] {
            assert!(!intercepts(key, Mods::FUNCTION), "{key:#x}");
            assert!(
                !intercepts(key, Mods::FUNCTION.with(Mods::SHIFT)),
                "{key:#x}"
            );
            assert!(
                intercepts(key, Mods::FUNCTION.with(Mods::CONTROL)),
                "{key:#x}"
            );
        }
    }

    #[test]
    fn swallows_command_tab_and_forwards_both_edges_with_the_modifiers() {
        let mut filter = Filter::default();
        let held = Mods::COMMAND.with(Mods::SHIFT);
        assert_eq!(
            filter.decide(true, Stroke::Down, TAB, held),
            forward("Tab", true, held)
        );
        assert_eq!(
            filter.decide(true, Stroke::Repeat, TAB, held),
            forward("Tab", true, held)
        );
        assert_eq!(
            filter.decide(true, Stroke::Up, TAB, Mods::COMMAND),
            forward("Tab", false, Mods::COMMAND)
        );
    }

    #[test]
    fn keeps_swallowing_a_key_whose_down_it_took_after_the_modifier_lifts() {
        let mut filter = Filter::default();
        filter.decide(true, Stroke::Down, TAB, Mods::COMMAND);
        assert_eq!(
            filter.decide(true, Stroke::Repeat, TAB, NONE),
            forward("Tab", true, NONE)
        );
        assert_eq!(
            filter.decide(true, Stroke::Up, TAB, NONE),
            forward("Tab", false, NONE)
        );
        assert_eq!(filter.decide(true, Stroke::Up, TAB, NONE), Verdict::Pass);
    }

    #[test]
    fn passes_the_repeats_and_up_of_a_key_that_went_down_through_the_webview() {
        let mut filter = Filter::default();
        assert_eq!(
            filter.decide(true, Stroke::Down, KEY_A, NONE),
            Verdict::Pass
        );
        assert_eq!(
            filter.decide(true, Stroke::Repeat, KEY_A, Mods::COMMAND),
            Verdict::Pass
        );
        assert_eq!(
            filter.decide(true, Stroke::Up, KEY_A, Mods::COMMAND),
            Verdict::Pass
        );
    }

    #[test]
    fn passes_everything_and_forgets_held_keys_once_disarmed() {
        let mut filter = Filter::default();
        filter.decide(true, Stroke::Down, TAB, Mods::COMMAND);
        assert_eq!(
            filter.decide(false, Stroke::Down, SPACE, Mods::COMMAND),
            Verdict::Pass
        );
        assert_eq!(
            filter.decide(false, Stroke::Up, TAB, Mods::COMMAND),
            Verdict::Pass
        );
        assert_eq!(filter.decide(true, Stroke::Up, TAB, NONE), Verdict::Pass);
    }

    #[test]
    fn swallows_apple_function_keys_without_forwarding_them() {
        let mut filter = Filter::default();
        assert_eq!(
            filter.decide(true, Stroke::Down, MISSION_CONTROL, NONE),
            Verdict::Swallow(None)
        );
        assert_eq!(
            filter.decide(true, Stroke::Up, MISSION_CONTROL, NONE),
            Verdict::Swallow(None)
        );
    }

    #[test]
    fn passes_keycodes_it_cannot_name() {
        let mut filter = Filter::default();
        assert_eq!(dom_code(VOLUME_UP), None);
        assert_eq!(
            filter.decide(true, Stroke::Down, VOLUME_UP, Mods::COMMAND),
            Verdict::Pass
        );
        assert_eq!(
            filter.decide(true, Stroke::Up, VOLUME_UP, Mods::COMMAND),
            Verdict::Pass
        );
        assert_eq!(
            filter.decide(true, Stroke::Down, 0x1000, Mods::COMMAND),
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

    #[test]
    fn names_the_modifiers_it_forwards_but_not_fn() {
        let held = Mods::SHIFT
            .with(Mods::COMMAND)
            .with(Mods::FUNCTION)
            .with(Mods::OPTION);
        let json = serde_json::to_value(Forward {
            code: "Tab",
            down: true,
            modifiers: held,
        })
        .ok();
        assert_eq!(
            json,
            Some(serde_json::json!({
                "code": "Tab",
                "down": true,
                "modifiers": ["shift", "option", "command"],
            }))
        );
    }

    #[test]
    fn a_lease_lapses_unless_renewed() {
        let lease = Lease::default();
        let at = Duration::from_millis;
        assert!(!lease.live_at(at(0)));
        assert!(lease.extend_at(at(0), LEASE));
        assert!(lease.live_at(LEASE.saturating_sub(at(1))));
        assert!(!lease.extend_at(LEASE.saturating_sub(at(1)), LEASE));
        assert!(lease.live_at(LEASE + at(1)));
        assert!(!lease.live_at(LEASE * 2));
        assert!(lease.extend_at(LEASE * 3, LEASE));
        lease.end();
        assert!(!lease.live_at(LEASE * 3));
    }

    #[test]
    fn a_lease_counts_from_its_own_monotonic_epoch() {
        let lease = Lease::default();
        assert!(!lease.live());
        assert!(lease.extend(Duration::from_secs(60)));
        assert!(lease.live());
        lease.end();
        assert!(!lease.live());
    }

    #[derive(Default)]
    struct Fake {
        trusted: Cell<bool>,
        startable: Cell<bool>,
        starts: Rc<Cell<usize>>,
        armed: Arc<AtomicBool>,
        arms: Arc<AtomicUsize>,
    }

    struct FakeSwitch {
        armed: Arc<AtomicBool>,
        arms: Arc<AtomicUsize>,
    }

    impl Switch for FakeSwitch {
        fn arm(&self) {
            self.armed.store(true, Ordering::SeqCst);
            self.arms.fetch_add(1, Ordering::SeqCst);
        }

        fn disarm(&self) {
            self.armed.store(false, Ordering::SeqCst);
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
                    arms: Arc::clone(&self.arms),
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
    fn creates_the_tap_once_and_renews_its_lease_on_every_request() {
        let fake = host(true, true);
        let mut control = Control::default();
        assert_eq!(control.request(&fake, 1, true), SystemKeys::Allowed);
        assert_eq!(control.request(&fake, 2, true), SystemKeys::Allowed);
        assert!(fake.armed.load(Ordering::SeqCst));
        assert_eq!(fake.arms.load(Ordering::SeqCst), 2);
        assert_eq!(control.request(&fake, 3, false), SystemKeys::Allowed);
        assert!(!fake.armed.load(Ordering::SeqCst));
        assert_eq!(control.request(&fake, 4, true), SystemKeys::Allowed);
        assert_eq!(fake.starts.get(), 1);
        control.release();
        assert!(!fake.armed.load(Ordering::SeqCst));
    }

    #[test]
    fn ignores_a_stale_arm_but_honours_any_disarm() {
        let fake = host(true, true);
        let mut control = Control::default();
        control.request(&fake, 5, true);
        control.request(&fake, 3, false);
        assert!(!fake.armed.load(Ordering::SeqCst));
        control.request(&fake, 4, true);
        assert!(!fake.armed.load(Ordering::SeqCst));
        control.request(&fake, 6, true);
        assert!(fake.armed.load(Ordering::SeqCst));
    }

    #[test]
    fn a_new_page_starts_counting_again() {
        let fake = host(true, true);
        let mut control = Control::default();
        control.request(&fake, 900, true);
        control.restart();
        assert!(!fake.armed.load(Ordering::SeqCst));
        control.request(&fake, 1, true);
        assert!(fake.armed.load(Ordering::SeqCst));
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
    fn retries_a_refused_tap_only_when_capture_starts_again() {
        let fake = host(true, false);
        let mut control = Control::default();
        assert_eq!(control.request(&fake, 1, true), SystemKeys::Unavailable);
        assert_eq!(control.request(&fake, 2, true), SystemKeys::Unavailable);
        assert_eq!(control.request(&fake, 3, true), SystemKeys::Unavailable);
        assert_eq!(fake.starts.get(), 1);
        assert_eq!(control.status(&fake), SystemKeys::Unavailable);
        fake.startable.set(true);
        control.request(&fake, 4, false);
        assert_eq!(control.request(&fake, 5, true), SystemKeys::Allowed);
        assert_eq!(fake.starts.get(), 2);
        assert_eq!(control.status(&fake), SystemKeys::Allowed);
    }

    #[test]
    fn release_without_a_tap_does_nothing() {
        let fake = host(true, true);
        let mut control = Control::default();
        control.release();
        assert_eq!(fake.arms.load(Ordering::SeqCst), 0);
    }
}
