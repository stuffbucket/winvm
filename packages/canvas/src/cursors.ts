/**
 * The canvas's pointer cursors, from monimal's
 * `spatial-canvas-cursor-glyph.tsx` (SPATIAL_CANVAS_CURSORS). monimal also
 * draws each one as a Lucide glyph for collaborators' cursors; there are no
 * collaborators here, so only the CSS cursor names came across.
 */
export const SPATIAL_CANVAS_CURSORS = {
  select: "default",
  pan: "grab",
  panning: "grabbing",
  crosshair: "crosshair",
  text: "text",
  move: "move",
  unavailable: "not-allowed",
  action: "pointer",
} as const

export type SpatialCanvasCursorState = keyof typeof SPATIAL_CANVAS_CURSORS
