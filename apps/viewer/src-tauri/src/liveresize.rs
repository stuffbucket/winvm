//! The start and end of a live resize (the person dragging the window's edge),
//! as `live-resize` events to the main window: `true` when it starts, `false`
//! when the mouse is let go. The viewer resizes the guest on the release rather
//! than guessing it from a pause; WebKit sees only the sizes, not the drag.

use tauri::{Emitter, WebviewWindow};

#[cfg(target_os = "macos")]
pub fn watch(window: &WebviewWindow) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSWindowDidEndLiveResizeNotification, NSWindowWillStartLiveResizeNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use std::ptr::NonNull;

    let Ok(ns_window) = window.ns_window() else { return };
    // SAFETY: tauri hands out the window's live NSWindow, and this runs on the main thread (setup).
    let object = unsafe { &*(ns_window as *const AnyObject) };
    let center = NSNotificationCenter::defaultCenter();
    // SAFETY: AppKit's notification names are immutable statics.
    let names = unsafe { [(NSWindowWillStartLiveResizeNotification, true), (NSWindowDidEndLiveResizeNotification, false)] };
    for (name, live) in names {
        let target = window.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = target.emit_to(target.label(), "live-resize", live);
        });
        // SAFETY: the observer filters on this window's object and runs the block on the posting (main) thread.
        let observer = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), Some(object), None, &block) };
        // Kept for the app's life: the main window never goes away while it runs.
        std::mem::forget(observer);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_window: &WebviewWindow) {}
