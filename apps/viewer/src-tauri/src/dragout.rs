//! Dragging guest files out of the Files window onto Finder or the Desktop.
//!
//! The Files window runs its own drag while the pointer is inside it (moving
//! files between guest folders). When the pointer leaves the window with the
//! button still held, it calls `files_drag_out`, which starts a native drag
//! session from the window's WKWebView carrying one file promise
//! (NSFilePromiseProvider) per item. Nothing is copied at that point: only when
//! Finder accepts the drop does it ask each promise to write its file, and the
//! promise then runs the bundled `winvm get` into the place Finder chose, on a
//! background queue. A folder is promised as `public.folder` and `winvm get`
//! writes the whole tree there.
//!
//! Events to the window that started the drag:
//!   `files-promise`  {state: "start" | "done" | "failed", name, dest?, error?}
//!   `files-drag-end` {operation: "copy" | "none"}

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::Manager;

/// One guest file or folder being dragged out.
#[derive(Clone, Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct DragItem {
    /// The guest's Windows path.
    pub path: String,
    pub name: String,
    pub dir: bool,
}

#[derive(Clone, Serialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct PromiseEvent {
    state: &'static str,
    name: String,
    dest: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct DragEnd {
    operation: &'static str,
}

/// Starts the native drag of `items` from `window`; returns once the session has begun (or why it didn't).
#[tauri::command]
pub async fn files_drag_out(
    window: tauri::WebviewWindow,
    instance: String,
    items: Vec<DragItem>,
) -> Result<(), String> {
    if items.is_empty() {
        return Err("nothing to drag".into());
    }
    start(window, instance, items).await
}

#[cfg(not(target_os = "macos"))]
async fn start(_window: tauri::WebviewWindow, _instance: String, _items: Vec<DragItem>) -> Result<(), String> {
    Err("dragging files out is only on macOS".into())
}

#[cfg(target_os = "macos")]
async fn start(window: tauri::WebviewWindow, instance: String, items: Vec<DragItem>) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window
        .with_webview(move |wv| {
            let started = mac::begin(&app, &label, wv.inner(), wv.ns_window(), &instance, items);
            let _ = tx.send(started);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .unwrap_or_else(|_| Err("the drag didn't start".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{DragEnd, DragItem, PromiseEvent};
    use block2::DynBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message};
    use objc2_app_kit::{
        NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
        NSEventModifierFlags, NSEventType, NSFilePromiseProvider, NSFilePromiseProviderDelegate, NSView, NSWindow,
        NSWorkspace,
    };
    use objc2_foundation::{
        NSArray, NSError, NSObject, NSObjectProtocol, NSOperationQueue, NSPoint, NSProcessInfo, NSRect, NSSize,
        NSString, NSURL,
    };
    use objc2_uniform_type_identifiers::UTType;
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::OnceLock;
    use tauri::Emitter;
    use tauri_plugin_shell::ShellExt;

    /// The edge of each item's icon under the pointer, in points.
    const ICON: f64 = 48.0;

    /// What one live drag holds on to: providers keep their delegates only weakly, and Finder asks
    /// for the files after the session has ended, so all of it lives until every promise is kept.
    struct Live {
        id: u64,
        _source: Retained<DragSource>,
        _providers: Vec<Retained<NSFilePromiseProvider>>,
        _delegates: Vec<Retained<PromiseDelegate>>,
        items: usize,
        written: usize,
        ended: Option<bool>,
    }

    thread_local! {
        /// Main thread only.
        static LIVE: RefCell<Vec<Live>> = const { RefCell::new(Vec::new()) };
        static NEXT: std::cell::Cell<u64> = const { std::cell::Cell::new(1) };
    }

    /// Drops a drag's objects once nothing can ask them for more: the session ended with nothing
    /// dropped, or every promise has been written.
    fn settle(id: u64) {
        LIVE.with(|live| {
            live.borrow_mut().retain(|l| match (l.id == id, l.ended) {
                (true, Some(false)) => false,
                (true, Some(true)) => l.written < l.items,
                _ => true,
            })
        });
    }

    fn mark(id: u64, f: impl FnOnce(&mut Live)) {
        LIVE.with(|live| {
            if let Some(l) = live.borrow_mut().iter_mut().find(|l| l.id == id) {
                f(l);
            }
        });
        settle(id);
    }

    /// Where promises are written: off the main thread, a few at a time.
    fn queue() -> &'static NSOperationQueue {
        static QUEUE: OnceLock<Retained<NSOperationQueue>> = OnceLock::new();
        QUEUE.get_or_init(|| {
            let q = NSOperationQueue::new();
            q.setMaxConcurrentOperationCount(2);
            q
        })
    }

    pub struct PromiseIvars {
        drag: u64,
        app: tauri::AppHandle,
        label: String,
        instance: String,
        item: DragItem,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and PromiseDelegate doesn't implement Drop.
        #[unsafe(super(NSObject))]
        #[name = "WinvmFilePromiseDelegate"]
        #[ivars = PromiseIvars]
        pub struct PromiseDelegate;

        unsafe impl NSObjectProtocol for PromiseDelegate {}

        unsafe impl NSFilePromiseProviderDelegate for PromiseDelegate {
            #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
            fn file_name(&self, _provider: &NSFilePromiseProvider, _file_type: &NSString) -> Retained<NSString> {
                NSString::from_str(&self.ivars().item.name)
            }

            #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
            fn write(&self, _provider: &NSFilePromiseProvider, url: &NSURL, done: &DynBlock<dyn Fn(*mut NSError)>) {
                let failure = self.fetch(url).err();
                match failure {
                    None => done.call((std::ptr::null_mut(),)),
                    Some(message) => {
                        let error = error(&message);
                        done.call((Retained::as_ptr(&error) as *mut NSError,));
                    }
                }
                let (app, drag) = (self.ivars().app.clone(), self.ivars().drag);
                let _ = app.run_on_main_thread(move || mark(drag, |l| l.written += 1));
            }

            #[unsafe(method_id(operationQueueForFilePromiseProvider:))]
            fn operation_queue(&self, _provider: &NSFilePromiseProvider) -> Retained<NSOperationQueue> {
                queue().retain()
            }
        }
    );

    impl PromiseDelegate {
        fn new(ivars: PromiseIvars) -> Retained<Self> {
            let this = Self::alloc().set_ivars(ivars);
            // SAFETY: NSObject's init on a freshly allocated object.
            unsafe { msg_send![super(this), init] }
        }

        fn emit(&self, state: &'static str, dest: Option<String>, error: Option<String>) {
            let i = self.ivars();
            let event = PromiseEvent {
                state,
                name: i.item.name.clone(),
                dest,
                error,
            };
            let _ = i.app.emit_to(i.label.as_str(), "files-promise", event);
        }

        /// Runs `winvm get` into the place Finder chose. Never replaces what is there: a taken name
        /// becomes Finder's "name 2" beside it.
        fn fetch(&self, url: &NSURL) -> Result<(), String> {
            let i = self.ivars();
            let asked = url
                .path()
                .map(|p| p.to_string())
                .ok_or("Finder gave no place to copy to")?;
            let asked = Path::new(&asked);
            let dest = if asked.symlink_metadata().is_ok() {
                let dir = asked.parent().map(|d| d.display().to_string()).unwrap_or_default();
                crate::unused_path(dir, i.item.name.clone(), i.item.dir)
            } else {
                asked.display().to_string()
            };
            self.emit("start", Some(dest.clone()), None);
            let run = tauri::async_runtime::block_on(async {
                i.app
                    .shell()
                    .sidecar("winvm")
                    .map_err(|e| e.to_string())?
                    .args(["get", "-i", i.instance.as_str(), i.item.path.as_str(), dest.as_str()])
                    .output()
                    .await
                    .map_err(|e| e.to_string())
            });
            let result = match run {
                Ok(out) if out.status.success() => Ok(()),
                Ok(out) => {
                    let said = String::from_utf8_lossy(&out.stderr).replace("::error::", "");
                    let said = said.trim();
                    Err(if said.is_empty() {
                        format!("winvm get exited {:?}", out.status.code())
                    } else {
                        said.to_string()
                    })
                }
                Err(e) => Err(e),
            };
            match &result {
                Ok(()) => self.emit("done", Some(dest), None),
                Err(e) => self.emit("failed", Some(dest), Some(e.clone())),
            }
            result
        }
    }

    fn error(message: &str) -> Retained<NSError> {
        let key = unsafe { objc2_foundation::NSLocalizedDescriptionKey };
        let text = NSString::from_str(message);
        let info = objc2_foundation::NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[&*text as &AnyObject]);
        // SAFETY: a userInfo of NSString values under NSLocalizedDescriptionKey.
        unsafe { NSError::errorWithDomain_code_userInfo(&NSString::from_str("co.stuffbucket.winvm"), 1, Some(&info)) }
    }

    pub struct SourceIvars {
        drag: u64,
        app: tauri::AppHandle,
        label: String,
        webview: Retained<NSView>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and DragSource doesn't implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "WinvmDragOutSource"]
        #[ivars = SourceIvars]
        pub struct DragSource;

        unsafe impl NSObjectProtocol for DragSource {}

        unsafe impl NSDraggingSource for DragSource {
            /// Copy to other apps. Nothing within this one: the webview accepts any drag, so a
            /// drag that passes back over a winvm window would otherwise end there, unfulfilled.
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn operation_mask(&self, _session: &NSDraggingSession, context: NSDraggingContext) -> NSDragOperation {
                if context == NSDraggingContext::OutsideApplication {
                    NSDragOperation::Copy
                } else {
                    NSDragOperation::None
                }
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(&self, _session: &NSDraggingSession, _at: NSPoint, operation: NSDragOperation) {
                let i = self.ivars();
                let copied = operation.contains(NSDragOperation::Copy);
                // The session took the mouse-up; give the webview one so its page doesn't think the
                // button is still down.
                if let Some(window) = i.webview.window() {
                    if let Some(up) = mouse_event(&window, NSEventType::LeftMouseUp) {
                        i.webview.mouseUp(&up);
                    }
                }
                let operation = if copied { "copy" } else { "none" };
                let _ = i.app.emit_to(i.label.as_str(), "files-drag-end", DragEnd { operation });
                let drag = i.drag;
                mark(drag, |l| l.ended = Some(copied));
            }
        }
    );

    impl DragSource {
        fn new(mtm: MainThreadMarker, ivars: SourceIvars) -> Retained<Self> {
            let this = mtm.alloc::<Self>().set_ivars(ivars);
            // SAFETY: NSObject's init on a freshly allocated object.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// A left-mouse event of `kind` where the pointer is now, in `window`.
    fn mouse_event(window: &NSWindow, kind: NSEventType) -> Option<Retained<NSEvent>> {
        let at = window.mouseLocationOutsideOfEventStream();
        let now = NSProcessInfo::processInfo().systemUptime();
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            at,
            NSEventModifierFlags::empty(),
            now,
            window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
    }

    /// The item's type for the promise and its icon: a folder, the extension's type, or plain data.
    fn content_type(item: &DragItem) -> Retained<UTType> {
        let data =
            || UTType::typeWithIdentifier(&NSString::from_str("public.data")).expect("public.data is a system type");
        if item.dir {
            return UTType::typeWithIdentifier(&NSString::from_str("public.folder")).unwrap_or_else(data);
        }
        match item.name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
                UTType::typeWithFilenameExtension(&NSString::from_str(ext))
                    .filter(|t| !t.isDynamic())
                    .unwrap_or_else(data)
            }
            _ => data(),
        }
    }

    pub fn begin(
        app: &tauri::AppHandle,
        label: &str,
        webview: *mut std::ffi::c_void,
        ns_window: *mut std::ffi::c_void,
        instance: &str,
        items: Vec<DragItem>,
    ) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        // SAFETY: wry's WKWebView and its NSWindow, alive while the window is; retained here.
        let (webview, window) = unsafe {
            (
                Retained::retain(webview.cast::<NSView>()).ok_or("the window has no webview")?,
                Retained::retain(ns_window.cast::<NSWindow>()).ok_or("the window has no NSWindow")?,
            )
        };
        // Released already (a quick flick out of the window): there is nothing left to drag.
        if NSEvent::pressedMouseButtons() & 1 == 0 {
            return Err("the mouse button is up".into());
        }
        let event = mouse_event(&window, NSEventType::LeftMouseDragged).ok_or("no drag event")?;
        let at = webview.convertPoint_fromView(event.locationInWindow(), None);

        let drag = NEXT.with(|n| {
            let id = n.get();
            n.set(id + 1);
            id
        });
        let workspace = NSWorkspace::sharedWorkspace();
        let mut providers = Vec::new();
        let mut delegates = Vec::new();
        let mut dragging = Vec::new();
        for (k, item) in items.into_iter().enumerate() {
            let kind = content_type(&item);
            let delegate = PromiseDelegate::new(PromiseIvars {
                drag,
                app: app.clone(),
                label: label.to_string(),
                instance: instance.to_string(),
                item,
            });
            let provider = NSFilePromiseProvider::initWithFileType_delegate(
                NSFilePromiseProvider::alloc(),
                &kind.identifier(),
                ProtocolObject::from_ref(&*delegate),
            );
            let entry =
                NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), ProtocolObject::from_ref(&*provider));
            let icon = workspace.iconForContentType(&kind);
            // A small fan under the pointer, as Finder stacks a multiple selection.
            let shift = (k.min(4) as f64) * 4.0;
            let frame = NSRect::new(
                NSPoint::new(at.x - ICON / 2.0 + shift, at.y - ICON / 2.0 + shift),
                NSSize::new(ICON, ICON),
            );
            // SAFETY: an NSImage is what an image component's contents are.
            unsafe { entry.setDraggingFrame_contents(frame, Some(&icon as &AnyObject)) };
            dragging.push(entry);
            providers.push(provider);
            delegates.push(delegate);
        }
        let count = providers.len();
        let source = DragSource::new(
            mtm,
            SourceIvars {
                drag,
                app: app.clone(),
                label: label.to_string(),
                webview: webview.clone(),
            },
        );
        LIVE.with(|live| {
            live.borrow_mut().push(Live {
                id: drag,
                _source: source.clone(),
                _providers: providers,
                _delegates: delegates,
                items: count,
                written: 0,
                ended: None,
            })
        });
        let items = NSArray::from_retained_slice(&dragging);
        let _session =
            webview.beginDraggingSessionWithItems_event_source(&items, &event, ProtocolObject::from_ref(&*source));
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{content_type, DragItem, DragSource, PromiseDelegate};
        use objc2::ClassType;

        /// Registering the classes checks each method against its protocol's declared types.
        #[test]
        fn classes_register() {
            assert_eq!(PromiseDelegate::class().name().to_str(), Ok("WinvmFilePromiseDelegate"));
            assert_eq!(DragSource::class().name().to_str(), Ok("WinvmDragOutSource"));
        }

        #[test]
        fn promises_name_their_type() {
            let item = |name: &str, dir: bool| DragItem {
                path: String::new(),
                name: name.into(),
                dir,
            };
            let id = |i: DragItem| content_type(&i).identifier().to_string();
            assert_eq!(id(item("Projects", true)), "public.folder");
            assert_eq!(id(item("notes.txt", false)), "public.plain-text");
            assert_eq!(id(item("README", false)), "public.data");
            assert_eq!(id(item(".profile", false)), "public.data");
            assert_eq!(id(item("x.zzqq", false)), "public.data");
        }
    }
}
