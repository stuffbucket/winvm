# Layout system

**All token values live in [`ui/src/styles/theme.ts`](../../ui/src/styles/theme.ts)**
(CSS in `ui/src/styles/tokens.css` is generated from it: `pnpm tokens`). This file
describes structure, scope, and which token to reach for, never the literal value.

## Window sizes (Rust shell)

Every window size is in **logical points**, never device pixels: Tauri's builders and
`tauri.conf.json` take logical numbers, and AppKit does the 1x / 1.5x / 2x. A physical
number (a window's `outer_position`, a monitor's size) is only ever *read*, and is
converted back with the `scale_factor()` of the monitor it belongs to, never a constant.

| Window | Default | Min | Where it is set |
|---|---|---|---|
| Main | 1024x816 | 720x480 | `src-tauri/tauri.conf.json` (window properties belong in config) |
| Terminal | 820x520 | 420x240 | `src-tauri/src/windows.rs` `TERMINAL` |
| Files (one per machine) | 920x560 | 560x340 | `src-tauri/src/windows.rs` `FILES` |

Rules:

- **One module for numbers the shell builds in code** (`windows.rs`): sizes, minimums,
  the traffic-light inset, the gap beside the main window, each with its reason. No bare
  `820.0` in `lib.rs`. A number that is a window property of the main window stays in
  `tauri.conf.json`; a test (`windows.rs`) keeps the two equal where they repeat.
- **The minimum is what the UI needs, measured, not guessed.** The main toolbar (lights
  clearance, 12 buttons, a machine's name) needs about 700 points, so the minimum width
  is 720; `scripts/render-sizes.mjs` fails if the toolbar overflows or the name has no
  room at or above that width. If the toolbar gains a button, raise `minWidth` and the
  `MAIN_MIN_WIDTH` in the Rust test and the render script together. (The UI cannot tell the
  shell its minimum at run time today: that needs `core:window:allow-set-min-size` and
  has not been verified in the real app.)
- **Placing a window beside another** (`windows::beside`) is a pure function on logical
  rectangles: it uses the screen's *work area* (not the Dock or menu bar), declines when
  there is no room at the right, and moves up rather than hang off the bottom.
- **Traffic lights**: the shell puts them at `TRAFFIC_LIGHTS` (18, 26) from the top left;
  the UI leaves `--lights-clearance` empty at the left of a toolbar on macOS. One token,
  used by the main toolbar and the Terminal's tab strip; change them together.

## Responsive rules (web layer)

The window is the only viewport; it is resizable from `minWidth` up to a display's work
area (a 2560x1440 or larger, maximized). So:

- **A screen's content stands in one column** that is `min(100%, <measure>)` wide: a
  measure in `rem` (it follows the type size), never px, and not a `max-width` on one
  block while its neighbours have another. Everything in the column takes the column's
  width; blocks that are naturally narrower (facts, a button) start at its left edge.
- **A column is centered** in a window wider than its measure (explicit, by auto margin
  or by padding, never by leaving the right side empty by accident), and centered
  vertically in a window taller than it needs (`max-height` in rem + auto block margin).
- **Height is used by what can use it**: the note's text area gets more lines at rest on
  a taller display (`@container (min-height: ...)` steps in `rem`); the list of things to
  do drops out when the display is shorter than the screen needs. A container query on
  height has a threshold in `rem` with a comment saying what it was measured from.
- **No `vh`/`vw` for layout.** The window is the viewport, so `100vh` works, but a size that
  should follow a *region* uses container units (`cqw`/`cqh`, `.display-fit` is a size
  container) so it follows the region, not the window. `innerWidth` in script only where
  the layout is in script (the Checkpoints canvas), always with a `resize` listener.
- **Spacing** is the `--space-*` scale only. A screen's top inset under the toolbar is
  `--space-7` (48): the heading never sits against the toolbar.

### The overview (`features/overview`, `.overview*` in `styles.css`)

- It fills the display area (class `display--fill`), not the guest's letterbox: it is not
  a screen, so it has no aspect ratio to keep.
- **The column**: `--overview-measure` (48rem), centered; heading, note, facts, Start and
  the list share its left edge, and the note, heading and list share its width. The
  scroll box spans the window (its scrollbar at the window's edge) and the column is made
  by its inline padding, `max(--space-7, (100% - measure) / 2)`.
- **Height**: the column is at most `--overview-height` (52rem; 32rem without the list) and
  centered when the window is taller; the note grows upward inside it exactly as
  [`windows.md`](windows.md) says (the heading stops at the column's top padding), and
  the controls below never move.
- **Sizes it is checked at**: `scripts/render-sizes.mjs` renders 640x420 (below the
  minimum, only looked at), 820x520, 1000x800, 1440x900 and 1920x1080 at 1x, 1.5x and 2x,
  light and dark, and fails on sideways scrolling, a heading that wraps with room to
  spare, blocks that do not share a left edge, a note and list of different widths, less
  than 24 px under the toolbar, and a toolbar that overflows.

## Pixel ratio (DPI)

`window.devicePixelRatio` is not constant: moving the window to a display of another ratio
changes it without a resize. Read it through `ui/src/dpr.ts` (`pixelRatio()`,
`watchPixelRatio()`, `usePixelRatio()`), never captured once at load. The pointer position
of a file drag from the Mac is already in CSS pixels on macOS (`backend.ts`
`dragPointToCss`); nothing else divides by the ratio. The guest screen asks for one guest
pixel per device pixel (`@winvm/displayfit`) and re-asks when the ratio changes (`Screen.tsx`).

## Spacing

Use the `--space-*` scale. **No off-scale values.**

| Token | Use |
|---|---|
| `--space-1` | Hairline gaps |
| `--space-2` | Inline gaps inside a row |
| `--space-3` | Inline gaps; compact card-internal row gap |
| `--space-4` | Card-internal padding (vertical); card-to-card gap; form-row internal gap |
| `--space-5` | Section gap inside a window |
| `--space-6` | Section gap (large); window-edge to content (Settings pane) |
| `--space-7` | Inter-section gap on large windows |
| `--space-8` | Reserved for inter-section gaps on the widest windows |

## Surfaces (3 levels)

Layering — in both themes, cards step forward of base.

| Token | Use |
|---|---|
| `--surface-base` | Window background (`body`) |
| `--surface-card` | Cards, sidebar fill |
| `--surface-control` | Form controls, secondary buttons |

Every text and control color is checked against all three surfaces
in both themes. See [`color.md`](color.md).

## Elevation (3 levels)

| Token | Use |
|---|---|
| `--elevation-card` | Cards (barely visible on dark, where the surface step does the work) |
| `--elevation-modal` | Modals |
| `--elevation-tooltip` | Tooltips, popovers |

**Don't add a fourth level.**

## Radii

| Token | Use |
|---|---|
| `--radius-input` | Inputs, buttons |
| `--radius-card` | Cards, code blocks |
| `--radius-chip` | Chips, count badges |
| `--radius-pill` | Status dots, round/pill badges (text-light only) |

## Z-axis order

| z-index | Layer |
|---|---|
| 0 | Base / card content |
| 10 | Fixed window chrome (the Settings busy bar) |
| 20 | Tooltips (above cards) |
| top layer | Modals — native `<dialog>` (`ConfirmDialog`), above everything without a z-index |

Z-index values are constants in this layout system, not tokens; if
you need to add or reorder layers, edit this table and audit consumers.
