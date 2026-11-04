import { memo, type CSSProperties, type ReactNode } from "react"

import { SpatialCanvasNode } from "@winvm/canvas"

import { Icon, type IconName } from "../../components/Icon"
import { usePixelRatio } from "../../dpr"
import { t } from "../../i18n"
import { formatSize } from "../../model"
import { finderDate } from "../files/files"
import { type CardBox, type Checkpoint, incompatibleReason, noteOf, shownName } from "./checkpoints"
import { usePicture } from "./pictures"

/** Above this many device pixels wide, a card shows the full screenshot rather than the 480 px thumbnail. */
const SHARP_WIDTH = 560

/** Whether a card `cssWidth` CSS pixels wide is big enough on a display of this pixel ratio to want the full screenshot. */
export const sharpAt = (cssWidth: number, ratio: number): boolean => cssWidth * ratio > SHARP_WIDTH

const label = (key: string, values?: Record<string, string>): string => t(key, values)

/** "Today at 1:33 PM", as Finder says it. */
export const takenAt = (c: Pick<Checkpoint, "createdAt">, now: number): string => finderDate(Date.parse(c.createdAt), now, label).long

/** How a checkpoint came to be, in words ("Saved on suspend"), the same on the card and in the panel. */
export const kindLabel = (kind: string): string => t(`checkpoints.kind.${kind}`)
/** The same in a sentence: what made it. Its tooltip, and the panel's line under the chip. */
export const kindTip = (kind: string): string => t(`checkpoints.kindTip.${kind}`)

/** "Nov 3, 2026 at 3:30 PM": the date spelled out, in the words a card's time uses for any day but today and yesterday. What an unnamed checkpoint is called. */
export const absoluteTime = (ms: number, locale?: string): string =>
  label("files.date.other", {
    date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(ms)),
    time: new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(ms)),
  })

/** How a checkpoint came to be, as a glyph: somebody took it, it was taken on its own, first start, put away, for tests. */
const KIND_ICON: Record<string, IconName> = { manual: "camera", auto: "timer", baseline: "flag", stow: "archive", golden: "flask" }
export const kindIcon = (kind: string): IconName => KIND_ICON[kind] ?? "camera"

/** The kind's chip: its glyph and words, the sentence that says what made it as the tooltip. The card's and the panel's. */
export function KindChip({ kind, className }: { readonly kind: string; readonly className: string }): JSX.Element {
  return (
    <span className={className} data-kind={kind} title={kindTip(kind)}>
      <Icon name={kindIcon(kind)} />
      <span>{kindLabel(kind)}</span>
    </span>
  )
}

// lucide: monitor
export const MONITOR = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
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
 * of them: first the time, kind, size and note go, then the name, leaving only
 * the picture (and no caption plate).
 */
export type CardLevel = "full" | "name" | "picture"

/** Wide enough, on screen, for the longest date at its least size beside the plate's padding. */
export const FULL_WIDTH = 180
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

/** What a card's accessible name says: every fact it shows, and whether it can load here. */
export function cardLabel(c: Checkpoint, now: number): string {
  const reason = incompatibleReason(c)
  const base = t("checkpoints.card.label", { name: shownName(c), kind: kindLabel(c.kind), when: takenAt(c, now), size: formatSize(c.bytes) })
  return `${base}${noteOf(c) === null ? "" : `, ${t("checkpoints.hasNotes")}`}${reason === null ? "" : `. ${t(reason)}`}`
}

/**
 * One checkpoint on the canvas: one surface, the picture on top and its
 * caption plate attached below, so selecting, hovering, carrying and the
 * highlight ring all take the whole of it. The plate holds, by position and
 * weight: its name (strong); when it was taken (muted); how it came to be
 * (the kind's chip, with its glyph) and its size, right-aligned; and, only if
 * there is one, its note, marked with the notebook. Absent data is absent.
 */
export const CheckpointCard = memo(function CheckpointCard({ c, box, selected, zoom, now, dimmed, lit, carried, arriving, leaving, working, onSelect }: CardProps): JSX.Element {
  const reason = incompatibleReason(c)
  const name = shownName(c)
  const when = takenAt(c, now)
  const note = noteOf(c)
  const screenWidth = box.width * zoom
  // Read through the hook: the window may be moved to a display of another ratio, which resizes nothing.
  const ratio = usePixelRatio()
  const level = levelFor(screenWidth)
  const style = {
    "--card-scale": String(box.scale),
    "--m": String(textScale(box.scale, zoom)),
    "--frame-h": `${String(box.height)}px`,
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
        aria-label={cardLabel(c, now)}
        title={level === "picture" ? `${name}, ${when}` : undefined}
        onClick={() => onSelect(c.name)}
      >
        <Picture c={c} sharp={sharpAt(screenWidth, ratio)} wanted>
          <span className="checkpoint__fit checkpoint__fit--frame">
            {reason !== null && (
              <span className="checkpoint__badge" title={t(reason)}>
                <Icon name="warning" />
                {level === "full" && <span>{t("checkpoints.cantLoad")}</span>}
              </span>
            )}
            {working !== null && <span className="checkpoint__working">{working}</span>}
          </span>
        </Picture>
        {level !== "picture" && (
          <span className="checkpoint__caption">
            <span className="checkpoint__name">{name}</span>
            {level === "full" && (
              <>
                <span className="checkpoint__when">{when}</span>
                <span className="checkpoint__facts">
                  <KindChip kind={c.kind} className="checkpoint__kind" />
                  <span className="checkpoint__size" title={t("checkpoints.sizeTip")}>
                    {formatSize(c.bytes)}
                  </span>
                </span>
                {note !== null && (
                  <span className="checkpoint__note" title={note.full}>
                    <Icon name="notes" />
                    <span>{note.line}</span>
                  </span>
                )}
              </>
            )}
          </span>
        )}
      </button>
    </SpatialCanvasNode>
  )
})
