# Keyboard

The Windows display has two explicit input modes:

- **Not captured (default):** Mac shortcuts stay on the Mac. Left Command is
  never forwarded. Right Command is Windows/Super, so right Command-R opens
  Run. Input → Send Windows Key and Send Ctrl-Alt-Delete are the discoverable
  alternatives.
- **Captured:** the toolbar keyboard button, Input → Capture Keyboard, or
  Control-Option captures and focuses the Windows screen. All keys, including
  Command as Windows/Super, go to the guest. The pressed toolbar control and
  “Keyboard captured — ⌃⌥ to release” indicator remain visible. Control-Option
  releases capture. macOS's own system shortcuts go to Windows only with
  Accessibility permission; see [System shortcuts](#system-shortcuts).

Focus loss or a hidden page releases capture and all held guest keys. If a
Windows key is held, Ctrl is pressed and released before Windows is released;
Windows therefore never interprets cleanup as a lone Windows-key press.

**Only while Windows takes input.** Capture, the Windows key and Ctrl-Alt-Delete
act only while Windows runs with no verb under way (`features/screen/input.ts`;
the table is in [`windows.md`](windows.md)). When it stops (Pause, Sleep, a
save, a restart), the Mac gets everything back: held keys and buttons are
released on the guest first, capture is released, the toolbar says quietly
"Keyboard released: Windows is paused" (a note, not a state), no key is swallowed
and the Mac's cursor shows over the frame. When Windows runs again, capture is
**not** resumed: it was released, so the person asks for it again (the toolbar
button or Control-Option). A capture the person had chosen isn't a standing
preference, and a pause is a good moment to have the Mac's shortcuts back.
Focus loss still releases as before.

## System shortcuts

macOS acts on some keys before any app sees them: ⌘Tab and ⌘\` (app and
window switching), ⌘Space and ⌃Space (Spotlight, input sources), ⌃↑ ⌃↓ ⌃← ⌃→
and the Mission Control key (Mission Control and Spaces), ⌘⇧3/4/5
(screenshots), ⌘⌥Esc (Force Quit), ⌃⌘Q (Lock Screen), F11 (Show Desktop) and
the Globe-key shortcuts. While the keyboard is captured, a public Quartz event
tap (`CGEventTapCreate`, `src-tauri/src/keytap.rs`) takes them from macOS and
winvm types them in Windows. winvm uses no private macOS API for this.

- **Where the tap sits.** `kCGHIDEventTap`, `kCGHeadInsertEventTap`, an active
  (`kCGEventTapOptionDefault`) tap on key-down and key-up only, on its own
  thread with its own run loop. The HID tap is the earliest point a process can
  tap and comes before WindowServer's symbolic hotkeys and the Dock; QEMU's
  Cocoa display grabs the keyboard the same way.
- **What it takes.** Only key events macOS addresses to winvm
  (`kCGEventTargetUnixProcessID` is winvm's pid; it is filled in at the HID
  tap) are considered, so a panel that takes the keyboard without winvm losing
  key status (Spotlight, Raycast, a menu) gets its keys. A key-down is taken
  when ⌘, ⌃ or ⌥ is held, when fn is held with a key that does not carry fn
  itself, or when it is an F-key or an Apple function-row key (Mission Control,
  Launchpad, Spotlight, Dictation, Do Not Disturb). Arrows, Home, End, Page Up,
  Page Down and Forward Delete carry the fn flag on their own, so alone or with
  Shift they stay on the webview path. Its auto-repeats are taken while the
  lease lasts, whether or not the modifier is still held, and its key-up is
  always taken and forwarded, whatever the lease or the target says; the
  repeats and key-up of a key whose key-down went to the Mac are left alone. A key code winvm cannot name
  is left alone too. Plain typing and the modifier keys themselves
  (flags-changed events) are never taken, so they reach Windows through the
  webview as before and Control-Option still releases capture.
- **How a taken key reaches Windows.** The callback returns NULL (macOS never
  sees the key) and only queues the key's DOM `code` and the modifier keys
  held with it (left or right, from the event's device flags) on a channel. A forwarding thread sends it over a Tauri IPC channel
  the main webview registered (`system_keys_channel`), so no other window can
  receive it. The screen's keyboard router (`features/screen/keyboard.ts`)
  first presses any of the modifier keys the key was typed with that Windows
  does not already have, on the same side (the webview may deliver the real
  modifier later; that key-down is then not sent twice), sends the
  key with `rfb.sendKey`, so it reaches QEMU as a scan code, and lets go of
  those modifiers when the Mac does or when capture ends. Apple function-row
  keys have no Windows key and are dropped.
- **When it is on.** The tap is created on the first capture with permission.
  Arming is a lease: while the keyboard is captured, the Windows screen has
  focus and the window is focused, the screen (`features/screen/systemKeys.ts`)
  renews it every 250 ms through a command that runs on the main thread, and
  Rust re-checks the window each time. The tap thread reads the lease on every
  event against a monotonic clock; once it is more than 750 ms old the tap
  passes everything and turns itself off. A stalled main thread, a hung or
  reloaded page or a crashed web process therefore gives the keyboard back
  within 750 ms. Losing focus, a hidden page, capture release, closing the
  window, a page load, quitting, the session resigning (fast user switching)
  and sleep end it at once; sleep and session switches also release capture.
  The tap thread checks Accessibility while armed and stops if it is
  withdrawn. Requests carry a rising number so a late arm cannot re-enable it;
  a disarm is always honoured. If macOS disables the tap
  (`kCGEventTapDisabledByTimeout`, `kCGEventTapDisabledByUserInput`) it is
  re-enabled while the lease lasts. A tap macOS refuses is retried only when
  capture starts again. When the lease lapses or the tap is disarmed for any
  reason, the tap thread forwards a release for every key it still holds,
  and the router lets go of the modifiers it pressed for them; when capture
  ends, the router releases its keys before a held Windows key. Nothing the
  tap pressed stays down in Windows.
- **Permission.** An active tap needs Accessibility (Privacy & Security →
  Accessibility). Without it capture still sends every other key, macOS keeps
  its system shortcuts, and the toolbar says "Keyboard captured, but macOS keeps
  ⌘Tab — ⌃⌥ to release". The first capture without permission explains this
  and offers Open System Settings (which also adds winvm to the list), Capture
  Without Them or Cancel; Input → Allow System Shortcuts in Windows… and the
  Settings dialog's Viewer section offer the same while permission is missing.
  After turning winvm on, capture again: the tap is created then, with no
  relaunch unless macOS still refuses it, which Settings reports.
- **Signing.** Accessibility is granted to the app's designated requirement
  (bundle ID and Developer ID team), so a signed update keeps it. An ad-hoc or
  unsigned local build has a requirement tied to that build: macOS shows winvm
  as allowed but refuses the tap, so turn winvm off and on again (or remove and
  re-add it) after each local build. A binary started from a terminal
  (`tauri dev`) is probably judged as that terminal app, its responsible
  process. No entitlement or Info.plist key is involved.
- **What no public API can take.** Nothing reaches a tap while another app has
  Secure Event Input on (a password field, Terminal's Secure Keyboard Entry).
  The power button, Touch ID, the lock screen and media, volume and
  brightness keys (system-defined events, left to the Mac) are out of reach.
  Globe-key actions (emoji picker, dictation, input source) are unverified:
  set "Press 🌐 key to" to Do Nothing if one still fires. If macOS leaves the
  target pid empty (0) for an event, winvm treats it as its own and relies on
  the lease alone; `UNADDRESSED_IS_OURS` in `keytap.rs` is the one switch that
  makes such events pass instead. Launching with `WINVM_KEYTAP_LOG` set logs,
  for each key press the tap considers, the target pid and whether it matched
  winvm (never the key) to standard error. The ISO keys (0x0A `IntlBackslash`, 0x32 `Backquote`) follow
  Carbon's names, which may not match what WebKit reports for the same key.

This follows UTM's useful division between host and captured routing, while
using one fixed capture chord and one fixed uncaptured Windows modifier rather
than exposing a matrix of modifier swaps.

Other CLI and power-user bindings are honored across every window unless a
window-specific section overrides; bindings that conflict with OS conventions
lose to the OS outside capture.

| Binding | Action | Scope | Status | Notes |
|---|---|---|---|---|
| `Cmd-,` | Settings | App menu | **shipped** | macOS convention. Brings the main window forward, releases keyboard capture and opens the Settings dialog. |
| `Cmd-Q` | Quit winvm | App menu | **shipped** | Asks the main window how to close (`close::request`), as `Cmd-W` on the main window does. |
| `Cmd-T` | New Terminal Tab | File menu | **shipped** | A new tab while the Terminal window is in front; otherwise a new tab in the Terminal window, opened or brought forward (see [`windows.md`](windows.md) → *The Terminal window*). |
| `Cmd-Shift-T` | Checkpoints | File menu | **shipped** | Brings the main window forward and opens or leaves the Checkpoints view. |
| `Cmd-W` | Close | File menu | **shipped** | Closes the Terminal window's tab; on the main window, asks how to close (`close::request`); any other window closes. |
| `Cmd-Shift-/` | winvm Command Reference | Help menu | **shipped** | Shows the output of `winvm help`. |
| `Cmd-K` | Command palette | Global | **reserved** | Not bound in v1. The keybind is reserved so users who try it don't accidentally hit a different action. **Don't repurpose.** |

> **Status definitions.** *Shipped* = implemented. *Planned* = on the
> roadmap; no app code binds it. *Reserved* = explicitly not bound; do
> not bind to anything else. Confirm against the codebase before adding
> new listeners — see [`failure-modes.md`](failure-modes.md).

**Text fields** keep their own keys. The suspended screen's note is a plain text
area: it takes typing, Tab, Enter and the arrows as a text area does, never calls
`preventDefault` or `stopPropagation` on them, and only Esc is its own (save and
leave the field). The menu accelerators (⌘⇧T and the rest) are native and still
work while it has focus.

## Checkpoints canvas

In the Checkpoints view (a window listener on the view while it is open; none
of these is sent to Windows). A name field and the search field keep their own
keys, so none of this acts while one has focus.

| Key | Action | Notes |
|---|---|---|
| `S` | Section tool on or off | Tooltip "Section (S)"; the button is `aria-pressed`. Drawing a section turns it off. Not with ⌘, ⌃ or ⌥ held. |
| `Esc` | Let go, one thing at a time | A carried card put back, Quick Look, a section being drawn, moved or resized, the Section tool, a section's selection, the New Checkpoint form, the search, a selected checkpoint, and last, leave the view. |
| `Return`, `F2` | Rename the focused section | The name becomes a field, selected; Return keeps it, Esc puts it back. |
| `←` `→` `↑` `↓` | Move the focused section one grid cell | `⇧` for four. Stops a cell short of another section, Now or the timeline. Without a focused section, the arrows pan. |
| `Delete`, `Backspace` | Remove the selected or focused section | Only the section: its checkpoints stay where they are. No confirmation. `⌘⌫` still deletes the selected checkpoint (after a confirmation). |
| `⌥` `←` `→` `↑` `↓` | Move the selected checkpoint | `⇧` for more (16 units, 64 with `⇧`). It lands in the section its centre is in, or loose. |
| `Tab` | Next control | Sections are groups ("Section: Name, 3 checkpoints") in reading order, before the cards. |

Sections announce what was done (created, renamed, moved, resized, removed) in
a quiet `role="status"` line.

## Implementation

- **Menu bindings** (`Cmd-,`, `Cmd-Q`, `Cmd-T`, `Cmd-Shift-T`, `Cmd-W`,
  `Cmd-Shift-/`): accelerators on the native menu's `MenuItem`s in
  `menu()` (`src-tauri/src/lib.rs`), written as `CmdOrCtrl+…` and
  handled in `handle_menu`. There is no global-shortcut plugin; these
  aren't system-wide hotkeys.
- **In-window bindings**: `keydown` listeners in the window's frontend
  code: the Terminal window's tab keys
  (`features/terminal/TerminalWindow.tsx`), the Checkpoints canvas
  (`features/checkpoints/CheckpointCanvas.tsx`), the Files window
  (`features/files/FilesWindow.tsx`). Keys for Windows go through the
  screen's own listeners (`features/screen/`).
- **Cross-platform**: listeners check `event.metaKey` (macOS) and
  `event.ctrlKey` (Windows / Linux) so the same bindings work
  everywhere.

## Affordance

Tooltips on the corresponding visible affordances include the
keybind in parens: `Settings (⌘,)`. **Quietly** — the binding doesn't
need to be screamed; it's a power move.
