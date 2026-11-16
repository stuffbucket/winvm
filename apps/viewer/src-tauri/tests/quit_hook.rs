#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::NSApp;
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventSendOptions};
    use std::ffi::c_void;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::RunEvent;
    use winvm_viewer_lib::terminate::{
        self, Quit, Terminate, CORE_EVENT_CLASS, QUIT_APPLICATION, QUIT_REASON,
    };

    const CHILD: &str = "WINVM_QUIT_HOOK_LATER_YES";
    const REPLY_AFTER: Duration = Duration::from_millis(400);
    const WATCHDOG: Duration = Duration::from_secs(10);

    static ANSWER: Mutex<Terminate> = Mutex::new(Terminate::Now);
    static SEEN: Mutex<Vec<Quit>> = Mutex::new(Vec::new());
    static HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
    static FINAL: Mutex<Option<Final>> = Mutex::new(None);

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Final {
        Now,
        LaterYes,
    }

    fn check(ok: bool, what: &str) {
        println!("{} {what}", if ok { "ok  " } else { "FAIL" });
        if !ok {
            std::process::exit(1);
        }
    }

    fn answer(next: Terminate) {
        *ANSWER.lock().unwrap() = next;
    }

    fn seen() -> Vec<Quit> {
        SEEN.lock().unwrap().clone()
    }

    #[link(name = "System", kind = "dylib")]
    unsafe extern "C" {
        static _dispatch_main_q: c_void;
        fn dispatch_async_f(
            queue: *const c_void,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
    }

    fn later(step: extern "C" fn(*mut c_void)) {
        // SAFETY: the main queue is a process-lifetime static and the step takes no context.
        unsafe { dispatch_async_f(&raw const _dispatch_main_q, std::ptr::null_mut(), step) };
    }

    fn reply_after_a_while(terminate: bool) {
        let handle = HANDLE.lock().unwrap().clone().unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(REPLY_AFTER);
            let _ = handle.run_on_main_thread(move || terminate::reply(terminate));
        });
    }

    fn must_terminate(what: &'static str, last: Final) {
        *FINAL.lock().unwrap() = Some(last);
        std::thread::spawn(move || {
            std::thread::sleep(WATCHDOG);
            check(false, what);
        });
    }

    fn send_quit(reason: Option<&[u8; 4]>) {
        let target = NSAppleEventDescriptor::currentProcessDescriptor();
        let class = AnyClass::get(c"NSAppleEventDescriptor").unwrap();
        // SAFETY: appleEventWithEventClass:eventID:targetDescriptor:returnID:transactionID: takes two FourCharCodes, a descriptor, an SInt16 and an SInt32, and returns a new event.
        let event: Retained<NSAppleEventDescriptor> = unsafe {
            msg_send![class, appleEventWithEventClass: CORE_EVENT_CLASS, eventID: QUIT_APPLICATION, targetDescriptor: &*target, returnID: -1_i16, transactionID: 0_i32]
        };
        if let Some(reason) = reason {
            let why = NSAppleEventDescriptor::descriptorWithTypeCode(u32::from_be_bytes(*reason));
            // SAFETY: setAttributeDescriptor:forKeyword: takes a descriptor and a FourCharCode keyword, the way loginwindow sets 'why?'.
            unsafe {
                let () = msg_send![&*event, setAttributeDescriptor: &*why, forKeyword: QUIT_REASON];
            }
        }
        let _ = event.sendEventWithOptions_timeout_error(NSAppleEventSendOptions::NoReply, 30.0);
    }

    extern "C" fn dock_quit(_: *mut c_void) {
        answer(Terminate::Cancel { emit: true });
        send_quit(None);
        check(
            seen() == [Quit::User],
            "a quit Apple Event with no reason reaches applicationShouldTerminate: as the person quitting, and NSTerminateCancel keeps the app running",
        );
        later(logout_refused);
    }

    extern "C" fn logout_refused(_: *mut c_void) {
        answer(Terminate::Later {
            id: 1,
            check: false,
        });
        reply_after_a_while(false);
        let started = Instant::now();
        send_quit(Some(b"rlgo"));
        let waited = started.elapsed();
        check(
            seen() == [Quit::User, Quit::SessionEnd],
            "a quit Apple Event whose 'why?' attribute is rlgo reaches the hook as a session end",
        );
        check(
            waited >= REPLY_AFTER,
            &format!("NSTerminateLater holds the quit until a reply sent through tao's run_on_main_thread arrives during the modal wait ({waited:?}), and NO keeps the app running"),
        );
        later(shutdown_now);
    }

    extern "C" fn shutdown_now(_: *mut c_void) {
        answer(Terminate::Now);
        must_terminate("NSTerminateNow terminates the app", Final::Now);
        send_quit(Some(b"shut"));
    }

    extern "C" fn logout_accepted(_: *mut c_void) {
        answer(Terminate::Later {
            id: 1,
            check: false,
        });
        must_terminate(
            "NSTerminateLater followed by a YES reply terminates the app",
            Final::LaterYes,
        );
        reply_after_a_while(true);
        send_quit(Some(b"rlgo"));
    }

    fn installed(mtm: MainThreadMarker) {
        let delegate = NSApp(mtm).delegate().unwrap();
        let object: &AnyObject = delegate.as_ref();
        check(
            object.class().name().to_str() == Ok(terminate::DELEGATE_CLASS),
            "tao's app delegate is TaoAppDelegateParent",
        );
        let result = terminate::install(|quit| {
            SEEN.lock().unwrap().push(quit);
            *ANSWER.lock().unwrap()
        });
        check(result.is_ok(), &format!("the hook installs: {result:?}"));
        // SAFETY: respondsToSelector: takes a selector and returns BOOL.
        let responds: bool =
            unsafe { msg_send![object, respondsToSelector: sel!(applicationShouldTerminate:)] };
        check(
            responds,
            "the delegate now answers applicationShouldTerminate:",
        );
        check(
            terminate::install(|_| Terminate::Now).is_err(),
            "a second install is refused",
        );
    }

    fn run_app(first: extern "C" fn(*mut c_void)) {
        let mut context = tauri::generate_context!(test = true);
        context.config_mut().app.windows.clear();
        let mut app = tauri::Builder::default()
            .build(context)
            .expect("the app builds");
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        app.run(move |handle, event| match event {
            RunEvent::Ready => {
                *HANDLE.lock().unwrap() = Some(handle.clone());
                installed(MainThreadMarker::new().unwrap());
                later(first);
            }
            RunEvent::Exit => match *FINAL.lock().unwrap() {
                Some(Final::Now) => check(
                    seen() == [Quit::User, Quit::SessionEnd, Quit::SessionEnd],
                    "NSTerminateNow for a shut quit ends in tao's applicationWillTerminate: and RunEvent::Exit",
                ),
                Some(Final::LaterYes) => check(
                    seen() == [Quit::SessionEnd],
                    "NSTerminateLater then YES ends in tao's applicationWillTerminate: and RunEvent::Exit",
                ),
                None => check(false, "the app terminated before the hook allowed it"),
            },
            _ => {}
        });
    }

    pub fn main() {
        if std::env::var_os(CHILD).is_some() {
            run_app(logout_accepted);
            return;
        }
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .env(CHILD, "1")
            .status()
            .unwrap();
        check(child.success(), "the YES run exited cleanly");
        run_app(dock_quit);
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    mac::main();
}
