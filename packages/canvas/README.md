# @winvm/canvas

An infinite canvas for React: a viewport that pans and zooms, a dot grid that
stays anchored to it, a scene layer that carries the camera's transform, and
the chrome that floats over it (top bar, zoom controls, side panel, search
results). The camera eases in and out of every move. The winvm app's
checkpoints view is built on it
(`apps/viewer/ui/src/features/checkpoints/`).

The camera maps a world point to the viewport as
`screen = world * zoom + (x, y)`. `useCanvasCamera` holds one: `set` jumps,
`fly` eases there (log-space zoom, the centre moving with the scale, so a
flight pans while zoomed out and zooms in once it is over the target), and
`prefers-reduced-motion: reduce` turns every flight into a jump. The pure
helpers (`zoomAround`, `fitRect`, `cameraForScreenRect`, `clampPan`,
`clampCamera`, `visibleWorld`, `interpolateCamera`) are what the app lays
things out and clamps with.

## Where it came from

monimal's spatial canvas, at monimal commit `fb29a8d`
(github.com/stuffbucket/monimal). monimal is stuffbucket's own repository and
its owner has confirmed its code is MIT-licensed; this copy is published under
winvm's MIT license.

| Here | monimal |
| --- | --- |
| `src/SpatialCanvas.tsx` | `packages/maximal-design-system/src/components/spatial-canvas/spatial-canvas.tsx` (root, viewport and grid, scene, marquee) |
| `src/SpatialCanvasChrome.tsx` | `…/spatial-canvas/spatial-canvas-chrome.tsx` (top bar, corner, control group, floating and side panels, zoom controls) |
| `src/SpatialCanvasSearch.tsx` | `…/spatial-canvas/spatial-canvas-search.tsx` |
| `src/SpatialCanvasSurface.tsx` | `…/spatial-canvas/spatial-canvas-surface.tsx` |
| `src/cursors.ts` | `…/spatial-canvas/spatial-canvas-cursor-glyph.tsx` (`SPATIAL_CANVAS_CURSORS`) |
| `src/camera.ts` | `packages/maximal-project-browser/src/view.ts` (the camera, `clampZoom`, `wheelZoomFactor`, `screenToWorld`, `editableTarget`, `useRafCamera`) |
| `src/canvas.css` | `packages/maximal-design-system/src/styles/spatial-canvas.css`, the rules for the parts kept |
| `tests/canvas.test.tsx` | `…/spatial-canvas/spatial-canvas.test.tsx`, moved from Vitest and jsdom to `bun:test` and happy-dom |

## What was left out

- monimal's whiteboard: project cards, sticky notes, shapes, sections,
  connectors and their handles, comment pins, threads and the composer
  (`spatial-canvas-discussion.tsx`), collaborators' cursors and avatars,
  page tabs and the project switcher, and the tool buttons.
- `lucide-react`: the few glyphs the chrome needs are inline Lucide paths
  (`GLYPHS`), as the winvm app draws its icons.
- The design system's Dialog, IconButton, Button, Tooltip and TextInput.
- monimal's Storybook stories, lint and mutation testing.

## Changed here

- Every word is a prop (zoom controls' `labels`, the side panel's
  `closeLabel`, search's `label`), so the app's catalog supplies them.
- `SpatialCanvasSurface` is a portal of its own with `role="dialog"`, a Tab
  trap and focus returned on close, instead of monimal's Dialog, so the app
  decides what Escape does; `phase` ("entering", "open", "leaving") lets
  CSS ease it in and out.
- `SpatialCanvasNode` and `SpatialCanvasLabel` position any content in world
  space, where monimal had one component per kind of thing.
- Search results take an icon, a second line and an active (arrow-key)
  state.
- `camera.ts` adds zooming about a point, fitting, clamping, the visible
  world rectangle, `interpolateCamera`, `flightDuration` and
  `useCanvasCamera`.
- `canvas.css` uses winvm's tokens (`--surface-*`, `--text-*`,
  `--border-*`, `--accent`, `--space-*`, `--radius-*`), defined by the host
  page, in place of monimal's `--maximal-color-*` and `--spacer-*`. monimal's
  copy has a missing semicolon after `.spatial-canvas__controls`'s
  `margin-inline: auto`, which swallowed the viewport rule; the viewport's
  rule stands on its own here.

To take a newer monimal, diff those files against these and carry the
changes above across.
