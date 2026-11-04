# Components

Component dimensions, by token. These match the Settings stylesheet
(`shell/src/ui/styles/styles.css`); when a component fits an existing
pattern, match it exactly rather than hand-rolling something nearby.

Token values live in
[`shell/src/ui/styles/theme.ts`](../../shell/src/ui/styles/theme.ts);
token vocabulary in [`tokens.md`](tokens.md).

## Buttons

Every `.btn`: min-height `--size-xl`, padding `--space-2` ×
`--space-4`, `--text-sm` at `--weight-md`, `--radius-input`,
`--border-width-hairline` border.

| Variant | Class | Size | Notes |
|---------|-------|------|-------|
| Primary | `btn--primary` | base | `--accent-fg` on `--accent` fill |
| Secondary | `btn--secondary` | base | `--surface-control` fill, `--border-strong` border |
| Ghost | `btn--ghost` | base | Transparent, `--text-base-color`; hover → `--surface-control` |
| Ghost destructive | `btn--ghost-destructive` | base | Ghost that reads red; always confirms first |
| Icon | `btn--icon` | `--size-xl` square | `--size-sm` glyph centered; needs an `aria-label` |
| Small | `btn--sm` | min-height `--size-lg`, padding `--space-1` × `--space-3` | Sparingly; only in dense rows |
| Destructive | `btn--destructive` | base | `--accent-destructive-foreground` on `--accent-destructive` |

## Inputs

| Variant | Size | Notes |
|---------|------|-------|
| Text (`.input`) | min-height `--size-xl`, padding `--space-2` × `--space-3` | `--text-sm`; `--surface-control` fill, `--border-width-hairline` `--border-strong` border, `--radius-input` |
| Select (`.select`) | Same box as `.input` | Native chevron kept |
| Switch (`.switch`) | `--size-2xl` × `--size-lg` track, `--size-xs` thumb | `--accent` fill when on |
| Checkbox (`.checkbox`) | `--size-md` square, `--radius-chip` | `--accent` fill when checked; indeterminate shows a bar |

## Form rows

- Grid: 33% label column, remainder for the control, `--space-4` gap.
- Padding `--space-2` top and bottom, hairline `--border-subtle`
  divider between rows.
- Label `--text-sm` at `--weight-md`; hint `--text-sm` in
  `--text-muted`.
- Right-align controls only when they're visually right-anchored
  (toggles, dropdowns); left-align for text inputs.

## Sidebar (Settings)

- Width: `--sidebar-width`, fixed.
- Padding: `--space-3` vertical × `--space-2` horizontal; `--space-1`
  between items.
- Nav item: padding `--space-2` × `--space-3`, `--text-sm`,
  `--radius-input`. Weight `--weight-base` → `--weight-md` on active.
  **Active state: a `--surface-control` surface step** (not a left
  bar — left bar reads more dev-tool than humanist).
- No group labels; the nine sections are one flat list. The only
  uppercase text in the sidebar is the `.nav__chip` badge (see
  [`type.md`](type.md) → *Casing*).

## Cards

- Padding: `--space-4` vertical × `--space-5` horizontal. Nesting
  cards is forbidden — see [`aesthetic.md`](aesthetic.md).
- Internal row gap: `--space-3`.
- Background: `--surface-card`.
- Border: `--border-width-hairline` solid `--border-subtle`.
- Radius: `--radius-card`.
- Shadow: `--elevation-card` (barely visible on dark, where the
  surface step does the work).

## Callouts (banners)

A failure or notice is never a bare line of colored text. It's a
`Callout` (`shell/src/ui/components/Callout.tsx`; `.callout` classes for
vanilla markup) across the top of the section, or inside the card it's
about.

- Shape: icon, title, detail, at most **one** action (usually "Try
  again"), in a hairline-bordered box. **No colored edge stripe** — the
  thick left border is a stock generated-UI tell; the icon's color says
  the tone.
- Surface `--surface-control`, `--border-width-hairline` border,
  `--radius-card`, padding `--space-3` × `--space-4`.
- Tones: **error** (icon `--status-error`) when something failed;
  **notice** (icon `--text-muted`) when it's worth knowing but nothing is
  wrong. Not brand, not accent.
- Title says what happened in plain words ("Couldn't load your apps");
  detail carries the server's message; the action fixes it.
- A section's load error goes above its content, not after it.

### Problems (errors the user sees)

`ProblemCallout` + `describeProblem()` (`shell/src/ui/problems.ts`). The
rules, in order:

1. **Recover before reporting.** Loads retry transient failures
   (Maximal not answering, 429, 5xx) on their own via `withRetry`; only
   what's still wrong afterwards is shown. If Maximal is already fixing
   something (e.g. restarting the MCP broker), say so in one quiet
   `.panel-status` line — no banner, nothing to click — and poll.
2. **Name the cause in plain words.** "Maximal isn't responding", "You're
   not signed in to GitHub Copilot", "Maximal isn't allowed to change
   ~/.claude.json". Never internal names (broker, sidecar, circuit).
3. **One remedy, only if the user can do it**: Restart Maximal, Go to
   Account, or Try again (when they've fixed something, e.g. a file's
   permissions). Nothing they can do → no button; the detail says what
   happens next. Never two buttons for the same action — if the surface
   already has a Refresh, the banner doesn't add one.
4. **Raw error behind "Details"**, collapsed, for bug reports.
- Inline field validation (e.g. a name already taken) stays a caption
  next to the field.

## Empty states

Where a list will be, an `EmptyState` (`components/EmptyState.tsx`,
`.empty`) says what's missing and how to get it: a title ("No MCP
servers yet"), a sentence or two, and the one action that fills it if
the user can take it here. Dashed border, not a card — it holds no
entity. Don't show an empty state and an error at the same time; the
error wins.

## Checkbox groups with "All"

For one entity offered to several targets (an MCP server to each app):
an "All …" checkbox heads the group, the targets indent under it by
`--space-5`, rows split by a hairline. "All" shows the mixed
(indeterminate) state when some are checked. Each target row is a
`LinkCheckbox` (`components/LinkCheckbox.tsx`): checkbox + a label that
links to where the target is managed. The label never toggles the box
and always navigates. A target that can't be chosen right now shows a
warning glyph (`--status-warning`) **in place of** its checkbox — a box
would mean nothing there — with a tooltip saying why; the label greys
out but still links, and the stored choice is kept. No per-row status
text ("Added"): the tick says it. Anything worth saying about a row
after a save (e.g. the app already had its own entry) is a notice
`Callout` under the list. Changes save as made — no confirm step.

When the group only matters while the entity is on (an MCP server's
apps), the card is an accordion: a ghost icon button (`btn--icon`,
chevron-down, rotates 180° open) sits at the far right of the card head,
after the switch. Switching on opens it; switching off closes it and
disables the twirldown. While on, the twirldown folds the group away.
The button carries `aria-expanded` / `aria-controls`; the group is
`hidden` when closed, not just visually collapsed.

The card's other actions (an MCP server's Refresh and Remove) sit just left
of the switch as ghost icon buttons (`btn--icon`), each with an `aria-label`
naming the entity and a quiet `title` tooltip. A destructive one reads
red (`btn--ghost-destructive`) and always confirms in a `ConfirmDialog`
(`tone="danger"`) before acting.

## Canvas control bar (Checkpoints)

A full-window canvas keeps its controls in one bar floating at the bottom
centre (`SpatialCanvasControlGroup`, as monimal's canvas does), never in a
top bar: the traffic lights live at the top left, and a title there is
chrome the native title bar already supplies.

- Surface `--surface-card` (opaque: content pans under it),
  `--border-width-hairline` `--border-subtle`, `--radius-card`,
  `--elevation-modal`; padding `--space-1`.
- Items are `spatial-canvas__button`s (`--size-xl` high, icon buttons square),
  grouped by hairline dividers: search, then actions, then view, then the one
  primary button (`btn--primary`, "Done"), last.
- Icon buttons carry an `aria-label` and a `title`; a filter or toggle is
  `aria-pressed` and its `title` says what pressing does. A control that can't
  be used is `disabled`, and its tooltip says why.
- A control that is rarely needed folds to its icon and eases out when used
  (search to the left, so the bar grows away from its centre); a readout that
  is only wanted while something changes (the zoom's figure) eases away when it
  rests. Both are out of the way, not removed: hover or focus brings them back.

## Help popover

`HelpPopover` (`components/HelpPopover.tsx`) is the one way to explain a
thing with a picture: a panel that opens **beside** the control it explains
(layer 2, not modal), used by the overview's list of things to do
(`features/help/Abilities.tsx`). Reuse it for another explanation; give it
`anchor`, `title`, `media`, `footer` and children. Help is information, so it
opens for a row whose action is unavailable in the machine's state: that row
is `aria-disabled` (not `disabled`) and says why under its label; the popover
itself is documentation and never mentions the machine's state. See [`windows.md`](windows.md) → *Disclosure*.

- **Shape.** Width `min(32rem, 100vw − --space-6)`, `--surface-card`,
  hairline `--border-subtle`, `--radius-card`, `--elevation-modal`. Top to
  bottom: the picture on its stage (below), a head (title in `--text-md` at `--weight-lg`
  with a ghost icon Close button), the content (a lead sentence and numbered
  steps in `--text-base`, one note in `--text-sm`, its title in `--weight-md`),
  and a foot (a hairline above, position in `--text-sm` muted, ghost icon
  buttons for previous and next topic). Never a second card inside it.
  Room to breathe: the text block is padded `--space-5` above and `--space-6`
  at the sides and below, `--space-4` between its parts, `--space-3` between
  steps; the foot `--space-2` by `--space-4`, its text aligned with the body's
  `--space-6` edge.
- **Pictures.** Real screenshots of the real window, one for light and one
  for dark, chosen by `prefers-color-scheme` in a `<picture>`; the page
  follows the same media query, so they always agree. A topic with more than
  one picture shows buttons under it (`aria-pressed`, `--text-sm`), the
  open one on `--surface-control`.
  - *Framing.* The app is dark when the popover is, so a picture must never
    run to the popover's edges: its toolbar, or a panel's buttons, would read
    as the popover's own controls. The picture sits on a **stage**
    (`.help__stage`: `--surface-control`, `--space-4` all round, a fixed
    `18rem` high so the popover doesn't change size from topic to topic,
    hairline under it) and is framed as a window lying on it:
    `--border-strong` hairline (the one border that shows on both a dark
    screenshot and the dark stage), `--radius-card`, `--elevation-modal`. It
    is fitted inside the stage (`max-width`/`max-height` 100%, aspect kept),
    never cropped by it. It is inert: `user-select: none`,
    `pointer-events: none`, `draggable=false`, never focusable; its `alt`
    says what it shows. It is one image, not a card inside the card.
  - *Cropping.* Show only what the topic explains, as a window: the
    Terminal, the Files window, the Checkpoints canvas (each with its traffic
    lights, which say "window" at a glance). When the subject is a panel (Use
    with Claude), clip to the panel's box plus a margin so it sits on the
    guest's screen, and move it clear of the toolbar first; never include the
    toolbar's row of icons. `scripts/render-help.mjs` does the clipping
    (`page.screenshot({ clip })`), so a picture is regenerated, not
    hand-cropped. Keep them 16:9 (1200 × 675), so every picture fits the
    stage the same way.
- **Placement** (`placeNear`). To the right of the anchor, centred on it, so
  the anchor stays in view; else to its left; else below or above if all of
  it fits; else over the window's middle. Always `--space-3` inside the
  window. Taller than the window allows, the whole panel scrolls, the foot
  stays. It is drawn straight into the body, so a display or scroller around
  the anchor can't clip or shift it.
- **Keys and focus.** Focus moves to the panel on opening (so its title is
  read first) and back to the anchor on closing, unless focus has already
  gone elsewhere. Escape closes. Tab and Shift-Tab stay inside. Left and
  Right step to the previous or next topic. A press outside closes it; a
  press on the anchor's siblings (`scope`) doesn't, so choosing another row
  switches topic instead of closing and reopening.
- **Motion.** A 150 ms fade in, nothing else; the global reduced-motion
  block makes it instant.
- **Anchors** are buttons with `aria-haspopup="dialog"` and `aria-expanded`.

## Menus

`components/Menu.tsx` (Base UI's Menu: focus, arrow keys, type-to-select,
Esc, dismissal) in the window's style (`.menu*`). Rules for one that mixes a
choice with commands, as the Windows machines menu does:

- **Runs, not one long list.** The things you choose among are one group
  (`MenuRadioGroup`, `menuitemradio`, a check on the chosen one) with its
  muted heading ("Windows machines"). Commands that act on or beyond it are
  the next group (`menuitem`), with no heading on screen but a name for
  assistive tech (`MenuGroup name`). A command that destroys something is its
  own last group. Hairline separators between runs.
- **One leading column.** The check of the chosen item and the glyph of each
  command share it (`--size-sm`), so a command lines up under the names. Every
  command has a glyph from the app's `Icon` set (`plus`, `pencil`, `trash`); the
  items you choose among do not.
- **State at the right, in one shape.** A state is a dot and its word
  (`.state`), in a column of one width so the dots line up and the words are
  left-aligned in it, the whole right-aligned in the row. The dot differs by
  shape as well as colour, so it never relies on colour: filled
  (running, starting; `--status-success`), half (paused, asleep;
  `--status-warning`), ring with a centre (saved; `--status-info`), empty ring
  (stopped, not set up; `--text-muted`). The word is always there. On the
  highlighted row the dot, ring and word take the row's own colour.
- **Destructive** (`tone="danger"`): the text and glyph in `--status-error`; the
  highlighted row `--accent-destructive` with its foreground. Always confirms
  before acting, as every red control does.
- **Typing a letter** goes to the item whose `label` starts with it: pass the
  machine's name as `label`, not the text with its state.

## Resource meters (details panel)

`features/usage/Resources.tsx`. A label and its headline value, then the last
minute and a half as a line (CPU, Memory) or a bar (Disk). No caption under
any of them. Where a second measure of the same thing exists it is drawn **on
the same meter**, and named only on hover.

- **Two-series sparkline (CPU).** Windows' own figure leads: a 2px `--accent`
  line with its soft fill, and it is the value at rest. What QEMU spends on
  the Mac (the screen and disk work too) is a **hairline dashed** `--text-strong`
  line over it, no fill, on the same 0-100 scale. Weight and dash tell them
  apart, so the pair never relies on color (a dashed ink line clears 3:1 on
  the card in both themes). The Mac's line is left out when it would repeat
  the headline (without the agent QEMU's figure leads, as "12% on macOS")
  or when there is no Mac figure yet. Ink means "macOS", teal "Windows",
  on both meters.
- **Overlaid bar (Disk).** An 8px track. The main fill is C: used out of C:'s
  size, `--accent`, full height. The machine's changes on the Mac (the size of
  its overlay image, status `overlayBytes`) are a 4px `--text-strong` strip
  across the middle of the same track, at least 4px wide so 0.05 GB of 63 GB
  still shows, capped at the track's end. Both are bytes against **C:'s
  size**, so their lengths compare as sizes. They are not parts of one
  whole: the strip is a file on the Mac, not a share of the fill, and may be
  shorter or longer than it (it also holds blocks Windows has since freed).
  Never stack or add them.
- **Legend on hover.** With two values the meter is `role="img"`, takes
  focus (`tabIndex=0`, the focus ring) and carries the whole sentence as its
  `aria-label` ("CPU. Windows: 3%. macOS: 12%."). Pointing at it or
  focusing it shows a layer-20 tooltip under it with one row per value: its mark
  (the same stroke or fill) and "Windows: 3%", "macOS: 12%" /
  "Windows: 12 GB of 63 GB", "macOS: 3.2 GB", in text ink. Escape
  hides it while it stays pointed at or focused. The tooltip is `aria-hidden`;
  the label already says it. With one value it is a plain `role="meter"`.
- `scripts/render-resources.mjs` renders every state and checks the above.

## A name edited in its heading

`features/machines/MachineHeading.tsx`. For a name that sits inside a sentence
(a heading such as "Windows machine `name` is off") and can be changed where it
stands, as a tab's name can in VS Code.

- **At rest** it is a `<button>` that reads as text: the name in `--font-mono`
  (`0.8em` of the heading, `--weight-md`), the same padding and a clear 1px
  border as the field. Pointed at it gets a soft background (10% of
  `--text-strong`, which shows over a backdrop in both themes where a surface
  step does not) and the text cursor; focused from the keyboard it gets the
  focus ring. There is no pencil: the cursor and the tooltip ("Rename (F2)") say
  it, and a pencil would have to take room from the sentence. VoiceOver reads
  the name as a button, described by "Press Return to rename it."
- **Editing.** A click, Return or F2 swaps in an `<input>` in the same place:
  same face, size and box (the field is as wide as its text, in `ch`, and never
  moves the line), selected, labelled "Machine name", with `--surface-base`
  fill, `--border-strong` and the focus ring.
- **Keys.** Return, or leaving the field, keeps it. Esc puts the name back. Keys
  typed in the field do not reach the window's shortcuts. Focus returns to the
  button after Return, Esc and F2. (WebKit clicks the button the focus has just
  gone back to when Return is still down; a click with no pointer within 400 ms
  of closing is ignored.)
- **Empty or unchanged does nothing.** The exception is a name that has been
  set: emptying it gives back the machine's own name.
- **Not allowed** is said where it happens: a `--text-sm` line in
  `--status-error` under the heading (`role="alert"`, linked by
  `aria-describedby`; the field gets `aria-invalid` and a red border). It
  appears as you type, Return does nothing while it shows, and leaving the field
  drops the change. No dialog. The rules are the CLI's (`checkTitle` in
  `packages/core/src/config.ts`: at most 80 characters, one line, no control
  characters), kept in `features/machines/machines.ts`. A failure to save is
  said the same way and leaves the field open.
- **Motion.** Only the hover background fades (150 ms), and not under
  `prefers-reduced-motion`.

## Focus rings

- **Always visible on keyboard navigation; hidden on mouse use** via
  `:focus-visible`. Using `:focus` alone is a bug. See
  [`failure-modes.md`](failure-modes.md).
- Settings: `outline: var(--focus-ring)` (width `--focus-ring-width`,
  color `--focus-ring-color` → `--accent`) with `outline-offset:
  var(--focus-ring-offset)`. `--accent` clears 3:1 on every surface of
  both themes, so there's no fallback color.
- Dashboard: `--focus-ring` is a two-ring box-shadow (a
  `--surface-base` gap, then `--accent`).
- **Identical ring on all focusable elements within a window** —
  buttons, inputs, switches, links, nav items. No special-case ring
  styles.

## Component dimensions (size tokens)

| Token | Use |
|---|---|
| `--size-xs` | Switch thumb, status dot |
| `--size-sm` | Glyph inside icon buttons and callouts |
| `--size-md` | Checkbox, inline status icons |
| `--size-lg` | Switch height, small-button min-height |
| `--size-xl` | Button and input min-height, icon-button square |
| `--size-2xl` | Switch width, narrow input |

## Border widths

| Token | Use |
|---|---|
| `--border-width-hairline` | Every border and divider: cards, inputs, buttons, callouts, sidebar edge |
| `--border-width-thin` | Same width as hairline; unused — reach for hairline |
| `--border-width-thick` | Emphasized strokes: the busy bar, the indeterminate checkbox bar, Dashboard sparklines |
| `--border-width-heavy` | Reserved; not currently used |
