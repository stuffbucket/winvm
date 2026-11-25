# Token vocabulary

The canonical declaration site is
[`ui/src/styles/theme.ts`](../../ui/src/styles/theme.ts).
**Values live there only.** `mise run tokens:generate` writes them into
`ui/src/styles/tokens.css`, which every window's stylesheet imports
(through `styles.css`). This file is the lookup of
*name → purpose → scope*.

If you need a value, open `theme.ts`. If you're describing a token
in a doc or commit message, use its name — never inline the value.

## Type

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--font-display` | Display serif (Fraunces) | One display heading per window (today the overview's `.overview__title`) | Body, buttons, labels |
| `--font-body` | Workhorse sans (Commissioner) | Everything that isn't display or mono | Display headings |
| `--font-mono` | Code / identifiers | Commands, addresses, tokens, file paths, code blocks, in-place updating numerics (with `tabular-nums`) | Prose, labels |
| `--font-symbols` | File-type glyphs (a vendored subset of Symbols Nerd Font Mono) | The Files window's row glyphs and sort chevrons | Any text |
| `--text-xs` … `--text-4xl` | Type ramp | Reference by name; see [`type.md`](type.md) | Inline raw rem/px values |
| `--weight-base` … `--weight-2xl` | Weight ramp | Pair with a `--text-*` size | Weights outside the ramp |
| `--leading-base` … `--leading-2xl` | Line-height ramp | Pair with text size | Hand-tuned values |
| `--tracking-xl` / `--tracking-2xl` | Tightened letter-spacing | `--text-xl` / `--text-2xl` display headings | Body text |

## Spacing & sizing

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--space-1` … `--space-8` | Spacing scale | All gaps, padding, margins | Off-scale values |
| `--size-xs` … `--size-2xl` | Component dimensions | Icon sizing, hit-target dimensions | Spacing (use `--space-*`) |
| `--radius-input` | Form-control radius | Inputs, buttons | Cards |
| `--radius-card` | Card radius | Cards, code blocks | Inputs (looks bloated) |
| `--radius-chip` | Chip radius | Chips, count badges | Cards |
| `--radius-pill` | Fully rounded | Status dots, round badges | Anything text-heavy |
| `--border-width-hairline` / `-thin` / `-thick` / `-heavy` | Border widths | Reference by name | Off-scale borders |
| `--content-max` | Settings dialog max-width | `.settings-dialog`; the Checkpoints status line's measure | The overview's column (uses `--overview-measure`) |

## Elevation

| Token | Purpose | Use for | Do NOT use for |
|---|---|---|---|
| `--elevation-card` | Card shadow | Cards (barely visible on dark, where the surface step does the work) | Modals |
| `--elevation-modal` | Modal shadow | Modals | Cards |
| `--elevation-tooltip` | Tooltip shadow | Tooltips, popovers | Cards |

## Color (follows the OS; `[data-theme]` pins one)

25 color tokens: 19 per theme, and 6 theme-independent (`--brand`,
`--accent-fg`, `--accent-destructive`, `--accent-destructive-foreground`
and the two scrims).
"Per theme" tokens have a dark and a light value in `theme.ts`; call sites
use the one name and the theme picks the value — there are no `-light` /
`-dark` names to choose between. The contrast audit
(`packages/storybook/src/contrast.ts`, run by `bun scripts/contrast-audit.ts`
in `packages/storybook` as part of `bun run storybook:check`; Storybook →
Foundations → Contrast shows the table) measures, in each theme, the text
colors (≥4.5:1) and the non-text colors (≥3:1) on all three surfaces, and
the labels on their fills (≥4.5:1): `--accent-fg` on `--accent`,
`--accent-destructive-foreground` on `--accent-destructive`, and
`--text-strong` and `--text-base-color` on `--terminal-selection`.
`--border-subtle`, the three backdrop colors and the two scrims are listed
as decorative and not measured. The audit fails on any pairing below its
minimum and on any color that is neither a surface, measured, nor
decorative. The full list is in [`color.md`](color.md) → *Contrast
contract*.

| Token | Theme | Purpose | Use for | Do NOT use for |
|---|---|---|---|---|
| `--brand` | fixed | Crimson identity (≥3:1 non-text) | The sun in the overview backdrop's drawn wallpaper (`features/overview/Backdrop.tsx`) | Buttons, links, focus rings, text |
| `--accent` | per theme | Teal **fill / non-text** (≥3:1; white label ≥4.5:1) | Primary button fill, highlighted menu item, checkboxes (`accent-color` in `.check-field`), focus ring, busy bar, resource meters | Text of any kind (use `--link`) |
| `--accent-fg` | fixed | Label on `--accent` | Text and glyphs on an `--accent` fill: primary button label, highlighted menu item, the Files window's selected row | Anything else |
| `--accent-destructive` | fixed | Crimson **fill** for destructive buttons | Delete/destroy button fill | Error text, icons, stripes (use `--status-error`) |
| `--accent-destructive-foreground` | fixed | Label on destructive fill | Destructive button label | Anything else |
| `--link` / `--link-hover` | per theme | Teal **text** (≥4.5:1) | Links, and any teal text: "Copied", accent figures | Fills (use `--accent`) |
| `--surface-base` / `-card` / `-control` | per theme | The three surfaces | Window bg / cards / inputs, secondary buttons | Each other's job |
| `--text-strong` / `-base-color` / `-muted` | per theme | Text (all ≥4.5:1) | Headings / body / captions | Muted for body prose |
| `--border-subtle` | per theme | Hairline divider | Separators, card borders | Input borders (not 3:1) |
| `--border-strong` | per theme | Control border (≥3:1) | Input borders, the secondary button's border | Decorative rules |
| `--status-error` / `-success` / `-warning` / `-info` | per theme | State color, text-safe (≥4.5:1) so also icon-safe | Error text, icons, stripes; success/warning indicators | Identity or interaction |
| `--terminal-selection` | per theme | Selected text's ground in the Terminal window (text on it ≥4.5:1) | xterm's `selectionBackground` | Anything outside the terminal |
| `--focus-ring*` | — | Focus ring composition (color = `--accent`) | Every focusable element | Hover styling |
| `--scrim` | fixed | Behind a modal dialog | The confirmation dialog's backdrop | Anything that isn't modal |
| `--scrim-paused` | fixed | Veil over the guest's screen while the machine is paused or asleep (light grey, so the picture stays readable) | The held screen (`.screen__held`), under its glyph | Modals (use `--scrim`), text grounds |

There are no `--brand-fg`, `--accent-hover` or `--status-*-fg` tokens:
no text sits on a brand fill, teal text is `--link`, and the status
colors pass as text on their own.

## Operational rules

- **One token table, one place to look.** Don't redeclare values
  inline in components.
- **If you need a new value, add a token first** and justify it here
  with a `Purpose / Use for / Do NOT use for` row before using it.
- **Numeric tokens** (spacing, type sizes, radii, elevations) and the
  theme-independent colors (brand, button labels, destructive fill,
  scrims) ship on
  `:root`. Every theme-dependent color — surfaces, text, borders,
  `--accent`, `--link*`, `--status-*` — lives in `themes.dark` /
  `themes.light` in `ui/src/styles/theme.ts`. Both themes must
  declare the same keys (the generator refuses otherwise).
- **Theme selection is CSS, not script.** Dark is the `:root` default;
  `@media (prefers-color-scheme: light)` switches to light unless
  `<html data-theme="dark">`; `<html data-theme="light">` pins light.
  Each block sets `color-scheme` so native controls follow. Don't
  hard-code `data-theme` in a window's HTML — that pins it against the
  OS.
- **Regenerate, don't hand-edit.** `mise run tokens:generate` writes
  `tokens.css` from `theme.ts`; the viewer's `typecheck` fails when
  it is stale.

- **A color has one role.** If a token fails contrast in some use, don't
  add a variant of it — use the token whose role that is (`--link` for
  teal text, `--status-error` for error text). Then run
  `bun run storybook:check`, which includes the contrast matrix.
