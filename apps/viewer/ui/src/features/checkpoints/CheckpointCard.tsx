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

// lucide: triangle-alert
export const WARNING = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
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

/**
 * How much of a card to draw, from how wide it is on screen. Words are drawn
 * at a size that reads at any zoom, so a card that is small has room for fewer
 * of them: first the time and size go, then the kind, then only the picture.
 */
export type CardLevel = "full" | "name" | "picture"

export const FULL_WIDTH = 168
export const NAME_WIDTH = 84

export const levelFor = (screenWidth: number): CardLevel => (screenWidth >= FULL_WIDTH ? "full" : screenWidth >= NAME_WIDTH ? "name" : "picture")

/** The least a card's words are drawn at, as a share of their size (--text-sm), on screen. */
export const MIN_TEXT = 0.86

/**
 * What a card's words are scaled by in the world: with the card (older days
 * a little smaller), but never so small they stop reading on screen.
 */
export const textScale = (cardScale: number, zoom: number): number => Math.max(cardScale, MIN_TEXT / zoom)

export interface CardProps {
  readonly c: Checkpoint
  readonly box: CardBox
  readonly selected: boolean
  /** The camera's zoom: decides thumbnail or screenshot, how big the words are and how many. */
  readonly zoom: number
  readonly now: number
  /** Not among the search's matches. */
  readonly dimmed: boolean
  /** Picked out: under the pointer on the timeline, or of the kind a filter is about. */
  readonly lit: boolean
  /** Being carried by the pointer. */
  readonly carried: boolean
  /** Just taken: flies in from the Now card, by this much (world units). */
  readonly arriving: { readonly dx: number; readonly dy: number; readonly scale: number } | null
  readonly leaving: boolean
  readonly working: string | null
  onSelect(name: string): void
}

/** One checkpoint on the canvas: its picture, and below it what it's called, when it was taken and how big it is. */
export const CheckpointCard = memo(function CheckpointCard({ c, box, selected, zoom, now, dimmed, lit, carried, arriving, leaving, working, onSelect }: CardProps): JSX.Element {
  const reason = incompatibleReason(c)
  const name = shownName(c)
  const when = takenAt(c, now)
  const kind = kindLabel(c.kind)
  const level = levelFor(box.width * zoom)
  const style = {
    "--card-scale": String(box.scale),
    "--m": String(textScale(box.scale, zoom)),
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
      data-level={level}
      data-incompatible={reason !== null}
      data-dimmed={dimmed}
      data-lit={lit}
      data-carried={carried}
      data-arriving={arriving !== null}
      data-leaving={leaving}
      data-name={c.name}
    >
      <button
        type="button"
        className="checkpoint__hit"
        style={style}
        aria-pressed={selected}
        aria-label={t("checkpoints.card.label", { name, kind, when })}
        title={level === "picture" ? `${name}, ${when}` : undefined}
        onClick={() => onSelect(c.name)}
      >
        <Picture c={c} sharp={sharpAt(box.width * zoom)} wanted>
          <span className="checkpoint__fit checkpoint__fit--frame">
            {c.kind !== "manual" && level === "full" &&<span className="checkpoint__kind">{kind}</span>}
            {reason !== null && (
              <span className="checkpoint__badge" title={t(reason)}>
                {WARNING}
                {level === "full" && <span>{t(reason)}</span>}
              </span>
            )}
            {working !== null && <span className="checkpoint__working">{working}</span>}
          </span>
        </Picture>
        {level !== "picture" && (
          <span className="checkpoint__caption checkpoint__fit">
            <span className="checkpoint__title">
              <span className="checkpoint__name">{name}</span>
              {hasNotes(c) && (
                <span className="checkpoint__notes" title={t("checkpoints.hasNotes")}>
                  {NOTE}
                </span>
              )}
            </span>
            {level === "full" && (
              <span className="checkpoint__when">
                {when}
                <span aria-hidden="true"> · </span>
                <span className="checkpoint__size">{formatSize(c.bytes)}</span>
              </span>
            )}
          </span>
        )}
      </button>
    </SpatialCanvasNode>
  )
})
