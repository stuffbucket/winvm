/**
 * The controls over the canvas, in one bar floating at the bottom of the
 * window (monimal's canvas puts its controls there too): search, New
 * Checkpoint, back to the newest, the Automatic filter, zoom, and Done.
 *
 * Search is a magnifier until it is used, then eases out to the left. The
 * zoom's figure only shows while the zoom is changing, or under the pointer
 * or focus. Everything is a button with a name and a tooltip; the keys are in
 * the tooltips, quietly.
 */
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react"

import { CanvasGlyph, CanvasIconButton, GLYPHS, SpatialCanvasControlGroup } from "@winvm/canvas"

import { Button } from "../../components/Button"
import { t } from "../../i18n"

// lucide: arrow-down-to-line, history, maximize
const NEWEST = (
  <>
    <path d="M12 17V3" />
    <path d="m6 11 6 6 6-6" />
    <path d="M19 21H5" />
  </>
)
const AUTOMATIC = (
  <>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </>
)
const FIT = (
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>
)

/** How long the zoom's figure stays after the zoom stops changing. */
export const ZOOM_FIGURE_MS = 1600

export interface ControlBarProps {
  /** Windows is running: a checkpoint can be taken. */
  readonly live: boolean
  readonly busy: boolean
  readonly creating: boolean
  readonly showAutomatic: boolean
  readonly zoom: number
  readonly searchOpen: boolean
  readonly query: string
  readonly inputRef: RefObject<HTMLInputElement>
  onNew(): void
  onNewest(): void
  onToggleAutomatic(): void
  /** The pointer or focus is on the Automatic filter: the cards it is about can be picked out. */
  onAutomaticHint(on: boolean): void
  onSearchToggle(): void
  onSearchFocus(): void
  onSearchBlur(): void
  onQuery(value: string): void
  onSearchKey(e: KeyboardEvent<HTMLInputElement>): void
  onZoomOut(): void
  onZoomIn(): void
  onFit(): void
  onDone(): void
}

export function ControlBar(p: ControlBarProps): JSX.Element {
  const expanded = p.searchOpen || p.query !== ""
  const percent = Math.round(p.zoom * 100)

  // The zoom's figure: out while the zoom rests, back when it changes.
  const [figure, setFigure] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setFigure(true)
    const timer = setTimeout(() => setFigure(false), ZOOM_FIGURE_MS)
    return () => clearTimeout(timer)
  }, [percent])

  return (
    <SpatialCanvasControlGroup label={t("checkpoints.bar")}>
      <div className="checkpoints__search" data-open={expanded}>
        <div className="checkpoints__search-field">
          <input
            ref={p.inputRef}
            type="search"
            value={p.query}
            placeholder={t("checkpoints.searchPlaceholder")}
            aria-label={t("checkpoints.search")}
            aria-controls="checkpoint-results"
            tabIndex={expanded ? 0 : -1}
            autoComplete="off"
            spellCheck={false}
            onFocus={p.onSearchFocus}
            onBlur={p.onSearchBlur}
            onChange={(e) => p.onQuery(e.target.value)}
            onKeyDown={p.onSearchKey}
          />
        </div>
        <CanvasIconButton label={t("checkpoints.search")} title={t("checkpoints.searchTip")} aria-expanded={expanded} onClick={p.onSearchToggle}>
          <CanvasGlyph>{GLYPHS.search}</CanvasGlyph>
        </CanvasIconButton>
      </div>
      <span className="checkpoints__divider" aria-hidden="true" />
      <button
        type="button"
        className="spatial-canvas__button checkpoints__new-button"
        disabled={!p.live || p.busy}
        aria-label={t("checkpoints.new")}
        aria-expanded={p.creating}
        title={p.live ? t("checkpoints.newTip") : t("checkpoints.needsRunning")}
        onClick={p.onNew}
      >
        <CanvasGlyph>{GLYPHS.plus}</CanvasGlyph>
        <span>{t("checkpoints.newShort")}</span>
      </button>
      <CanvasIconButton label={t("checkpoints.toNow")} onClick={p.onNewest}>
        <CanvasGlyph>{NEWEST}</CanvasGlyph>
      </CanvasIconButton>
      <span onPointerEnter={() => p.onAutomaticHint(true)} onPointerLeave={() => p.onAutomaticHint(false)} onFocus={() => p.onAutomaticHint(true)} onBlur={() => p.onAutomaticHint(false)}>
        <CanvasIconButton
          label={t("checkpoints.automatic")}
          title={t(p.showAutomatic ? "checkpoints.automaticOn" : "checkpoints.automaticOff")}
          selected={p.showAutomatic}
          onClick={p.onToggleAutomatic}
        >
          <CanvasGlyph>{AUTOMATIC}</CanvasGlyph>
        </CanvasIconButton>
      </span>
      <span className="checkpoints__divider" aria-hidden="true" />
      <div className="checkpoints__zoom" role="group" aria-label={t("checkpoints.zoom")} data-figure={figure}>
        <CanvasIconButton label={t("checkpoints.zoomOut")} onClick={p.onZoomOut}>
          <CanvasGlyph>{GLYPHS.minus}</CanvasGlyph>
        </CanvasIconButton>
        <span className="checkpoints__zoom-figure" aria-hidden="true">
          <span>{percent}%</span>
        </span>
        <CanvasIconButton label={t("checkpoints.zoomIn")} onClick={p.onZoomIn}>
          <CanvasGlyph>{GLYPHS.plus}</CanvasGlyph>
        </CanvasIconButton>
        <CanvasIconButton label={t("checkpoints.fitAll")} onClick={p.onFit}>
          <CanvasGlyph>{FIT}</CanvasGlyph>
        </CanvasIconButton>
      </div>
      <span className="checkpoints__divider" aria-hidden="true" />
      <Button variant="primary" title={t("checkpoints.doneTip")} onClick={p.onDone}>
        {t("checkpoints.done")}
      </Button>
    </SpatialCanvasControlGroup>
  )
}
