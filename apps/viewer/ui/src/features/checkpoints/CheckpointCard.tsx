import { memo, type CSSProperties, type ReactNode } from "react"

import { SpatialCanvasNode } from "@winvm/canvas"

import { t } from "../../i18n"
import { formatSize } from "../../model"
import { finderDate } from "../files/files"
import { type CardBox, type Checkpoint, hasNotes, incompatibleReason, shownName } from "./checkpoints"
import { usePicture } from "./pictures"

/** Above this many device pixels wide, a card shows the full screenshot rather than the 480 px thumbnail. */
const SHARP_WIDTH = 560

const sharpAt = (cssWidth: number): boolean => cssWidth * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1) > SHARP_WIDTH

const label = (key: string, values?: Record<string, string>): string => t(key, values)

/** "Today at 1:33 PM", as Finder says it. */
export const takenAt = (c: Pick<Checkpoint, "createdAt">, now: number): string => finderDate(Date.parse(c.createdAt), now, label).long

export const kindLabel = (kind: string): string => t(`checkpoints.kind.${kind}`)

// lucide: monitor, notebook-pen
export const MONITOR = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </svg>
)

export const NOTE = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" />
    <path d="M2 6h4" />
    <path d="M2 10h4" />
    <path d="M2 14h4" />
    <path d="M2 18h4" />
    <path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" />
  </svg>
)

/** A checkpoint's picture: the screenshot when the card is big on screen, the thumbnail otherwise, a placeholder before either. */
export function Picture({ c, sharp, wanted, children }: { readonly c: Checkpoint; readonly sharp: boolean; readonly wanted: boolean; readonly children?: ReactNode }): JSX.Element {
  const thumb = usePicture(c.thumbnail, c.createdAt, wanted)
  const full = usePicture(c.screenshot, c.createdAt, wanted && sharp)
  const src = full ?? thumb
  return (
    <span className="checkpoint__frame" data-empty={src === null}>
      {src !== null ? (
        <img src={src} alt="" draggable={false} decoding="async" />
      ) : (
        <span className="checkpoint__placeholder">
          {MONITOR}
          {c.thumbnail === null && c.screenshot === null && <span>{t("checkpoints.noPicture")}</span>}
        </span>
      )}
      {children}
    </span>
  )
}

export interface CardProps {
  readonly c: Checkpoint
  readonly box: CardBox
  readonly selected: boolean
  /** Its width on screen, in CSS pixels: decides thumbnail or screenshot. */
  readonly screenWidth: number
  readonly now: number
  /** Not among the search's matches. */
  readonly dimmed: boolean
  /** Just taken: flies in from the Now card, by this much (world units). */
  readonly arriving: { readonly dx: number; readonly dy: number; readonly scale: number } | null
  readonly leaving: boolean
  readonly working: string | null
  onSelect(name: string): void
}

/** One checkpoint on the canvas: its picture, what it's called, when, what kind, its size, and whether it loads here. */
export const CheckpointCard = memo(function CheckpointCard({ c, box, selected, screenWidth, now, dimmed, arriving, leaving, working, onSelect }: CardProps): JSX.Element {
  const reason = incompatibleReason(c)
  const name = shownName(c)
  const when = takenAt(c, now)
  const style = {
    "--card-scale": String(box.scale),
    ...(arriving === null ? {} : { "--arrive-x": `${String(arriving.dx)}px`, "--arrive-y": `${String(arriving.dy)}px`, "--arrive-scale": String(arriving.scale) }),
  } as CSSProperties
  return (
    <SpatialCanvasNode
      x={box.x}
      y={box.y}
      width={box.width}
      height={box.height}
      selected={selected}
      className="checkpoint"
      data-kind={c.kind}
      data-incompatible={reason !== null}
      data-dimmed={dimmed}
      data-arriving={arriving !== null}
      data-leaving={leaving}
      data-name={c.name}
    >
      <button
        type="button"
        className="checkpoint__hit"
        style={style}
        aria-pressed={selected}
        aria-label={t("checkpoints.card.label", { name, when })}
        onClick={() => onSelect(c.name)}
      >
        <Picture c={c} sharp={sharpAt(screenWidth)} wanted>
          {reason !== null && <span className="checkpoint__badge">{t(reason)}</span>}
          {working !== null && <span className="checkpoint__working">{working}</span>}
        </Picture>
        <span className="checkpoint__caption">
          <span className="checkpoint__title">
            <span className="checkpoint__name">{name}</span>
            {hasNotes(c) && (
              <span className="checkpoint__notes" title={t("checkpoints.hasNotes")}>
                {NOTE}
              </span>
            )}
          </span>
          <span className="checkpoint__when">{when}</span>
          <span className="checkpoint__meta">
            <span className="checkpoint__kind">{kindLabel(c.kind)}</span>
            <span>{formatSize(c.bytes)}</span>
          </span>
        </span>
      </button>
    </SpatialCanvasNode>
  )
})
