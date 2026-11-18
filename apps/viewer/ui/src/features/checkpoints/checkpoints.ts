import type { Point, Rect } from "@winvm/canvas"

import type { SaveEntry } from "../../model"
import { px, spacing } from "../../styles/theme"

export type Checkpoint = SaveEntry & {
  readonly protected?: boolean | undefined
}

export type CheckpointFormat = "zstd" | "mapped"

export const formatLabelKey = (format: string | undefined): string =>
  format === "zstd" || format === "mapped" || format === "raw"
    ? `checkpoints.format.${format}`
    : "checkpoints.format.unknown"

export const canProtect = (c: Pick<Checkpoint, "kind" | "name">): boolean =>
  c.kind !== "stow" && c.name !== "stow"

const CARD_WIDTH = 240
const CARD_FRAME = 150
const NOW_WIDTH = 440
const COLUMN_GAP = px(spacing[6])
const LINE_GAP = 128
export const DAY_GAP = 176
const NOW_GAP = 144
export const CAPTION_ROOM = 120
export const DEPTH_STEP = 0.93
export const DEPTH_MIN = 0.62
const COLUMNS = 6

export const LABEL_LIFT = 14

export interface CardBox extends Rect {
  readonly name: string
  readonly frame: number
  readonly scale: number
  readonly day: number
  readonly index: number
}

export interface DayBlock extends Rect {
  readonly key: string
  readonly date: Date
  readonly scale: number
  readonly label: Point
  readonly names: readonly string[]
}

export interface TimelineLayout {
  readonly now: Rect & { readonly frame: number }
  readonly days: readonly DayBlock[]
  readonly cards: ReadonlyMap<string, CardBox>
  readonly order: readonly string[]
  readonly bounds: Rect
}

const pad = (n: number): string => String(n).padStart(2, "0")

export function dayKey(d: Date): string {
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const midnight = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate())

function byTime(a: Checkpoint, b: Checkpoint): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    a.name.localeCompare(b.name)
  )
}

export const depthScale = (daysFromFront: number): number =>
  Math.max(DEPTH_MIN, DEPTH_STEP ** daysFromFront)

export function layoutTimeline(
  checkpoints: readonly Checkpoint[],
  nowAspect: number,
  columns = COLUMNS,
): TimelineLayout {
  const sorted = [...checkpoints].sort(byTime)
  const order = sorted.map((c) => c.name)
  const groups = new Map<string, Checkpoint[]>()
  for (const c of sorted) {
    const key = dayKey(new Date(c.createdAt))
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [c])
    else list.push(c)
  }

  const nowFrame = Math.round(
    NOW_WIDTH /
      (Number.isFinite(nowAspect) && nowAspect > 0 ? nowAspect : 16 / 10),
  )
  const now = {
    x: -NOW_WIDTH / 2,
    y: 0,
    width: NOW_WIDTH,
    height: nowFrame,
    frame: nowFrame,
  }

  const keys = [...groups.keys()].reverse()
  const days: DayBlock[] = []
  const boxes: CardBox[] = []
  let bottom = -NOW_GAP
  keys.forEach((key, back) => {
    const list = groups.get(key) ?? []
    const scale = depthScale(back)
    const w = CARD_WIDTH * scale
    const h = CARD_FRAME * scale
    const cols = Math.min(columns, list.length)
    const lines = Math.ceil(list.length / columns)
    const width = cols * w + (cols - 1) * COLUMN_GAP * scale
    const height = lines * h + (lines - 1) * LINE_GAP * scale
    const top = bottom - height
    const left = -width / 2
    list.forEach((c, i) => {
      const line = Math.floor(i / columns)
      const col = i % columns
      const inLine = line === lines - 1 ? list.length - line * columns : cols
      const lineLeft = left + ((cols - inLine) * (w + COLUMN_GAP * scale)) / 2
      boxes.push({
        name: c.name,
        x: lineLeft + col * (w + COLUMN_GAP * scale),
        y: top + line * (h + LINE_GAP * scale),
        width: w,
        height: h,
        frame: CARD_FRAME * scale,
        scale,
        day: keys.length - 1 - back,
        index: 0,
      })
    })
    const first = list[0]
    days.push({
      key,
      date: midnight(
        first === undefined ? new Date() : new Date(first.createdAt),
      ),
      x: left,
      y: top,
      width,
      height,
      scale,
      label: { x: left, y: top - LABEL_LIFT * scale },
      names: list.map((c) => c.name),
    })
    bottom = top - DAY_GAP * scale
  })
  days.reverse()

  const indexOf = new Map(order.map((n, i) => [n, i]))
  const cards = new Map(
    boxes.map((b) => [b.name, { ...b, index: indexOf.get(b.name) ?? 0 }]),
  )

  const all: Rect[] = [now, ...days.map(withLabel)]
  const x0 = Math.min(...all.map((r) => r.x))
  const y0 = Math.min(...all.map((r) => r.y))
  const x1 = Math.max(...all.map((r) => r.x + r.width))
  const y1 = Math.max(...all.map((r) => r.y + r.height)) + CAPTION_ROOM
  return {
    now,
    days,
    cards,
    order,
    bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  }
}

export type Moves = Readonly<
  Record<string, { readonly x: number; readonly y: number }>
>

export function placeCards(
  layout: TimelineLayout,
  moves: Moves,
): TimelineLayout {
  const cards = new Map(layout.cards)
  const moved: Rect[] = []
  for (const [name, by] of Object.entries(moves)) {
    const box = cards.get(name)
    if (box === undefined || (by.x === 0 && by.y === 0)) continue
    const placed = { ...box, x: box.x + by.x, y: box.y + by.y }
    cards.set(name, placed)
    moved.push({ ...placed, height: placed.height + CAPTION_ROOM })
  }
  if (moved.length === 0) return layout
  return { ...layout, cards, bounds: union([layout.bounds, ...moved]) }
}

export function dayGroup(
  day: Pick<
    DayBlock,
    "names" | "scale" | "label" | "x" | "y" | "width" | "height"
  >,
  cards: ReadonlyMap<string, Rect>,
): { readonly rect: Rect; readonly label: Point } {
  const boxes = day.names.flatMap((n) => {
    const b = cards.get(n)
    return b === undefined ? [] : [b]
  })
  if (boxes.length === 0)
    return {
      rect: { x: day.x, y: day.y, width: day.width, height: day.height },
      label: day.label,
    }
  const link = LINE_GAP * day.scale + 0.5
  const gap = (
    a: Rect,
    b: Rect,
  ): { readonly x: number; readonly y: number } => ({
    x: Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)),
    y: Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)),
  })
  const cluster = boxes.map((_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (cluster[r] !== r) r = cluster[r] ?? r
    return r
  }
  boxes.forEach((a, i) => {
    boxes.slice(0, i).forEach((b, j) => {
      const g = gap(a, b)
      if (g.x <= link && g.y <= link)
        cluster[Math.max(find(i), find(j))] = Math.min(find(i), find(j))
    })
  })
  const sizes = new Map<number, number>()
  boxes.forEach((_, i) => {
    sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1)
  })
  let best = find(0)
  for (const [root, n] of sizes) if (n > (sizes.get(best) ?? 0)) best = root
  const mine = boxes.filter((_, i) => find(i) === best)
  const rect = union(mine)
  return { rect, label: { x: rect.x, y: rect.y - LABEL_LIFT * day.scale } }
}

export const withLabel = (
  d: Pick<DayBlock, "x" | "y" | "width" | "height" | "scale">,
): Rect => ({
  x: d.x,
  y: d.y - 44 * d.scale,
  width: d.width,
  height: d.height + 44 * d.scale,
})

export const frameOf = (box: Rect & { readonly frame: number }): Rect => ({
  x: box.x,
  y: box.y,
  width: box.width,
  height: box.frame,
})

export function union(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.width))
  const y1 = Math.max(...rects.map((r) => r.y + r.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export function openingView(layout: TimelineLayout): Rect {
  const recent = layout.days.slice(-2)
  return union([layout.now, ...recent.map(withLabel)])
}

export interface Tick {
  readonly kind: "day" | "now"
  readonly key: string
  readonly at: number
  readonly month: string | null
  readonly label: string
  readonly day: number | null
}

export interface TickWords {
  readonly now: string
  readonly today: string
  readonly yesterday: string
  readonly locale?: string
}

const daysBetween = (a: Date, b: Date): number =>
  Math.round((midnight(b).getTime() - midnight(a).getTime()) / 86_400_000)

export function dayLabel(date: Date, now: Date, words: TickWords): string {
  const ago = daysBetween(date, now)
  if (ago === 0) return words.today
  if (ago === 1) return words.yesterday
  if (ago > 1 && ago < 7)
    return new Intl.DateTimeFormat(words.locale, { weekday: "long" }).format(
      date,
    )
  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(
    words.locale,
    sameYear ? { month: "long", day: "numeric" } : { dateStyle: "medium" },
  ).format(date)
}

export function timelineTicks(
  days: readonly Pick<DayBlock, "key" | "date">[],
  now: Date,
  words: TickWords,
): Tick[] {
  const n = days.length
  const out: Tick[] = days.map((d, i) => {
    const prev = days[i - 1]
    const newMonth =
      prev === undefined ||
      prev.date.getMonth() !== d.date.getMonth() ||
      prev.date.getFullYear() !== d.date.getFullYear()
    const month = newMonth
      ? new Intl.DateTimeFormat(
          words.locale,
          d.date.getFullYear() === now.getFullYear()
            ? { month: "long" }
            : { month: "long", year: "numeric" },
        ).format(d.date)
      : null
    return {
      kind: "day",
      key: d.key,
      at: n === 0 ? 0 : i / n,
      month,
      label: dayLabel(d.date, now, words),
      day: i,
    }
  })
  out.push({
    kind: "now",
    key: "now",
    at: 1,
    month: null,
    label: words.now,
    day: null,
  })
  return out
}

export function tickAt(ticks: readonly Tick[], at: number): Tick | null {
  let best: Tick | null = null
  for (const t of ticks)
    if (best === null || Math.abs(t.at - at) < Math.abs(best.at - at)) best = t
  return best
}

export function dayNearest(
  layout: TimelineLayout,
  centre: Point,
): number | null {
  const nowMid = layout.now.y + layout.now.height / 2
  let best: number | null = null
  let distance = Math.abs(centre.y - nowMid)
  layout.days.forEach((d, i) => {
    const mid = d.y + d.height / 2
    if (Math.abs(centre.y - mid) < distance) {
      distance = Math.abs(centre.y - mid)
      best = i
    }
  })
  return best
}

export function searchCheckpoints(
  list: readonly Checkpoint[],
  query: string,
  dateWords: (c: Checkpoint) => string,
): Checkpoint[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "")
  if (terms.length === 0) return []
  return list
    .filter((c) => {
      const hay = [
        c.name,
        c.title ?? "",
        c.notes?.title ?? "",
        c.notes?.text ?? "",
        ...(c.notes?.tags ?? []),
        c.note ?? "",
        c.kind,
        dateWords(c),
      ]
        .join("\n")
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
    .sort((a, b) => byTime(b, a))
}

export const shownName = (
  c: Pick<Checkpoint, "name" | "title" | "notes">,
): string => c.title ?? c.notes?.title ?? c.name

export const hasNotes = (c: Pick<Checkpoint, "notes" | "note">): boolean =>
  (c.notes !== null &&
    (c.notes.text.trim() !== "" || c.notes.tags.length > 0)) ||
  (c.note !== undefined && c.note !== "")

const NOTE_MARK = /^(?:#{1,6}\s+|[-*+]\s+|>\s+)/
const NOTE_EMPHASIS = /\*\*|__|`/g

export function noteOf(
  c: Pick<Checkpoint, "notes" | "note">,
): { readonly line: string; readonly full: string } | null {
  if (!hasNotes(c)) return null
  const text = c.notes?.text.trim() ?? ""
  const tags = c.notes?.tags.join(", ") ?? ""
  const body = text !== "" ? text : (c.note ?? "").trim()
  const first = body
    .split("\n")
    .map((l) =>
      l.trim().replace(NOTE_MARK, "").replace(NOTE_EMPHASIS, "").trim(),
    )
    .find((l) => l !== "")
  const line = first ?? tags
  if (line === "") return null
  return { line, full: [body, tags].filter((x) => x !== "").join("\n") }
}

const SAVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const validSaveName = (name: string): boolean =>
  name.length > 0 && name.length <= 64 && SAVE_NAME.test(name)

const timestampName = (d: Date): string =>
  `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`

export function saveNameFor(
  title: string,
  taken: ReadonlySet<string>,
  now: Date,
): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 56)
  const base = slug === "" || slug === "stow" ? timestampName(now) : slug
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`
    if (!taken.has(candidate)) return candidate
  }
}

export function deleteBlocked(
  c: Pick<Checkpoint, "kind" | "protected">,
): string | null {
  if (c.protected === true) return "checkpoints.keep.protected"
  if (c.kind === "golden") return "checkpoints.keep.golden"
  if (c.kind === "baseline") return "checkpoints.keep.baseline"
  return null
}

export function incompatibleReason(
  c: Pick<Checkpoint, "compatible" | "incompatible">,
): string | null {
  if (c.compatible !== false) return null
  for (const part of ["display", "base", "hardware", "firmware", "qemu"]) {
    if (c.incompatible.includes(part)) return `checkpoints.incompatible.${part}`
  }
  return "checkpoints.incompatible.other"
}

export const isAutomatic = (c: Pick<Checkpoint, "kind">): boolean =>
  c.kind === "auto" || c.kind === "stow"

export type Step =
  | {
      readonly verb: "save"
      readonly name: string
      readonly title: string | null
    }
  | { readonly verb: "load"; readonly name: string }

export interface GoBackContext {
  readonly live: boolean
  readonly now: Date
  readonly taken: ReadonlySet<string>
  readonly keepTitle: string
}

export function goBackSteps(
  target: string,
  saveFirst: boolean,
  ctx: GoBackContext,
): Step[] {
  const load: Step = { verb: "load", name: target }
  if (!saveFirst || !ctx.live) return [load]
  return [
    {
      verb: "save",
      name: saveNameFor(ctx.keepTitle, ctx.taken, ctx.now),
      title: ctx.keepTitle,
    },
    load,
  ]
}

export function goBackConfirm(ctx: Pick<GoBackContext, "live">): {
  readonly body: string
  readonly offerSaveFirst: boolean
} {
  return ctx.live
    ? { body: "checkpoints.goBack.bodyLive", offerSaveFirst: true }
    : { body: "checkpoints.goBack.bodyStopped", offerSaveFirst: false }
}

export function stepThrough(
  order: readonly string[],
  from: string | null,
  direction: -1 | 1,
): string | null {
  if (order.length === 0) return null
  if (from === null) return direction < 0 ? (order.at(-1) ?? null) : null
  const i = order.indexOf(from)
  if (i < 0) return order.at(-1) ?? null
  const next = i + direction
  if (next >= order.length) return null
  return order[Math.max(0, next)] ?? null
}
