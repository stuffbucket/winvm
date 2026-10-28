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
