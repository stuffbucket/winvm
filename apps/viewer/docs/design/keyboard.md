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
| `Cmd-,` | Open Settings | Tray menu | **shipped** | macOS convention. Opens or focuses Settings. |
| `Cmd-D` | Open Dashboard | Tray menu | **shipped** | Opens or focuses the Dashboard. |
| `Cmd-Q` | Quit Maximal | Tray menu | **shipped** | Confirms in a native dialog, then stops the sidecar (SIGTERM, SIGKILL after a grace period). |
| `Cmd-W` | Close current window | Per window | **planned** | Hides; doesn't quit (same as the window's close button). |
| `Esc` | Close current window | Per window | **planned** | Same as Cmd-W; natural for modal-feel windows. |
| `Cmd-R` | Refresh current window | Dashboard, Settings | **planned** | Re-fetches the window's data. |
| `Cmd-Shift-,` | Reveal config in editor | Settings | **planned** | Power-user escape hatch. |
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

- **Tray-menu bindings** (`Cmd-,`, `Cmd-D`, `Cmd-Q`): accelerators on
  the tray `MenuItem`s in `build_menu` (`shell/src-tauri/src/lib.rs`),
  written as `CmdOrCtrl+…`. There is no global-shortcut plugin; these
  aren't system-wide hotkeys.
- **In-window bindings**: per-window `keydown` listeners in the window's
  frontend code (`shell/src/` for Settings, `shell/src/dashboard/` for
  the Dashboard). None of the window-level bindings above exist yet;
  the only `keydown` / `Escape` handlers today are component-local
  (dismissing a tooltip or an inline editor, arrow keys in the
  Dashboard's period selector).
- **Cross-platform**: listeners check `event.metaKey` (macOS) and
  `event.ctrlKey` (Windows / Linux) so the same bindings work
  everywhere.

## Affordance

Tooltips on the corresponding visible affordances include the
keybind in parens: `Settings (⌘,)`. **Quietly** — the binding doesn't
need to be screamed; it's a power move.
