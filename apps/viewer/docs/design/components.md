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

## Checkpoint card

One object, not a picture with text under it: a button that is the card's
surface (`--surface-card`, hairline `--border-subtle`, `--radius-card`,
`--elevation-modal`, clipped to the radius), holding the picture on top and a
caption plate attached below it (a hairline between them, no gap). Selection,
hover, the carried shadow and the highlight ring are drawn on the button, so
they wrap both.

The plate's rows, each fact in one place (`windows.md` → *Checkpoints*):

| Row | Fact | Treatment |
|---|---|---|
| 1 | name | `--text-strong`, 1.15 em, `--weight-lg`, one line, ellipsis |
| 2 | when taken | `--text-muted`, tabular figures, one line |
| 3 | kind, and size | kind: a pill chip (`--surface-control`, hairline, glyph + the words that say how it came about: Taken by you, Saved while idle, Fresh install, Saved on suspend, Test starting point; a sentence saying what made it as its `title`; `--text-base-color`; an ellipsis before it crowds the size); size: `--text-muted`, tabular, at the row's end |
| 4 | note, if any | notebook glyph + first line, `--text-muted`, ellipsis; whole note as `title` |

- Every length in the plate is in `em` of one size, `--text-sm` times `--m`
  (the card's scale, never so small that the words are under 12 px on
  screen), so it scales as one; its words are real text sizes, not a
  transform.
- Glyphs are the shared `Icon` set: camera (Manual), timer (Automatic), flag
  (Fresh install), archive (Saved on suspend), flask (Test starting point),
  notebook-pen (a note), triangle-alert (can't restore).
- Status is not a row: a card Windows can't restore here is dashed and its
  picture greyed, with a warning banner ("Can't restore", one line, 80%
  opaque `--status-warning`; the panel's, see *Properties panel*) across the
  picture's foot, the whole reason in its `title`. Narrower than the plate's
  full width the banner is the icon alone in a small disc in the picture's corner.
- The size's `title` says what it counts: "Disk space on your Mac, at most:
  checkpoints share space".
- Absent data is absent: no kind chip placeholder, no empty note row.
- One `aria-label` states everything the card shows, plus whether it can be restored
  here; the children are decoration for assistive technology.

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
  grouped by hairline dividers: search, then actions (New, Newest,
  Automatic, Section, Reset layout), then the one primary button (`btn--primary`,
  "Done"), last. The zoom is not in the bar (below).
- Icon buttons carry an `aria-label` and a `title`; a filter or toggle is
  `aria-pressed` and its `title` says what pressing does. A control that can't
  be used is `disabled`, and its tooltip says why.
- **Newest** (flies to Now and the newest days) is a *locate* glyph, a target
  with a dot at its centre: "where it is now". Not an arrow to a bar (that reads
  as Download) and not a clock (that is Automatic's). Its name and tooltip are
  the one word, "Newest".
- **Search** is a magnifier until it is used, then one rounded field inside the
  bar, not a second control beside it (`ControlBar.tsx`):
  - *Growing.* The bar grows to the **left**, its right end where it was (the bar
    is centred, so it also moves left by half of the growth, on the same 200 ms
    `ease-out`; none under reduced motion). The field is the
    magnifier (now its leading icon, still the button that folds it), the input
    and, once there are words, a clear x, on `--surface-control` with
    `--radius-input`, inside the bar's `--space-1` padding. No border of its own.
  - *Focus.* The ring (`--focus-ring`) is the field's whole outline, drawn
    **inside** it (negative offset), so it never meets the bar's edge or clips.
  - *Narrow windows* (under 900 px, where there is no room to grow into): the
    bar does not move; the field opens over all of it, the other controls out of
    sight and out of the Tab order until it folds.
  - *Words.* Placeholder "Search names and notes" (no key hints in it). Esc clears
    and folds it; the x clears and keeps the cursor in the field. How many cards
    match is said to a screen reader (`role="status"`, never drawn: the results
    list shows them, and "No checkpoints match" when none do). Cards that don't
    match dim.

### Zoom control (Checkpoints)

The zoom is its **own** floating pill in the lower left (`ZoomControl.tsx`),
apart from the bar: minus, the figure (53%), plus, show everything. Same
surface, hairline border, `--radius-card` and `--elevation-modal` as the bar
(it is the canvas package's `spatial-canvas__zoom` pill, made opaque like the
bar), `--space-4` from the window's edges.

- **At rest it is out of sight** (`opacity: 0`, no clicks). It eases in when the
  pointer comes near (a zone of at least 160 x 120 logical px at the lower left,
  and 40 px around the control wherever it stands), when the zoom changes (wheel,
  pinch, keys, its own buttons), and when focus is inside it; it eases out
  1.6 s (`ZOOM_SHOWN_MS`) after the pointer has gone and the zoom has rested.
  The pointer is read from `window`, so no invisible zone sits over the canvas
  taking its clicks and drags.
- **Reachable without a pointer.** Its buttons stay in the Tab order while it
  is out; focusing one shows it (`:focus-within`). Tab order is the bar first,
  then the zoom: the zoom is the secondary control (⌘+ ⌘− ⌘0 do the same), and
  Done is where Tab should leave the bar. Each button has an `aria-label` that
  carries the key.
- **Narrow windows.** At 820 px wide and under (the window's minimum is 720),
  the centred bar would meet it, so it moves up and stands above the bar.

### Section (Checkpoints)

A **section** is a named container drawn on the checkpoints canvas, after
FigJam's (`Section.tsx`, `useSections.ts`; the rules are pure, in
`sections.ts`). Checkpoints can be put in one; carrying the section carries
them. It is for a person's own grouping ("before the update", "bug 4521"); it
is not a day, and it never deletes a checkpoint.

- **The tool.** An icon button in the bar, between Automatic and Reset layout:
  a dashed region with a small tab at its top left. `aria-pressed` while it is
  on; name "Section", tooltip "Section (S)". S turns it on and off, Esc leaves
  it, and a section drawn turns it off again (FigJam's way). While it is on the
  cursor over the canvas is a crosshair and a press anywhere draws, a card or
  a section included. It is not a mode that stays.
- **Look.** A soft body (`--accent` at 7% over what is behind it) with a
  hairline border (`--accent` at 38% into `--border-subtle`), `--radius-card`,
  its top left corner square. Its **tab** is attached above that corner,
  outside the body: `--size-lg` high, `--text-sm` in `--weight-md`, `--accent`
  at 16% over `--surface-card`, rounded on top. Strokes, the tab, the handles
  and their hit areas are drawn the same size on screen at every zoom (the
  zoom's reciprocal, `--inv`, scales them back); only the body is the
  section's size in the world. Light and dark use the same tokens.
- **The name is edited where it stands.** A click on the tab (without a drag),
  Return or F2 on the focused section turns the name into an input of the same
  face and size, selected, ringed. Return or leaving keeps it, Esc puts it
  back, an emptied name keeps the old one. A name with control or invisible
  characters, or over 80 characters (the rules of a machine's title), says why
  in a small line under the tab and the field stays; leaving it anyway puts the
  old name back. A section just drawn is "Section" ("Section 2" when that is
  taken), already in the field.
- **What a press does** (one rule, in `useSections.ts`):

  | Press on | Not selected | Selected |
  |---|---|---|
  | Tab | drag moves; a click renames | same |
  | Border (a 12 px strip on each edge) | drag moves | drag resizes (edge) |
  | Corner | not there | drag resizes |
  | Empty body | passes through: it pans the canvas, a click lets go of the selection | drag moves |
  | A card inside | the card's own: select, or drag it | same |

  So a big section filling the window never takes away panning, and a section
  is always findable by its tab and its border.
- **Selected** shows eight handles: a square at each corner and a pill at each
  edge's middle, 8 px drawn (2 px `--accent` stroke on `--surface-card`) over a
  hit area of at least 12 px (16 px at the corners) at every zoom, with the
  resize cursors, and a ring in `--accent`. A small x on the tab removes the
  section ("Remove section", tooltip says its checkpoints stay). The focus ring
  is the body's outline.
- **Grid.** The grid is 24 world units (`GRID`). Drawing, moving and resizing
  snap what moves to it (a move snaps the top left, a resize the edges it
  drags; the opposite edges stay). It is shown **only** while one of the three
  is going on: a dot at each crossing, `--text-muted` at 45%, fading in 200 ms
  and out 150 ms (`motion.md`), never permanently. Far out, where cells would
  crowd, every second or fourth crossing.
- **No touching.** Two sections are at least one cell (`GAP`, 24) apart; so is
  a section from Now (with its caption) and it may not go under the timeline's
  strip. A section being drawn, moved or resized stops at the edge instead of
  overlapping and slides along it when the pointer goes on another way; a
  drawn one beside another starts a cell from it. What is read from the file is
  made not to touch, the same way every time.
- **Cards.** A card is in the section its centre is in, decided when it is
  dropped (the section whose body holds the picture's centre); while it is
  carried the section it would join takes the accent. Cards keep their place
  relative to the section's top left, stay inside the body (kept 12 px from the
  edge, the caption plate included) and never make the section grow: a resize
  stops at the members' box with that air, and a resize by the west or north
  edge leaves them standing where they are. A section drawn or resized over
  loose cards takes in those whose centre is inside, on release. Now cannot be
  put in one.
- **Keys.** Tab reaches each section (a `group` named "Section: Name, 2
  checkpoints"), in reading order (top to bottom, left to right). Return or F2
  renames; arrows move it a cell, Shift four, stopping at what is in the way;
  Delete or Backspace removes it; Esc lets go of it. What was done is said
  quietly in a `role="status"` line (created, renamed, moved, resized,
  removed).
- **Removing** is never destructive, so it asks nothing: only the section goes,
  and its cards stay exactly where they are, as loose cards. There is no undo
  (the canvas keeps no history).

## Properties panel (Checkpoints)

The selected checkpoint's panel (`CheckpointDetails.tsx`) is a properties panel in
the way of Figma's UI3: **the values are the fields**. Nothing is a form until it
is touched. It is a **layer**, not a card (`CheckpointDetailsLayer`; the camera
and the layer's geometry are in `windows.md` → *Checkpoints*), and its content
mirrors the card's caption plate, so a person who knows the card knows the panel.
**One fact, one place:** the title, the date, the kind and the size are in the
caption and in no properties list.

- **The layer.** Flush with the window's left edge, under the traffic lights and
  above the control bar's row, `--surface-card` opaque, a hairline and
  `--elevation-modal` (square at the window's edge, `--radius-card` at the
  others), above the canvas and below Quick Look, the confirmations and the
  floating panels. It eases in from the left (`motion.md`) and, when nothing is
  selected, out the same way; it stays in the page until it has gone, is `inert`
  while it goes, and a rapid select, deselect, select turns the slide round
  rather than stacking another. Another checkpoint is a change of content, in
  place.
- **Order, top to bottom:** the picture (full width, a hairline under it; click
  or Space for Quick Look; the can't-restore banner across its foot when it
  applies); the title; when it was taken (`--text-muted`, tabular); the kind chip
  (the card's, the same words and glyph) with the size at the row's end (the
  kind's sentence is the chip's hover only); **the break**; the note; the
  properties (Tags); the actions footer. There is no title bar
  above the picture: the close button floats over its top right on an opaque
  disc, a real button in the Tab order with its tooltip.
- **The title is the heading, once.** At rest a button that reads as text
  (`--text-md`, `--weight-lg`), a quiet `--surface-control` fill on hover and a
  text cursor; a click, Return or F2 (the pattern of the machine's name above)
  swaps in an input of the same face and size, selected, ringed. Return or leaving
  keeps it, Esc puts it back (and is not also Esc to close the panel). A title
  that can't be kept says why in a line under it and the field stays; emptied, it
  says what the title falls back to. No separate "Title" or "Name" field.
- **The kind says how it came about**, in plain words and never the CLI's:
  Taken by you, Saved while idle, Fresh install, Saved on suspend, Test starting
  point. Each has one sentence, the chip's `title` and nowhere else; no "stow", "pristine" or "golden" in what a person reads. The table is
  in `windows.md` → *Checkpoints*.
- **Can't restore is a status, not a property.** When it can, nothing is
  said (compatible is the default and not worth a row). When it can't: a
  **banner across the foot of the picture**, laid over it at its full width
  (square, as the picture is), one line, ellipsis when it is too narrow: the
  warning glyph, then "Can't restore · Wrong QEMU version". Its fill is
  `--status-warning` at 80% opacity (20% see-through, so the screenshot shows
  faintly through), deepened one step toward `--text-strong` and its ink is
  `--surface-card`, so it is dark ink on the dark theme's amber and light ink on
  the light theme's brown. Over the darkest and the lightest possible picture
  that is at least 4.75:1 (light theme, over white) and 6.73:1 (dark theme, over
  black), checked in `docs/design/color.md`'s way. The whole sentence is its
  `title` and the accessible description (`aria-describedby`) of Restore, which
  is disabled with the same sentence as its tooltip. The card has the same
  banner at its full-caption zoom, "Can't restore" alone, the same tooltip; at
  lower zooms it keeps its small circular warning glyph. One verb for the whole
  feature: *restore*.
- **One break.** A single hairline separates the caption (picture, title, date,
  kind and size) from what can be changed. Nothing else in the panel draws a
  rule except the one under the picture and the one over the actions.
- **The note is text.** The first thing below the break: a borderless,
  transparent area, `--text-base`, placeholder "Add a note" in `--text-muted`;
  hover fills it, focus rings it. It grows with its text up to a sensible height
  (`--size-2xl` x 6), then scrolls. It saves itself after a pause (700 ms) and on
  leaving; there is no Save button. Esc puts back what it held when focused. A
  failed save is said quietly in the footer, in `--status-error`.
- **Properties are rows**: a `--text-muted` label column and a value, one grid
  for every row (labels start with the note's text; values start together),
  `--size-xl` high, values selectable, no heading over them. A value that can be
  edited (Tags) looks like the others until hovered or focused. There is **no
  save name** row: the technical name is not something a person reads. The way
  to the checkpoint's files is the folder button in the actions.
- **The size says what it counts**, on hover only: "Disk space on your Mac, at
  most: checkpoints share space" (card and panel). It is the memory file plus the
  disk copy's allocated blocks plus the firmware variables
  (`saves.ts` `bytes`); the disk copies are APFS clones that share blocks, so it
  overstates what deleting one would free.
- **Actions** are in the footer: Delete… (ghost, `--status-error`, icon and
  word, at the left, apart from the primary and always confirmed); then, at the
  right, two icon buttons: the **folder** (ghost, "Show in Finder": opens the
  checkpoint's folder on the Mac; `winvm saves path` names it, the shell's
  `open_folder` command opens it) and the **rewind** `⏪` (primary, "Restore
  this checkpoint", tooltip and `aria-label`). A button that can't be used is
  disabled and its tooltip says why. Restore asks first; what it says is in
  `windows.md` → *Checkpoints*.
- **Keyboard.** Focus moves to the layer when it opens and back to the card when it
  closes from inside it; Esc closes it unless a field is being edited (then it
  puts that field back first); Tab moves through the close button, the picture,
  the title, the note, Tags and the actions.

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
