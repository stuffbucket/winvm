import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react"

import { CanvasGlyph } from "@winvm/canvas"

import { t } from "../../i18n"
import { type Tick, tickAt } from "./checkpoints"

interface TimelineProps {
  readonly ticks: readonly Tick[]
  /** The tick the view is on. */
  readonly active: string
  /** Fly there (a click, a key, the end of a drag). */
  onPick(tick: Tick): void
  /** Follow the pointer while it drags. */
  onScrub(tick: Tick): void
  onOlder(): void
  onNewer(): void
  readonly canOlder: boolean
  readonly canNewer: boolean
}

// lucide: chevron-up, chevron-down
const UP = <path d="m18 15-6-6-6 6" />
const DOWN = <path d="m6 9 6 6 6-6" />

/**
 * Time Machine's timeline, down the right edge: a tick per day with
 * checkpoints, Now at the bottom, months named where they start. Hover names
 * the day; click, drag or the arrow keys go there. The chevrons above and
 * below step one checkpoint older or newer.
 */
export function Timeline({ ticks, active, onPick, onScrub, onOlder, onNewer, canOlder, canNewer }: TimelineProps): JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Tick | null>(null)
  const dragging = useRef(false)
  const last = useRef<string | null>(null)

  const at = (clientY: number): Tick | null => {
    const r = track.current?.getBoundingClientRect()
    if (r === undefined || r.height === 0) return null
    return tickAt(ticks, (clientY - r.top) / r.height)
  }

  const down = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    dragging.current = true
    last.current = null
    e.currentTarget.setPointerCapture(e.pointerId)
    const tick = at(e.clientY)
    if (tick !== null) {
      last.current = tick.key
      onScrub(tick)
    }
  }
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const tick = at(e.clientY)
    setHover(tick)
    if (!dragging.current || tick === null || tick.key === last.current) return
    last.current = tick.key
    onScrub(tick)
  }
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    const tick = at(e.clientY)
    if (tick !== null) onPick(tick)
  }

  const index = Math.max(0, ticks.findIndex((x) => x.key === active))
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : e.key === "Home" ? -ticks.length : e.key === "End" ? ticks.length : 0
    if (step === 0) return
    e.preventDefault()
    e.stopPropagation()
    const next = ticks[Math.min(ticks.length - 1, Math.max(0, index + step))]
    if (next !== undefined) onPick(next)
  }

  const current = ticks[index]
  return (
    <nav className="timeline" aria-label={t("checkpoints.timeline")}>
      <button type="button" className="timeline__step" aria-label={t("checkpoints.older")} title={t("checkpoints.olderTip")} disabled={!canOlder} onClick={onOlder}>
        <CanvasGlyph>{UP}</CanvasGlyph>
      </button>
      <div
        ref={track}
        className="timeline__track"
        role="slider"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, ticks.length - 1)}
        aria-valuenow={index}
        aria-valuetext={current?.label ?? ""}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          dragging.current = false
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={key}
      >
        <span className="timeline__rail" aria-hidden="true" />
        {ticks.map((tick) => (
          <span
            key={tick.key}
            className="timeline__tick"
            data-kind={tick.kind}
            data-month={tick.month !== null}
            data-active={tick.key === active}
            style={{ top: `${String(tick.at * 100)}%` }}
            aria-hidden="true"
          >
            {tick.key === active && tick.kind === "day" ? (
              <span className="timeline__current">{tick.label}</span>
            ) : (
              tick.month !== null && <span className="timeline__month">{tick.month}</span>
            )}
            {tick.kind === "now" && <span className="timeline__now">{tick.label}</span>}
          </span>
        ))}
        {hover !== null && hover.kind === "day" && (
          <span className="timeline__hover" style={{ top: `${String(hover.at * 100)}%` }} aria-hidden="true">
            {hover.label}
          </span>
        )}
      </div>
      <button type="button" className="timeline__step" aria-label={t("checkpoints.newer")} title={t("checkpoints.newerTip")} disabled={!canNewer} onClick={onNewer}>
        <CanvasGlyph>{DOWN}</CanvasGlyph>
      </button>
    </nav>
  )
}
