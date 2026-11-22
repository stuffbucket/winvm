import { CanvasGlyph, CanvasIconButton, GLYPHS } from "@winvm/canvas"
import { type JSX, useCallback, useEffect, useRef, useState } from "react"

import { PERCENT } from "../../constants"
import { t } from "../../i18n"

const FIT = (
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>
)

export const ZOOM_SHOWN_MS = 1600
const ZOOM_NEAR_WIDTH = 160
const ZOOM_NEAR_HEIGHT = 120
const NEAR_MARGIN = 40

export interface ZoomControlProps {
  readonly zoom: number
  readonly onZoomOut: () => void
  readonly onZoomIn: () => void
  readonly onFit: () => void
}

export function pointerNear(
  point: { x: number; y: number },
  control: DOMRect,
  area: DOMRect,
): boolean {
  const right = Math.max(
    control.right + NEAR_MARGIN,
    area.left + ZOOM_NEAR_WIDTH,
  )
  const top = Math.min(
    control.top - NEAR_MARGIN,
    area.bottom - ZOOM_NEAR_HEIGHT,
  )
  return (
    point.x >= area.left &&
    point.x <= right &&
    point.y >= top &&
    point.y <= area.bottom
  )
}

export function ZoomControl(p: ZoomControlProps): JSX.Element {
  const percent = Math.round(p.zoom * PERCENT)
  const host = useRef<HTMLDivElement>(null)

  const [lingering, setLingering] = useState(false)
  const [near, setNear] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linger = useCallback((): void => {
    setLingering(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setLingering(false)
    }, ZOOM_SHOWN_MS)
  }, [])
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const lastPercent = useRef(percent)
  useEffect(() => {
    if (lastPercent.current === percent) return
    lastPercent.current = percent
    linger()
  }, [percent, linger])

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
      const area =
        el?.offsetParent?.getBoundingClientRect() ??
        el?.parentElement?.getBoundingClientRect()
      if (el === null || area === undefined || e.pointerType === "touch") return
      set(
        pointerNear(
          { x: e.clientX, y: e.clientY },
          el.getBoundingClientRect(),
          area,
        ),
      )
    }
    const leave = (): void => {
      set(false)
    }
    window.addEventListener("pointermove", move, { passive: true })
    document.documentElement.addEventListener("pointerleave", leave)
    return () => {
      window.removeEventListener("pointermove", move)
      document.documentElement.removeEventListener("pointerleave", leave)
    }
  }, [linger])

  return (
    // biome-ignore lint/a11y/useSemanticElements: the zoom control keeps its role on the element, which checkpoints.test.tsx reads as an attribute
    <div
      ref={host}
      className="checkpoints__zoom spatial-canvas__zoom"
      role="group"
      aria-label={t("checkpoints.zoom")}
      data-shown={near || lingering}
    >
      <CanvasIconButton label={t("checkpoints.zoomOut")} onClick={p.onZoomOut}>
        <CanvasGlyph>{GLYPHS.minus}</CanvasGlyph>
      </CanvasIconButton>
      <span className="checkpoints__zoom-figure">{percent}%</span>
      <CanvasIconButton label={t("checkpoints.zoomIn")} onClick={p.onZoomIn}>
        <CanvasGlyph>{GLYPHS.plus}</CanvasGlyph>
      </CanvasIconButton>
      <CanvasIconButton label={t("checkpoints.fitAll")} onClick={p.onFit}>
        <CanvasGlyph>{FIT}</CanvasGlyph>
      </CanvasIconButton>
    </div>
  )
}
