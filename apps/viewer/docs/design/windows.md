# The winvm window

One window shows one instance. It follows the rest of these rules, which
come from maximal v0.4.48's `docs/design/` and apply here unchanged except
where this page says otherwise.

## Layers

Back to front:

0. **The display.** A frame with the guest display's own shape (800 × 600
   for the firmware framebuffer, the configured size for virtio-gpu), as
   large as fits beside the panel. Whatever is in it is about the guest's
   screen: the live screen when Windows is on, otherwise the overview (the
   state, what the instance is, how to start it, what else it does) or the
   start progress. The frame and its size label are what say "Windows'
   screen goes here"; no monitor art.
1. **Docked.** The toolbar, always; callouts above the display; the panel
   when open. They take space and push the display, never cover it.
2. **Floating.** The confirmation dialog (`<dialog>`, top layer). Nothing
   else floats.

## Toolbar

The title bar is an overlay (`TitleBarStyle::Overlay`, hidden title), so
the toolbar is the drag region and leaves room for the traffic lights.
Left to right: the instance (a picker when there are several) and its state
in words; power (Start or Shut down, Restart, Pause or Resume); view (Fit
to window, Open in Screen Sharing, Details). There is no heading repeating
the window title.

## Disclosure

The overview says the least it can: one display heading (Fraunces, the
window's one display moment), one sentence, one fact line, one primary
action. The commands for developers sit under it, and drop out when the
display is too short for them. Everything else is in the panel, one section
open at a time: Status open by default, This Mac open only when something
is missing.

## Window behaviour

The window opens hidden and is shown once the first frame is committed (a
hidden WKWebView gets no animation frames, so not on `requestAnimationFrame`).
Closing the window never stops Windows.
