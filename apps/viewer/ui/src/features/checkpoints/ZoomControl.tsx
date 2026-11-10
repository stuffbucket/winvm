/**
 * The zoom: zoom out, the figure, zoom in, show everything. Its own small
 * control in the lower left of the window, apart from the control bar.
 *
 * It is out of the way until it is wanted: it eases in when the pointer comes
 * near the lower left, when the zoom changes (a wheel, a pinch, the keys, its
 * own buttons) and when focus is inside it, and eases out a moment after the
 * pointer has gone and the zoom has rested. Out, it takes no clicks, but its
 * buttons stay in the Tab order: focusing one brings it back.
 */
import { useEffect, useRef, useState } from "react"

import { CanvasGlyph, CanvasIconButton, GLYPHS } from "@winvm/canvas"

import { t } from "../../i18n"

// lucide: maximize
const FIT = (
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>
)

/** How long the control stays after the zoom stops changing or the pointer leaves. */
export const ZOOM_SHOWN_MS = 1600
/** The pointer wakes the control from at least this far from the window's lower left corner (logical px). */
export const ZOOM_NEAR = { width: 160, height: 120 } as const
/** …and from this far around the control itself, where it stands elsewhere (above the bar, in a narrow window). */
const NEAR_MARGIN = 40

export interface ZoomControlProps {
  readonly zoom: number
  onZoomOut(): void
  onZoomIn(): void
  onFit(): void
}

/** Whether the pointer is in the generous zone around the control: the window's lower left, and the control with some margin. */
export function pointerNear(point: { x: number; y: number }, control: DOMRect, area: DOMRect): boolean {
  const right = Math.max(control.right + NEAR_MARGIN, area.left + ZOOM_NEAR.width)
  const top = Math.min(control.top - NEAR_MARGIN, area.bottom - ZOOM_NEAR.height)
  return point.x >= area.left && point.x <= right && point.y >= top && point.y <= area.bottom
}

export function ZoomControl(p: ZoomControlProps): JSX.Element {
  const percent = Math.round(p.zoom * 100)
  const host = useRef<HTMLDivElement>(null)

  // Shown for a moment after something wakes it (the zoom changed, the pointer left), and while the pointer is near.
  const [lingering, setLingering] = useState(false)
  const [near, setNear] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linger = (): void => {
    setLingering(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setLingering(false), ZOOM_SHOWN_MS)
  }
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  // The zoom changed.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    linger()
  }, [percent])

  // The pointer, anywhere in the window: near the control or not. (A zone over the canvas would take its clicks.)
  const wasNear = useRef(false)
  useEffect(() => {
    const set = (now: boolean): void => {
      if (now === wasNear.current) return
      wasNear.current = now
      setNear(now)
      if (!now) linger()
    }
    const move = (e: PointerEvent): void => {
      const el = host.current
      const area = el?.offsetParent?.getBoundingClientRect() ?? el?.parentElement?.getBoundingClientRect()
      if (el === null || area === undefined || e.pointerType === "touch") return
      set(pointerNear({ x: e.clientX, y: e.clientY }, el.getBoundingClientRect(), area))
    }
    const leave = (): void => set(false)
    window.addEventListener("pointermove", move, { passive: true })
    document.documentElement.addEventListener("pointerleave", leave)
    return () => {
      window.removeEventListener("pointermove", move)
      document.documentElement.removeEventListener("pointerleave", leave)
    }
  }, [])

  return (
    <div ref={host} className="checkpoints__zoom spatial-canvas__zoom" role="group" aria-label={t("checkpoints.zoom")} data-shown={near || lingering}>
      <CanvasIconButton label={t("checkpoints.zoomOut")} onClick={p.onZoomOut}>
        <CanvasGlyph>{GLYPHS.minus}</CanvasGlyph>
      </CanvasIconButton>
      <span className="checkpoints__zoom-figure">
        {percent}%
      </span>
      <CanvasIconButton label={t("checkpoints.zoomIn")} onClick={p.onZoomIn}>
        <CanvasGlyph>{GLYPHS.plus}</CanvasGlyph>
      </CanvasIconButton>
      <CanvasIconButton label={t("checkpoints.fitAll")} onClick={p.onFit}>
        <CanvasGlyph>{FIT}</CanvasGlyph>
      </CanvasIconButton>
    </div>
  )
}
