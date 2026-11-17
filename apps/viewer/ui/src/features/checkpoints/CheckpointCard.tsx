import { SpatialCanvasNode } from "@winvm/canvas"
import {
  type CSSProperties,
  type JSX,
  memo,
  type ReactNode,
  useState,
} from "react"

import { Icon, type IconName } from "../../components/Icon"
import { usePixelRatio } from "../../dpr"
import { t } from "../../i18n"
import { formatSize } from "../../model"
import { finderDate } from "../files/files"
import {
  type CardBox,
  type Checkpoint,
  incompatibleReason,
  noteOf,
  shownName,
} from "./checkpoints"
import { usePicture } from "./pictures"
import { Wallpaper } from "./Wallpaper"

const SHARP_WIDTH = 560

export const sharpAt = (cssWidth: number, ratio: number): boolean =>
  cssWidth * ratio > SHARP_WIDTH

const label = (key: string, values?: Record<string, string>): string =>
  t(key, values)

export const takenAt = (
  c: Pick<Checkpoint, "createdAt">,
  now: number,
): string => finderDate(Date.parse(c.createdAt), now, label).long

export const kindLabel = (kind: string): string => t(`checkpoints.kind.${kind}`)
export const kindTip = (kind: string): string =>
  t(`checkpoints.kindTip.${kind}`)

export const absoluteTime = (ms: number, locale?: string): string =>
  label("files.date.other", {
    date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
      new Date(ms),
    ),
    time: new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(
      new Date(ms),
    ),
  })

const KIND_ICON: Record<string, IconName> = {
  manual: "camera",
  auto: "timer",
  baseline: "flag",
  stow: "archive",
  golden: "flask",
}
export const kindIcon = (kind: string): IconName => KIND_ICON[kind] ?? "camera"

export function KindChip({
  kind,
  className,
}: {
  readonly kind: string
  readonly className: string
}): JSX.Element {
  return (
    <span className={className} data-kind={kind} title={kindTip(kind)}>
      <Icon name={kindIcon(kind)} />
      <span>{kindLabel(kind)}</span>
    </span>
  )
}

export function Picture({
  c,
  sharp,
  wanted,
  children,
}: {
  readonly c: Checkpoint
  readonly sharp: boolean
  readonly wanted: boolean
  readonly children?: ReactNode
}): JSX.Element {
  const thumb = usePicture(c.thumbnail, c.createdAt, wanted)
  const full = usePicture(c.screenshot, c.createdAt, wanted && sharp)
  const [broken, setBroken] = useState<readonly string[]>([])
  const src =
    [full, thumb].find((url) => url !== null && !broken.includes(url)) ?? null
  return (
    <span
      className="checkpoint__frame"
      data-empty={src === null}
      title={src === null ? t("checkpoints.noPicture") : undefined}
    >
      {src !== null ? (
        <img
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => {
            setBroken((urls) => [...urls, src])
          }}
        />
      ) : (
        <Wallpaper />
      )}
      {children}
    </span>
  )
}

export type CardLevel = "full" | "name" | "picture"

export const FULL_WIDTH = 180
export const NAME_WIDTH = 84

export const levelFor = (screenWidth: number): CardLevel =>
  screenWidth >= FULL_WIDTH
    ? "full"
    : screenWidth >= NAME_WIDTH
      ? "name"
      : "picture"

export const MIN_TEXT = 0.86

export const textScale = (cardScale: number, zoom: number): number =>
  Math.max(cardScale, MIN_TEXT / zoom)

export interface CardProps {
  readonly c: Checkpoint
  readonly box: CardBox
  readonly selected: boolean
  readonly zoom: number
  readonly now: number
  readonly dimmed: boolean
  readonly lit: boolean
  readonly carried: boolean
  readonly arriving: {
    readonly dx: number
    readonly dy: number
    readonly scale: number
  } | null
  readonly leaving: boolean
  readonly working: string | null
  onSelect: (name: string) => void
}

export function cardLabel(c: Checkpoint, now: number): string {
  const reason = incompatibleReason(c)
  const base = t("checkpoints.card.label", {
    name: shownName(c),
    kind: kindLabel(c.kind),
    when: takenAt(c, now),
    size: formatSize(c.bytes),
  })
  return `${base}${c.protected === true ? `, ${t("checkpoints.protected")}` : ""}${noteOf(c) === null ? "" : `, ${t("checkpoints.hasNotes")}`}${reason === null ? "" : `. ${t(reason)}`}`
}

export const CheckpointCard = memo(function CheckpointCard({
  c,
  box,
  selected,
  zoom,
  now,
  dimmed,
  lit,
  carried,
  arriving,
  leaving,
  working,
  onSelect,
}: CardProps): JSX.Element {
  const reason = incompatibleReason(c)
  const name = shownName(c)
  const when = takenAt(c, now)
  const note = noteOf(c)
  const screenWidth = box.width * zoom
  const ratio = usePixelRatio()
  const level = levelFor(screenWidth)
  const style = {
    "--card-scale": String(box.scale),
    "--m": String(textScale(box.scale, zoom)),
    "--frame-h": `${String(box.height)}px`,
    ...(arriving === null
      ? {}
      : {
          "--arrive-x": `${String(arriving.dx)}px`,
          "--arrive-y": `${String(arriving.dy)}px`,
          "--arrive-scale": String(arriving.scale),
        }),
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
        onClick={() => {
          onSelect(c.name)
        }}
      >
        <Picture c={c} sharp={sharpAt(screenWidth, ratio)} wanted>
          <span className="checkpoint__fit checkpoint__fit--frame">
            {reason !== null && (
              <span className="checkpoint__badge" title={t(reason)}>
                <Icon name="warning" />
                {level === "full" && <span>{t("checkpoints.cantLoad")}</span>}
              </span>
            )}
            {working !== null && (
              <span className="checkpoint__working">{working}</span>
            )}
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
                  {c.protected === true && (
                    <span
                      className="checkpoint__protected"
                      title={t("checkpoints.protected")}
                    >
                      <Icon name="lock" />
                    </span>
                  )}
                  <span
                    className="checkpoint__size"
                    title={t("checkpoints.sizeTip")}
                  >
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
