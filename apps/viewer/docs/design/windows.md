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
2. **Floating.** The toolbar's popovers; the Files sheet and the
   confirmation dialog (`<dialog>`, top layer). Nothing else floats.

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

## Files

The toolbar's folder button opens a sheet: a `<dialog>` hung from under the
toolbar, nearly the window's size, rather than a popover. A file list needs
the room (name, size and date columns still fit at the 640 px minimum), and
a modal keeps the keyboard in the list.

- Left: the known folders the agent reports (Desktop, Documents, Downloads,
  the profile, `C:\work`), then the drives under a hairline.
- Top: back, forward, up, the path as crumbs (they wrap, never clip), and
  refresh. A click beside the crumbs, ⌘L or ⌘⇧G types a path instead.
- Middle: folders first, then files. Names that don't fit end in an
  ellipsis, with the whole name in the row's tooltip. As the list narrows,
  the time of day goes first, then the date.
- Foot: what a copy is doing, or where a drop lands, then Copy from Mac…,
  Copy to Mac… (primary) and Done.

Copy to Mac… asks where with the native panels: the save panel for one file,
the folder panel for anything else (copies never replace a Mac file; Finder's
"name 2" is used instead). Copy from Mac… and a drop anywhere on the window
copy into the folder the sheet last showed, the Desktop until it has shown
another; copies never replace a Windows file either (Explorer's "name (2)").
The drop target names that folder: "Drop to copy to Desktop in Windows".
While the sheet is closed, a copy's progress and result are callouts above
the display.

| Keys (in the sheet) | |
|---|---|
| ↑ ↓, Home, End | move; with ⇧, extend the selection |
| ⌘A | select all |
| Return, ⌘↓, double-click | open a folder |
| ⌘↑ | the enclosing folder |
| ⌘[ ⌘] | back, forward |
| ⌘R | read the folder again |
| ⌘L, ⌘⇧G | type a path |
| a letter or two | the next name starting with them |
| Esc | close |

## Window behaviour

The window opens hidden and is shown once the first frame is committed (a
hidden WKWebView gets no animation frames, so not on `requestAnimationFrame`).
Closing the window never stops Windows.
