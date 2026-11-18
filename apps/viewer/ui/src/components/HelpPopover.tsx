import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"

import { t } from "../i18n"
import { px, spacing } from "../styles/theme"
import { Icon } from "./Icon"

export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Placement {
  readonly left: number
  readonly top: number
  readonly side: "right" | "left" | "below" | "above" | "over"
  readonly maxHeight: number
}

export function placeNear(
  anchor: Box,
  panel: Size,
  view: Size,
  gap: number,
  margin: number,
): Placement {
  const clamp = (n: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(n, hi))
  const roomY = view.height - 2 * margin
  const height = Math.min(panel.height, roomY)
  const across = clamp(
    anchor.top + anchor.height / 2 - height / 2,
    margin,
    Math.max(margin, view.height - margin - height),
  )
  const along = clamp(
    anchor.left,
    margin,
    Math.max(margin, view.width - margin - panel.width),
  )
  const right = anchor.left + anchor.width + gap
  if (right + panel.width <= view.width - margin)
    return { left: right, top: across, side: "right", maxHeight: roomY }
  const left = anchor.left - gap - panel.width
  if (left >= margin)
    return { left, top: across, side: "left", maxHeight: roomY }
  const below = view.height - margin - (anchor.top + anchor.height + gap)
  const above = anchor.top - gap - margin
  if (panel.height <= below)
    return {
      left: along,
      top: anchor.top + anchor.height + gap,
      side: "below",
      maxHeight: below,
    }
  if (panel.height <= above)
    return {
      left: along,
      top: anchor.top - gap - panel.height,
      side: "above",
      maxHeight: above,
    }
  return {
    left: clamp(
      (view.width - panel.width) / 2,
      margin,
      Math.max(margin, view.width - margin - panel.width),
    ),
    top: margin,
    side: "over",
    maxHeight: roomY,
  }
}

const GAP = px(spacing[3])

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface HelpPopoverProps {
  readonly anchor: HTMLElement | null
  readonly title: string
  readonly media?: ReactNode
  readonly footer?: ReactNode
  readonly scope?: HTMLElement | null
  readonly onClose: () => void
  readonly onStep?: (delta: -1 | 1) => void
  readonly children: ReactNode
}

export function HelpPopover({
  anchor,
  title,
  media,
  footer,
  scope,
  onClose,
  onStep,
  children,
}: HelpPopoverProps): JSX.Element {
  const panel = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<Placement | null>(null)
  const titleId = useId()
  const latest = useRef({ onClose, onStep, anchor, scope })
  latest.current = { onClose, onStep, anchor, scope }

  // biome-ignore lint/correctness/useExhaustiveDependencies: new children or media change the panel's size, so it is placed again
  useLayoutEffect(() => {
    const measure = (): void => {
      const el = panel.current
      if (anchor === null || el === null) return
      const r = anchor.getBoundingClientRect()
      el.style.maxHeight = "none"
      const next = placeNear(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        GAP,
        GAP,
      )
      el.style.maxHeight = ""
      setPlace((cur) =>
        cur !== null &&
        cur.left === next.left &&
        cur.top === next.top &&
        cur.maxHeight === next.maxHeight &&
        cur.side === next.side
          ? cur
          : next,
      )
    }
    measure()
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [anchor, children, media])

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent): void => {
      const { onClose: close, onStep: step } = latest.current
      if (e.key === "Escape") {
        e.stopPropagation()
        close()
      } else if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        step !== undefined &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const inside = panel.current?.contains(document.activeElement) === true
        if (inside) {
          e.preventDefault()
          step(e.key === "ArrowLeft" ? -1 : 1)
        }
      }
    }
    const press = (e: PointerEvent): void => {
      const target = e.target as Node
      const { anchor: a, scope: s, onClose: close } = latest.current
      if (
        panel.current?.contains(target) === true ||
        a?.contains(target) === true ||
        s?.contains(target) === true
      )
        return
      close()
    }
    window.addEventListener("keydown", key, true)
    window.addEventListener("pointerdown", press, true)
    return () => {
      window.removeEventListener("keydown", key, true)
      window.removeEventListener("pointerdown", press, true)
    }
  }, [])

  useEffect(() => {
    const el = panel.current
    el?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      const lost =
        active === null ||
        active === document.body ||
        el?.contains(active) === true
      if (lost) latest.current.anchor?.focus({ preventScroll: true })
    }
  }, [])

  const tab = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Tab") return
    const el = panel.current
    if (el === null) return
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items[items.length - 1]
    if (first === undefined || last === undefined) return
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      ref={panel}
      className="help"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-side={place?.side}
      onKeyDown={tab}
      style={
        place === null
          ? { visibility: "hidden" }
          : { left: place.left, top: place.top, maxHeight: place.maxHeight }
      }
    >
      {media !== undefined && <div className="help__media">{media}</div>}
      <div className="help__body">
        <div className="help__head">
          <h2 className="help__title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label={t("help.close")}
            title={t("help.close")}
            onClick={onClose}
          >
            <Icon name="cross" />
          </button>
        </div>
        {children}
      </div>
      {footer !== undefined && <div className="help__foot">{footer}</div>}
    </div>,
    document.body,
  )
}
