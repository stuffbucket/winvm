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
