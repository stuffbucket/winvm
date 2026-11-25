# Color

Four roles, deliberately split to keep each from flooding the surface.
**Token values live in [`ui/src/styles/theme.ts`](../../ui/src/styles/theme.ts)**
(generated into `tokens.css`); the full list is in [`tokens.md`](tokens.md).
This file describes role, scope, and the reasoning behind the split.

| Token | Role |
|---|---|
| `--brand` | Crimson. **Identity only.** The sun in the overview backdrop's drawn wallpaper (`features/overview/Backdrop.tsx`). Never text or a control. |
| `--accent` | Teal. **Interactive fills and non-text.** Primary buttons, highlighted menu items, checkboxes (through `accent-color`), focus rings. Never text. |
| `--accent-destructive` | Crimson-adjacent. **Destructive button fill only.** |
| `--link` | Teal text. **Every piece of teal text** — prose links, "Copied", accent figures. |

Errors are not destructive actions: error text, icons and stripes use
`--status-error`. Foreground pairings for fills: `--accent-fg`,
`--accent-destructive-foreground`.

## Why the split exists

If the crimson did double duty as identity *and* primary button fill
*and* focus ring, every interactive surface would read as "brand" — the
brand would stop reading as anything special, and the UI would feel
shouty.

Teal `--accent` carries interactive duty instead, so the brand stays
rare and deliberate, and interactions get a calm,
cooler tone that doesn't compete with content.

## Destructive is not brand

`--accent-destructive` stays in the crimson family because
destructive actions want urgency, which is the one place the brand's
warning-red quality earns its keep. It is **not** the same value as
`--brand` — destructive is a hair deeper so it reads as "caution"
rather than "identity." It's a **fill**: white on it clears 4.5:1, but
as text on the dark surfaces it falls well short, which is why error
text uses `--status-error` instead.

## Link is sister to accent

`--link` and `--link-hover` share `--accent`'s teal family but shift
lighter on dark / darker on light so each theme clears WCAG AA
against both `--surface-base` and `--surface-card`. Distinct enough
from `--accent` that a primary button (accent-filled) and an inline
prose link don't read as the same affordance.

Re-measure if you change either: `bun run storybook:check` runs the
contrast audit (`packages/storybook/scripts/contrast-audit.ts`), and
Storybook → Foundations → Contrast shows the table.

## Contrast contract

- **Target: WCAG AA.** Text ≥4.5:1, non-text (controls, icons, the
  focus ring) ≥3:1. AAA where reachable without sacrificing the
  palette.
- **What the audit measures** (`packages/storybook/src/contrast.ts`,
  run by `packages/storybook/scripts/contrast-audit.ts`), in each theme:
  - as text (≥4.5:1) on each of `--surface-base`, `--surface-card` and
    `--surface-control`: `--text-strong`, `--text-base-color`,
    `--text-muted`, `--link`, `--link-hover`, `--status-error`,
    `--status-success`, `--status-warning`, `--status-info`;
  - as non-text (≥3:1) on the same three surfaces: `--accent` (also
    the focus ring's color), `--brand`, `--border-strong`,
    `--status-error`, `--status-warning`;
  - on a fill (≥4.5:1): `--accent-fg` on `--accent`,
    `--accent-destructive-foreground` on `--accent-destructive`, and
    `--text-strong` and `--text-base-color` on `--terminal-selection`
    (selected terminal text).
- **Decorative, not measured:** `--border-subtle`, `--backdrop-base`,
  `--backdrop-glow-accent`, `--backdrop-glow-brand`, `--scrim`,
  `--scrim-paused`.
- **It fails** on any pairing below its minimum, and on any color token
  that is neither a surface, measured, nor listed as decorative: a new
  color gets a role or a place on the decorative list in `contrast.ts`.
- **Contrast is ours.** A color change lands only when the audit
  passes. There is no user color picker — see
  [`principles.md`](principles.md) → Principle 3 for what one would
  have to honor.

## Theme

- **Both light and dark.** With no attribute on the root the tokens
  follow the OS (`prefers-color-scheme`); `[data-theme="light"]` /
  `[data-theme="dark"]` on the root pins one. There is no in-app theme
  toggle; every window follows the OS.
- Surfaces, text, borders, `--link*`, `--accent` and `--status-*`
  change per theme; numeric and structural tokens, brand, and the
  button labels stay constant. See [`tokens.md`](tokens.md) →
  *Operational rules*.

## Status colors

`--status-error`, `--status-success`, `--status-warning`,
`--status-info` are text-safe (≥4.5:1 on every surface of their theme),
so one token serves text, glyphs, bars and fills in that color.
They're per theme: the light values are darker steps of the same hues
so the warning amber, for example, stays legible on white. Use them for
state, never for identity or interaction — that's `--brand` / `--accent`.

## Color in data (Resources)

The details panel's resource meters ([`components.md`](components.md) →
*Resource meters*) use two colors, and the legend says what each is:

- **Teal `--accent` is Windows**: the CPU and Memory lines with their
  soft fill, and the Disk bar's fill on its `--border-subtle` track.
  The fill doesn't change color as it fills.
- **Ink `--text-strong` is macOS**: the dashed hairline for what QEMU
  spends on the Mac, and the strip for the machine's changes on the
  Mac. Weight and dash tell the pair apart too, so it never rests on
  color alone.
- **Figures** are text ink (`--text-strong` values beside
  `--text-muted` labels), in tabular figures. No per-category colors.
- **Status colors are for state only**, never to tell categories apart.
