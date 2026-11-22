# Principles & Decision Log

These bind all other design guidance. When in conflict with anything
else in `docs/design/` or any agent's intuition, **these win**.

## The five principles

1. **Speak to the person, not the file.** UI labels describe what the
   control does in human terms, not the underlying config field.
   "Take a checkpoint when Windows is idle" — not "autosave.enabled."
2. **Power lives in depth, not density.** Common controls are big,
   clear, and one click away. Advanced controls live one level down
   (collapsible sections, an "Advanced" tab, "Reveal in editor"
   escape hatch).
3. **Color is the user's, contrast is ours.** There is no user color
   picker today: every window follows the OS light/dark appearance, and
   every shipped color is checked against WCAG AA on every surface of
   both themes (see [`color.md`](color.md)). Any future user-color
   feature must honor the user's choice, compute and surface contrast
   for text and controls, and warn (not block) below AA.
4. **One accent per window.** Each window uses a single accent color,
   winvm's teal `--accent`, and reserves it for the window's primary
   action and keyboard focus, plus the states that grow out of them: the
   highlighted menu item, a checked box, progress and the resource
   meters. Nothing decorative and no text is drawn in it (teal text is
   `--link`); a second accent, or the accent spent on ornament, makes the
   primary action stop standing out.
5. **Reduced motion is a contract, not a hint.** When
   `prefers-reduced-motion: reduce` is set, animation drops to
   opacity crossfades or instant transitions. Hover scales,
   slide-ins, spring physics — all off. The setting is honored
   literally, not "with reduced intensity."

## Decision log (locked — do not revisit without cause)

Token names below; canonical values in
[`ui/src/styles/theme.ts`](../../ui/src/styles/theme.ts).

- **Crimson `--brand` is identity only.** Today it is the sun in the
  overview backdrop's drawn wallpaper (`features/overview/Backdrop.tsx`).
  Not for buttons, focus rings, or interactive states.
- **Teal `--accent` is interactive.** Primary fill, focus ring,
  highlighted menu item. Distinct from brand so neither role drowns the
  other.
- **`--link` is a sister cool tone to `--accent`** — same teal family,
  shifted per theme to clear WCAG AA against both surface levels.
  Distinct enough that a primary button (accent-filled) and an inline
  prose link don't read as the same affordance.
- **`--accent-destructive` is crimson-adjacent but NOT the same value
  as `--brand`** — a hair deeper, so it reads as "caution" rather
  than "identity."
- **Native macOS titlebar is the window identifier.** No duplicate
  in-window H1 of the window name. The H1 inside the content pane is
  the *section* name.
- **Cards are for entities, not sectioning.** Page-level grouping is
  typography's job. See [`aesthetic.md`](aesthetic.md) → *When to
  use a card*.
- **Card nesting is forbidden.** Either the inner becomes a list-row
  inside the outer, or the outer becomes a typographic section.
- **Desktop only.** No mobile layout; each window has a minimum size
  ([`layout.md`](layout.md)). Media and container queries only reflow a
  window's content as it is resized (the Checkpoints view, the Files
  window, the overview's height).
- **`Cmd-K` is reserved**, not bound. Don't repurpose it.
