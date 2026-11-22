# Keyboard

The Windows display has two explicit input modes:

- **Not captured (default):** Mac shortcuts stay on the Mac. Left Command is
  never forwarded. Right Command is Windows/Super, so right Command-R opens
  Run. Input → Send Windows Key and Send Ctrl-Alt-Delete are the discoverable
  alternatives.
- **Captured:** the toolbar keyboard button, Input → Capture Keyboard, or
  Control-Option captures. All keys, including Command as Windows/Super, go to
  the guest. The pressed toolbar control and “Keyboard captured — ⌃⌥ to
  release” indicator remain visible. Control-Option releases capture.

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
