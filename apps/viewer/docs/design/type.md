# Type system

**Pairing: Fraunces (display) + Commissioner (body).** Humanist
editorial pair. Commissioner
is the workhorse humanist sans for everything else.

**Ramp: `--text-xs` … `--text-4xl` around a `--text-base` body size.**
Always reference token names — never inline raw pixel/rem values in
components. Values live in
[`ui/src/styles/theme.ts`](../../ui/src/styles/theme.ts);
vocabulary in [`tokens.md`](tokens.md).

## Usage by token name

| Token | Use |
|---|---|
| `--text-xs` | Glyph-only contexts, inside a `.kbd` rule. **Nothing else:** `scripts/check-design-tokens.ts` (in the viewer's `typecheck`) fails any `var(--text-xs)` in the viewer's stylesheets outside a `.kbd` rule. `--text-sm` is the floor. |
| `--text-sm` | Settings form labels, inputs, buttons, descriptions and hints |
| `--text-base` | Body prose. **Floor for multi-line prose.** |
| `--text-md` | Subsection, card, empty-state and dialog titles |
| `--text-lg` | Subhead |
| `--text-xl` | Section heading; no window uses it today |
| `--text-2xl` | The overview's display heading (`.overview__title`, Fraunces) |
| `--text-3xl` / `--text-4xl` | Hero display — rare; no window uses them today |

Pair each `--text-*` with a `--weight-*` and `--leading-*` from the
ramp; don't hand-tune. The two display sizes also have a tightened
letter-spacing token, `--tracking-xl` / `--tracking-2xl`.

## Weights (by role, not by number)

- **`--weight-base`** — body default
- **`--weight-md`** — emphasis, button label
- **`--weight-lg`** / **`--weight-xl`** — section headings
- **`--weight-2xl`** — window headings

> No thin weights (100/200/300) — reads thin on dark backgrounds. No
> 900 — too heavy for warm + crafted. If you find a design moment
> that wants either, the answer is usually a different size, not a
> different weight.

The weight and leading ramps stop at `2xl`. If a hero moment needs
more, add the token to `theme.ts` *first* (see
[`change-checklists.md`](change-checklists.md)).

## Mono usage

`var(--font-mono)` is for: commands and code samples (the overview's
`winvm build` line, command output) and one-line values such as
addresses, tokens and folder paths (`ui/src/components/OneLine.tsx`).
**Always `tabular-nums`** when paired with updating values so columns
don't dance.

## Lengths and density

- Body text: minimum `--text-base`; never smaller for multi-line prose.
- Max line length: `65ch` on prose containers. Code/sample blocks
  are exempt and allowed to scroll.
- Settings: dense form rows use `--text-sm` for labels, controls and
  hints.

## Numerics

- **Tabular figures** (`font-variant-numeric: tabular-nums`) for any
  numbers that update in place: resource figures, sizes, timestamps.
- **Units** follow the number after a space: "2.1 GB of 4 GB",
  "512 MiB", "30 seconds" (`formatGB` in `features/usage/usage.ts`,
  `formatSize` in `model.ts`, `formatBytes` in `features/files/files.ts`).
  Percent is the exception and sits against the number: "19%".

## Casing

- **Sentence case** for the window's own text: headings, labels,
  buttons, messages. **No ALL CAPS** anywhere (too marketing).
- **Title Case for menu items**, as macOS menus are: the native menu
  ("New Terminal Tab", "Capture Keyboard", "Rename Window…") and the
  app's own menus ("Take a Checkpoint Now").
- Proper nouns keep their case in either ("Windows", "PowerShell 7").
- A few strings outside menus are still Title Case and are the
  exception, not the rule: the close dialog's "Leave Running" and "Shut
  Down", Settings' "Apply Policy", "Restart Windows?", and the operation
  names ("Shutting Down", "Turning Off Windows").

## Emphasis

- **Bold** (using `--weight-md` or `--weight-lg`) for in-copy
  emphasis. Sparingly.
- Italics for the rare phrase or quoted user input. Avoid for UI labels.
- Never combine bold + italics. Choose one.

## Font loading

Both Fraunces and Commissioner are on Google Fonts. **Self-host.**
The WOFF2 files are vendored under `ui/src/styles/fonts/` (Fraunces
and Commissioner, declared in `fonts.css`; the Files window's subset of
Symbols Nerd Font Mono, declared in `files.css`) and bundled with the UI
by `scripts/build-ui.ts`, so the webview never
makes an external request — keeps the app working offline and
preserves the no-telemetry posture.
