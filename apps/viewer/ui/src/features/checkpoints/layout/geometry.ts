import {
  clampZoom,
  fitRect,
  type Rect,
  type Size,
  type ZoomLimits,
} from "@winvm/canvas"

import {
  checkpointLayout,
  motion,
  ms,
  px,
  rem,
  spacing,
  text,
} from "../../../styles/theme"
import { union } from "../checkpoints"
import { type Section, sectionRect } from "../sections"

const PANEL_WIDTH = px(checkpointLayout.panel)
const PANEL_MIN = px(checkpointLayout.panelMin)
const CANVAS_MIN = px(checkpointLayout.canvasMin)
export const TIMELINE_SPACE = px(checkpointLayout.timelineSpace)
export const BAR_SPACE = 88
export const VIEW_MIN_WIDTH = 320

export const READABLE_FIT = 0.4
export const FAR_ZOOM = 0.3
export const NOW_TEXT = 1.25

export const PAN_STEP = 80
export const NUDGE_STEP = px(spacing[4])
export const FAST_STEP = 4
export const ZOOM_STEP = 1.25
export const WHEEL_LINE = 16

export const FIT_SNUG = 56
export const FIT_COMFORTABLE = 72
export const FIT_ROOMY = 96
const FIT_LIMIT = px(spacing[7])
export const PAN_MARGIN = 96
export const CULL_MARGIN = 360

const CONTENT_MARGIN = 120
const SECTION_TAB_ROOM = 48
export const SECTION_TAB_MIN = 96
export const GRID_MIN_STEP = 10

const ZOOM_FLOOR = 0.04
const ZOOM_OUT_CAP = 0.3
const ZOOM_FIT_SHARE = 0.85
const ZOOM_MAX = 3
export const OPENING_ZOOM_MAX = 1.1
export const DAY_ZOOM_MIN = 0.55
export const SAVED_ZOOM_SLACK = 0.04

const FOCUS_MAX_WIDTH = 320
const FOCUS_WIDTH_SHARE = 0.5
const FOCUS_HEIGHT_SHARE = 0.45

export const DAY_LABEL = rem(text.xl)
export const DAY_LABEL_MIN = rem(text.xs)
export const DAY_LABEL_ROOM = 30
export const FAR_LABEL_GAP = px(spacing[5])

export const ZOOM_FLY_MS = 260
export const PAN_FLY_MS = ms(motion.duration.lg)
export const SCRUB_FLY_MS = ms(motion.duration.xl)

export const panelSpaceFor = (viewWidth: number): number =>
  Math.max(
    PANEL_MIN,
    Math.min(PANEL_WIDTH, viewWidth - TIMELINE_SPACE - CANVAS_MIN),
  )

export const contentRect = (
  bounds: Rect,
  sections: readonly Section[],
): Rect => {
  const b =
    sections.length === 0
      ? bounds
      : union([
          bounds,
          ...sections.map((s) => ({
            ...sectionRect(s),
            y: s.y - SECTION_TAB_ROOM,
            height: s.h + SECTION_TAB_ROOM,
          })),
        ])
  return {
    x: b.x - CONTENT_MARGIN,
    y: b.y - CONTENT_MARGIN,
    width: b.width + CONTENT_MARGIN * 2,
    height: b.height + CONTENT_MARGIN * 2,
  }
}

export const zoomLimits = (content: Rect, view: Size): ZoomLimits => {
  const fit = fitRect(content, view, FIT_LIMIT).zoom
  return {
    min: Math.max(ZOOM_FLOOR, Math.min(ZOOM_OUT_CAP, fit * ZOOM_FIT_SHARE)),
    max: ZOOM_MAX,
  }
}

export const focusZoom = (
  box: Rect,
  view: Size,
  panel: number,
  limits: ZoomLimits,
): number => {
  const free = Math.max(VIEW_MIN_WIDTH, view.width - panel - TIMELINE_SPACE)
  return clampZoom(
    Math.min(
      Math.min(free * FOCUS_WIDTH_SHARE, FOCUS_MAX_WIDTH) / box.width,
      (view.height * FOCUS_HEIGHT_SHARE) / box.height,
    ),
    limits,
  )
}
