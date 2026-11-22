import {
  CanvasGlyph,
  CanvasIconButton,
  GLYPHS,
  SpatialCanvasControlGroup,
} from "@winvm/canvas"
import type { JSX, KeyboardEvent, RefObject } from "react"

import { Button } from "../../components/Button"
import { t } from "../../i18n"

const NEWEST = (
  <>
    <line x1="2" x2="5" y1="12" y2="12" />
    <line x1="19" x2="22" y1="12" y2="12" />
    <line x1="12" x2="12" y1="2" y2="5" />
    <line x1="12" x2="12" y1="19" y2="22" />
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="3" />
  </>
)
const AUTOMATIC = (
  <>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </>
)
const RESET = (
  <>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </>
)

const SECTION = (
  <>
    <path d="M3 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3" />
    <path d="M14 8h1" />
    <path d="M19 8a2 2 0 0 1 2 2" />
    <path d="M21 14v1" />
    <path d="M21 19a2 2 0 0 1-2 2" />
    <path d="M14 21h1" />
    <path d="M9 21h1" />
    <path d="M5 21a2 2 0 0 1-2-2" />
    <path d="M3 15v1" />
    <path d="M3 11v1" />
  </>
)

export interface ControlBarProps {
  readonly live: boolean
  readonly busy: boolean
  readonly creating: boolean
  readonly showAutomatic: boolean
  readonly searchOpen: boolean
  readonly query: string
  readonly inputRef: RefObject<HTMLInputElement>
  readonly matchCount: number
  readonly onNew: () => void
  readonly onNewest: () => void
  readonly onToggleAutomatic: () => void
  readonly onAutomaticHint: (on: boolean) => void
  readonly onSearchToggle: () => void
  readonly onSearchFocus: () => void
  readonly onSearchBlur: () => void
  readonly onQuery: (value: string) => void
  readonly onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void
  readonly sectionTool: boolean
  readonly onSectionTool: () => void
  readonly arranged: boolean
  readonly onReset: () => void
  readonly onDone: () => void
}

export function ControlBar(p: ControlBarProps): JSX.Element {
  const expanded = p.searchOpen || p.query !== ""

  return (
    <SpatialCanvasControlGroup label={t("checkpoints.bar")}>
      <div
        className="checkpoints__search"
        data-open={expanded}
        data-empty={p.query.trim() !== "" && p.matchCount === 0}
      >
        <div className="checkpoints__search-box">
          <CanvasIconButton
            className="checkpoints__search-toggle"
            label={t("checkpoints.search")}
            title={t("checkpoints.searchTip")}
            aria-expanded={expanded}
            tabIndex={expanded ? -1 : 0}
            onClick={p.onSearchToggle}
          >
            <CanvasGlyph>{GLYPHS.search}</CanvasGlyph>
          </CanvasIconButton>
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
            onChange={(e) => {
              p.onQuery(e.target.value)
            }}
            onKeyDown={p.onSearchKey}
          />
          {p.query !== "" && (
            <CanvasIconButton
              className="checkpoints__search-clear"
              label={t("checkpoints.searchClear")}
              onMouseDown={(e) => {
                e.preventDefault()
              }}
              onClick={() => {
                p.onQuery("")
                p.inputRef.current?.focus()
              }}
            >
              <CanvasGlyph>{GLYPHS.close}</CanvasGlyph>
            </CanvasIconButton>
          )}
        </div>
        <span className="checkpoints__sr" role="status">
          {expanded && p.query.trim() !== ""
            ? t("checkpoints.matchCount", { count: p.matchCount })
            : ""}
        </span>
      </div>
      <div className="checkpoints__bar-rest">
        <span className="checkpoints__divider" aria-hidden="true" />
        <button
          type="button"
          className="spatial-canvas__button checkpoints__new-button"
          disabled={!p.live || p.busy}
          aria-label={t("checkpoints.new")}
          aria-expanded={p.creating}
          title={
            p.live ? t("checkpoints.newTip") : t("checkpoints.needsRunning")
          }
          onClick={p.onNew}
        >
          <CanvasGlyph>{GLYPHS.plus}</CanvasGlyph>
          <span>{t("checkpoints.newShort")}</span>
        </button>
        <CanvasIconButton label={t("checkpoints.toNow")} onClick={p.onNewest}>
          <CanvasGlyph>{NEWEST}</CanvasGlyph>
        </CanvasIconButton>
        <CanvasIconButton
          label={t("checkpoints.automatic")}
          title={t(
            p.showAutomatic
              ? "checkpoints.automaticOn"
              : "checkpoints.automaticOff",
          )}
          selected={p.showAutomatic}
          onClick={p.onToggleAutomatic}
          onPointerEnter={() => {
            p.onAutomaticHint(true)
          }}
          onPointerLeave={() => {
            p.onAutomaticHint(false)
          }}
          onFocus={() => {
            p.onAutomaticHint(true)
          }}
          onBlur={() => {
            p.onAutomaticHint(false)
          }}
        >
          <CanvasGlyph>{AUTOMATIC}</CanvasGlyph>
        </CanvasIconButton>
        <CanvasIconButton
          label={t("checkpoints.section")}
          title={t("checkpoints.sectionTip")}
          selected={p.sectionTool}
          onClick={p.onSectionTool}
        >
          <CanvasGlyph>{SECTION}</CanvasGlyph>
        </CanvasIconButton>
        <CanvasIconButton
          label={t("checkpoints.reset")}
          title={t(
            p.arranged ? "checkpoints.resetTip" : "checkpoints.resetNone",
          )}
          disabled={!p.arranged}
          onClick={p.onReset}
        >
          <CanvasGlyph>{RESET}</CanvasGlyph>
        </CanvasIconButton>
        <span className="checkpoints__divider" aria-hidden="true" />
        <Button
          variant="primary"
          title={t("checkpoints.doneTip")}
          onClick={p.onDone}
        >
          {t("checkpoints.done")}
        </Button>
      </div>
    </SpatialCanvasControlGroup>
  )
}
