# Motion

**Motion is utility, not delight.** Delight comes from typography,
spacing, and copy.

## Timings

- **150ms ease-out** — default for hover/active state changes.
- **200ms ease-out** — layout shifts (card collapse, accordion
  twirldown).
- **150ms fade** — the help popover opening (opacity only, no slide).
- **Instant** — under `prefers-reduced-motion: reduce`.
- **A control that folds away** (Checkpoints' search field easing out of its
  magnifier) — 200 ms ease-out on width and opacity.
- **A control that comes with the pointer** (Checkpoints' zoom control, lower
  left) — hidden at rest; 200 ms ease-out opacity in when the pointer nears it,
  the zoom changes or focus enters; 150 ms out, after waiting 1.6 s from the
  pointer leaving or the zoom resting (one timer, `ZOOM_SHOWN_MS`). Opacity
  only, no slide. Under reduced motion it just shows and hides.
- **The Checkpoints camera** (winvm, [`windows.md`](windows.md) →
  *Checkpoints*): 420–900 ms, cubic ease-in-out, longer for a bigger
  change of view. A flight is how that view says where a checkpoint is in
  time, so it is utility there; it still jumps under reduced motion.
- **The checkpoint's details layer** (Checkpoints, [`components.md`](components.md)
  → *Properties panel*): eases in from the window's left edge, a 220 ms slide
  (`cubic-bezier(0.16, 1, 0.3, 1)`, decelerating) with a 160 ms fade; out the
  same way, 180 ms accelerating (`cubic-bezier(0.5, 0, 0.75, 0)`), staying in the
  page until it has gone. It is a layer entering and leaving a view, so it is
  utility; no overshoot. Choosing another checkpoint replays nothing, and select,
  deselect, select turns the slide round where it is. Reduced motion: it appears
  and goes at once.
- **Entering and leaving Checkpoints**: a 200 ms / 180 ms fade of the whole
  view with a 1% settle. A mode change inside the window, not a flight into
  another one. A cut under reduced motion.
- **The section grid** (Checkpoints, [`components.md`](components.md) →
  *Section*): the dot grid is not there at rest. While a section is drawn,
  moved or resized it fades in over 200 ms ease-out and out over 150 ms
  ease-out (opacity only, no scale or slide); a section's border and fill ease
  between states at the default 150 ms. The section itself follows the pointer
  with no easing, snapping from line to line. Under reduced motion the grid
  appears and goes at once (the global duration rule).

## What's forbidden

- No bounce / spring / elastic curves.
- No parallax.
- No hover scales above 1.0 → 1.02. (Generally: no hover scales at all.)
- No staggered cascade animations (the "AI-dashboard reveal" pattern).

## Reduced-motion contract

When `prefers-reduced-motion: reduce` is set:

- All hover scales → off.
- All slide-ins / fade-up / translate animations → off. Where
  stopping an animation would leave a broken state (the busy bar's
  sliding segment), replace it with a static equivalent.
- Spring physics → off.
- The setting is honored **literally**, not "with reduced intensity."

See [`principles.md`](principles.md) → Principle 5.

## Implementation pattern

```css
.thing {
  transition: background-color 150ms ease-out,
              border-color 150ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
  }
}
```

Each window's stylesheet has one global `prefers-reduced-motion` block
like this (`styles.css` → *Motion*; the Dashboard's `style.css`), which
is preferred over per-component opt-ins (less to forget). Add a
per-component block only when zeroing the duration isn't enough.
