pub use crate::close::{Quit, Terminate};
use std::sync::OnceLock;

pub const DELEGATE_CLASS: &str = "TaoAppDelegateParent";
pub const SHOULD_TERMINATE: &str = "applicationShouldTerminate:";

const fn four(code: [u8; 4]) -> u32 {
    u32::from_be_bytes(code)
}

pub const CORE_EVENT_CLASS: u32 = four(*b"aevt");
pub const QUIT_APPLICATION: u32 = four(*b"quit");
pub const QUIT_REASON: u32 = four(*b"why?");
pub const SESSION_ENDS: [u32; 6] = [
    four(*b"logo"),
    four(*b"rlgo"),
    four(*b"rrst"),
    four(*b"rest"),
    four(*b"rsdn"),
    four(*b"shut"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuitEvent {
    pub class: u32,
    pub id: u32,
    pub reason: Option<u32>,
}

#[must_use]
pub fn quit_of(event: Option<QuitEvent>) -> Quit {
    match event {
        Some(QuitEvent {
            class: CORE_EVENT_CLASS,
            id: QUIT_APPLICATION,
            reason: Some(reason),
        }) if SESSION_ENDS.contains(&reason) => Quit::SessionEnd,
        _ => Quit::User,
    }
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the error is the startup failure message itself"
)]
pub fn check_delegate(class: &str, implemented: bool) -> Result<(), String> {
    if class != DELEGATE_CLASS {
        return Err(format!(
            "winvm expected tao's app delegate to be {DELEGATE_CLASS}, found {class}; Dock Quit and logout would skip the close flow"
        ));
    }
    if implemented {
        return Err(format!(
            "{class} already answers {SHOULD_TERMINATE}; winvm's close flow would replace it"
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fatality {
    Fatal,
    Logged,
}

impl Fatality {
    #[must_use]
    pub fn of_this_build() -> Self {
        if cfg!(debug_assertions) {
            Fatality::Fatal
        } else {
            Fatality::Logged
        }
    }
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the error is the startup failure message itself"
)]
pub fn settle_install(installed: Result<(), String>, fatality: Fatality) -> Result<(), String> {
    match (installed, fatality) {
        (Err(why), Fatality::Fatal) => Err(why),
        (Err(why), Fatality::Logged) => {
            crate::close::note(&format!(
                "winvm: couldn't add the quit hook, so Dock Quit and logout skip the close flow: {why}"
            ));
            Ok(())
        }
        (Ok(()), _) => Ok(()),
    }
}

type Handler = Box<dyn Fn(Quit) -> Terminate + Send + Sync>;

static HANDLER: OnceLock<Handler> = OnceLock::new();

fn decide(quit: Quit) -> Terminate {
    let asked = std::panic::catch_unwind(|| HANDLER.get().map(|handler| handler(quit)));
    match asked {
        Ok(Some(terminate)) => terminate,
        Ok(None) => Terminate::Now,
        Err(_) => {
            crate::close::note("winvm: deciding whether to quit failed, so winvm stayed open");
            Terminate::Cancel { emit: false }
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{check_delegate, decide, quit_of, QuitEvent, Terminate, QUIT_REASON};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, Imp, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::{NSApp, NSApplicationTerminateReply};
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};

    extern "C-unwind" fn should_terminate(
        _delegate: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> NSApplicationTerminateReply {
        match decide(quit_of(current_quit())) {
            Terminate::Now => NSApplicationTerminateReply::TerminateNow,
            Terminate::Cancel { .. } => NSApplicationTerminateReply::TerminateCancel,
            Terminate::Later { .. } => NSApplicationTerminateReply::TerminateLater,
        }
    }

    fn current_quit() -> Option<QuitEvent> {
        let event = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent()?;
        // SAFETY: eventClass and eventID return the event's FourCharCodes, and attributeDescriptorForKeyword: takes one and returns a descriptor or nil.
        let (class, id, reason) = unsafe {
            let class: u32 = msg_send![&*event, eventClass];
            let id: u32 = msg_send![&*event, eventID];
            let reason: Option<Retained<NSAppleEventDescriptor>> =
                msg_send![&*event, attributeDescriptorForKeyword: QUIT_REASON];
            (class, id, reason)
        };
        Some(QuitEvent {
            class,
            id,
            reason: reason.map(|r| r.typeCodeValue()),
        })
    }

    pub fn install() -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("the quit hook installs on the main thread")?;
        let app = NSApp(mtm);
        let delegate = app
            .delegate()
            .ok_or("NSApp has no delegate to add the quit hook to")?;
        let object: &AnyObject = delegate.as_ref();
        let class = object.class();
        let selector = sel!(applicationShouldTerminate:);
        check_delegate(
            &class.name().to_string_lossy(),
            class.instance_method(selector).is_some(),
        )?;
        let imp: unsafe extern "C-unwind" fn(
            &AnyObject,
            Sel,
            *mut AnyObject,
        ) -> NSApplicationTerminateReply = should_terminate;
        // SAFETY: the function matches the selector's NSApplicationTerminateReply (*)(id, SEL, NSApplication *) signature, which the type encoding states, and the class is live for the process.
        let added = unsafe {
            objc2::ffi::class_addMethod(
                std::ptr::from_ref(class).cast_mut(),
                selector,
                std::mem::transmute::<
                    unsafe extern "C-unwind" fn(
                        &AnyObject,
                        Sel,
                        *mut AnyObject,
                    ) -> NSApplicationTerminateReply,
                    Imp,
                >(imp),
                c"Q@:@".as_ptr(),
            )
        };
        if added == Bool::NO {
            return Err(format!(
                "the runtime refused to add {} to {}",
                selector.name().to_string_lossy(),
                class.name().to_string_lossy()
            ));
        }
        app.setDelegate(None);
        app.setDelegate(Some(&delegate));
        if !object.class().responds_to(selector) {
            return Err("the app delegate does not answer applicationShouldTerminate:".into());
        }
        Ok(())
    }

    pub fn reply(terminate: bool) {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApp(mtm).replyToApplicationShouldTerminate(terminate);
        }
    }
}

#[expect(
    clippy::missing_errors_doc,
    reason = "the error is the startup failure message itself"
)]
pub fn install(handler: impl Fn(Quit) -> Terminate + Send + Sync + 'static) -> Result<(), String> {
    if HANDLER.get().is_some() {
        return Err("the quit hook is already installed".into());
    }
    #[cfg(target_os = "macos")]
    mac::install()?;
    HANDLER
        .set(Box::new(handler))
        .map_err(|_| "the quit hook is already installed".to_owned())
}

pub fn reply(terminate: bool) {
    #[cfg(target_os = "macos")]
    mac::reply(terminate);
    #[cfg(not(target_os = "macos"))]
    let _ = terminate;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quit(reason: Option<[u8; 4]>) -> QuitEvent {
        QuitEvent {
            class: CORE_EVENT_CLASS,
            id: QUIT_APPLICATION,
            reason: reason.map(four),
        }
    }

    #[test]
    fn a_quit_event_naming_a_logout_restart_or_shutdown_ends_the_session() {
        for reason in [*b"logo", *b"rlgo", *b"rrst", *b"rest", *b"rsdn", *b"shut"] {
            assert_eq!(quit_of(Some(quit(Some(reason)))), Quit::SessionEnd);
        }
    }

    #[test]
    fn any_other_quit_is_the_person_quitting() {
        assert_eq!(quit_of(None), Quit::User, "terminate: with no event");
        assert_eq!(
            quit_of(Some(quit(None))),
            Quit::User,
            "Dock or AppleScript quit"
        );
        assert_eq!(quit_of(Some(quit(Some(*b"what")))), Quit::User);
        let open = QuitEvent {
            class: CORE_EVENT_CLASS,
            id: four(*b"oapp"),
            reason: Some(four(*b"rlgo")),
        };
        assert_eq!(quit_of(Some(open)), Quit::User);
    }

    #[test]
    fn the_codes_are_the_apple_event_four_char_codes() {
        assert_eq!(QUIT_REASON, 0x7768_793f);
        assert_eq!(four(*b"rlgo"), 0x726c_676f);
        assert_eq!(four(*b"rest"), 0x7265_7374);
        assert_eq!(four(*b"shut"), 0x7368_7574);
    }

    #[test]
    fn a_hook_that_cannot_install_stops_a_debug_or_test_build() {
        let failed = Err("the delegate is WryAppDelegate".to_owned());
        assert_eq!(
            settle_install(failed, Fatality::Fatal),
            Err("the delegate is WryAppDelegate".to_owned())
        );
        assert_eq!(settle_install(Ok(()), Fatality::Fatal), Ok(()));
    }

    #[test]
    fn a_release_build_runs_without_a_hook_that_cannot_install() {
        let failed = Err("the delegate is WryAppDelegate".to_owned());
        assert_eq!(settle_install(failed, Fatality::Logged), Ok(()));
        assert_eq!(settle_install(Ok(()), Fatality::Logged), Ok(()));
    }

    #[test]
    fn only_a_release_build_tolerates_a_missing_hook() {
        assert_eq!(
            Fatality::of_this_build(),
            if cfg!(debug_assertions) {
                Fatality::Fatal
            } else {
                Fatality::Logged
            }
        );
    }

    #[test]
    fn the_hook_goes_only_on_tao_s_delegate_class_and_never_over_an_existing_answer() {
        assert_eq!(check_delegate("TaoAppDelegateParent", false), Ok(()));
        assert!(check_delegate("TaoAppDelegate", false).is_err());
        assert!(check_delegate("WryAppDelegate", false).is_err());
        assert!(check_delegate("TaoAppDelegateParent", true).is_err());
    }
}
