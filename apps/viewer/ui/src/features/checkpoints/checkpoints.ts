/**
 * The checkpoints view's rules, with no React and no app: where every card
 * sits on the canvas, the timeline beside it, search, names, and what each
 * confirmation offers. "Checkpoint" is the app's word for a save
 * (`winvm save`); the CLI and the code keep "save".
 *
 * ## The layout
 *
 * Time runs up the canvas, as Time Machine's windows recede into the
 * screen. "Now" (the running machine) is the large card at the front, at
 * the bottom. Above it, one block per day that has checkpoints, the newest
 * day nearest: the checkpoints of a day left to right in the order taken,
 * wrapping after `columns`. Each older day is drawn a little smaller, down to
 * DEPTH_MIN, so the stack reads as going back in time and in depth; the
 * camera, not the layout, decides how big anything looks.
 */
import type { Point, Rect } from "@winvm/canvas"

import type { SaveEntry } from "../../model"

export type Checkpoint = SaveEntry

/** World units (CSS pixels at 100%). A card is a 16:10 picture over a caption. */
export const CARD_WIDTH = 320
export const CARD_FRAME = 200
export const CARD_CAPTION = 92
export const NOW_WIDTH = 560
export const NOW_CAPTION = 64
export const COLUMN_GAP = 36
export const LINE_GAP = 36
/** Room above a day's block, for its date. */
export const DAY_GAP = 112
/** Between Now and the newest day. */
export const NOW_GAP = 150
/** Each older day is this much smaller than the one in front of it... */
export const DEPTH_STEP = 0.93
/** ...down to this. */
export const DEPTH_MIN = 0.62
export const COLUMNS = 6

export interface CardBox extends Rect {
  readonly name: string
  /** The picture's height; the caption is the rest. */
  readonly frame: number
  /** How much smaller than a card of the newest day (1). */
  readonly scale: number
  /** Index into `days`. */
  readonly day: number
  /** Index into `order`. */
  readonly index: number
}

export interface DayBlock extends Rect {
  /** Local date, "2026-10-21". */
  readonly key: string
  /** Local midnight of that day. */
  readonly date: Date
  readonly scale: number
  /** Where its date label sits (top left, world). */
  readonly label: Point
  /** Names of its checkpoints, oldest first. */
  readonly names: readonly string[]
}

export interface TimelineLayout {
  /** The running machine's card; `frame` is the screen's part of it. */
  readonly now: Rect & { readonly frame: number }
  /** Oldest first: the top of the canvas first. */
  readonly days: readonly DayBlock[]
  readonly cards: ReadonlyMap<string, CardBox>
  /** Every checkpoint's name, oldest first. */
  readonly order: readonly string[]
  /** Everything, Now included. */
  readonly bounds: Rect
}

const pad = (n: number): string => String(n).padStart(2, "0")

/** "2026-10-21", in local time: a checkpoint belongs to the day it was taken where the person is. */
export function dayKey(d: Date): string {
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const midnight = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** Oldest first, by when it was taken (then by name, so equal times keep one order). */
export function byTime(a: Checkpoint, b: Checkpoint): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.name.localeCompare(b.name)
}

export const depthScale = (daysFromFront: number): number => Math.max(DEPTH_MIN, DEPTH_STEP ** daysFromFront)

/**
 * Lay the checkpoints out (see the file comment). `nowAspect` is the live
 * screen's width over its height, so the Now card's picture has the
 * screen's own shape and can stand exactly where the screen is.
 */
export function layoutTimeline(checkpoints: readonly Checkpoint[], nowAspect: number, columns = COLUMNS): TimelineLayout {
  const sorted = [...checkpoints].sort(byTime)
  const order = sorted.map((c) => c.name)
  const groups = new Map<string, Checkpoint[]>()
  for (const c of sorted) {
    const key = dayKey(new Date(c.createdAt))
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [c])
    else list.push(c)
  }

  const nowFrame = Math.round(NOW_WIDTH / (Number.isFinite(nowAspect) && nowAspect > 0 ? nowAspect : 16 / 10))
  const now = { x: -NOW_WIDTH / 2, y: 0, width: NOW_WIDTH, height: nowFrame + NOW_CAPTION, frame: nowFrame }

  // Newest day first, building upwards from Now; reversed at the end.
  const keys = [...groups.keys()].reverse()
  const days: DayBlock[] = []
  const boxes: CardBox[] = []
  let bottom = -NOW_GAP
  keys.forEach((key, back) => {
    const list = groups.get(key) ?? []
    const scale = depthScale(back)
    const w = CARD_WIDTH * scale
    const h = (CARD_FRAME + CARD_CAPTION) * scale
    const cols = Math.min(columns, list.length)
    const lines = Math.ceil(list.length / columns)
    const width = cols * w + (cols - 1) * COLUMN_GAP * scale
    const height = lines * h + (lines - 1) * LINE_GAP * scale
    const top = bottom - height
    const left = -width / 2
    list.forEach((c, i) => {
      const line = Math.floor(i / columns)
      const col = i % columns
      // A last, short line is centred under the full ones.
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
      date: midnight(first === undefined ? new Date() : new Date(first.createdAt)),
      x: left,
      y: top,
      width,
      height,
      scale,
      label: { x: left, y: top - 14 * scale },
      names: list.map((c) => c.name),
    })
    bottom = top - DAY_GAP * scale
  })
  days.reverse()

  const indexOf = new Map(order.map((n, i) => [n, i]))
  const cards = new Map(boxes.map((b) => [b.name, { ...b, index: indexOf.get(b.name) ?? 0 }]))

  const all: Rect[] = [now, ...days.map(withLabel)]
  const x0 = Math.min(...all.map((r) => r.x))
  const y0 = Math.min(...all.map((r) => r.y))
  const x1 = Math.max(...all.map((r) => r.x + r.width))
  const y1 = Math.max(...all.map((r) => r.y + r.height))
  return { now, days, cards, order, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }
}

/** A day's block with room for its date above it (the label sits on the block, drawn upwards). */
export const withLabel = (d: Pick<DayBlock, "x" | "y" | "width" | "height" | "scale">): Rect => ({ x: d.x, y: d.y - 44 * d.scale, width: d.width, height: d.height + 44 * d.scale })

/** The picture part of a card: what flies to the screen on Go Back, and what the screen flies into on the way in. */
export const frameOf = (box: Rect & { readonly frame: number }): Rect => ({ x: box.x, y: box.y, width: box.width, height: box.frame })

/** A union of rectangles (for "Now and the newest day"). */
export function union(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.width))
  const y1 = Math.max(...rects.map((r) => r.y + r.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * What the view opens on: Now and the newest day or two, so the most
 * recent checkpoints are right there above the live machine.
 */
export function openingView(layout: TimelineLayout): Rect {
  const recent = layout.days.slice(-2)
  return union([layout.now, ...recent.map(withLabel)])
}

// ---------------------------------------------------------------------------
// The timeline (scrubber) on the right edge

export interface Tick {
  readonly kind: "day" | "now"
  /** The day's key, or "now". */
  readonly key: string
  /** 0 at the top (oldest) to 1 at the bottom (Now). */
  readonly at: number
  /** A month starts here: its name is written beside the tick. */
  readonly month: string | null
  /** Today, Yesterday, a weekday this week, else the date. */
  readonly label: string
  /** Index into layout.days; null for Now. */
  readonly day: number | null
}

export interface TickWords {
  readonly now: string
  readonly today: string
  readonly yesterday: string
  readonly locale?: string
}

const daysBetween = (a: Date, b: Date): number => Math.round((midnight(b).getTime() - midnight(a).getTime()) / 86_400_000)

/** A day as the timeline names it, relative to `now`. */
export function dayLabel(date: Date, now: Date, words: TickWords): string {
  const ago = daysBetween(date, now)
  if (ago === 0) return words.today
  if (ago === 1) return words.yesterday
  if (ago > 1 && ago < 7) return new Intl.DateTimeFormat(words.locale, { weekday: "long" }).format(date)
  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(words.locale, sameYear ? { month: "long", day: "numeric" } : { dateStyle: "medium" }).format(date)
}

/**
 * One tick per day with checkpoints, then Now, evenly spaced down the edge
 * (as Time Machine spaces its backups, by turn rather than by time, so a
 * busy day and a quiet month take the same room). A month's name goes on its
 * first day, with the year when it isn't this year's.
 */
export function timelineTicks(days: readonly Pick<DayBlock, "key" | "date">[], now: Date, words: TickWords): Tick[] {
  const n = days.length
  const out: Tick[] = days.map((d, i) => {
    const prev = days[i - 1]
    const newMonth = prev === undefined || prev.date.getMonth() !== d.date.getMonth() || prev.date.getFullYear() !== d.date.getFullYear()
    const month = newMonth
      ? new Intl.DateTimeFormat(words.locale, d.date.getFullYear() === now.getFullYear() ? { month: "long" } : { month: "long", year: "numeric" }).format(d.date)
      : null
    return { kind: "day", key: d.key, at: n === 0 ? 0 : i / n, month, label: dayLabel(d.date, now, words), day: i }
  })
  out.push({ kind: "now", key: "now", at: 1, month: null, label: words.now, day: null })
  return out
}

/** The tick nearest a point on the timeline (0 top, 1 bottom). */
export function tickAt(ticks: readonly Tick[], at: number): Tick | null {
  let best: Tick | null = null
  for (const t of ticks) if (best === null || Math.abs(t.at - at) < Math.abs(best.at - at)) best = t
  return best
}

/** Which day (index) or Now (null) the view is centred on: the one whose middle is nearest the world point `centre`. */
export function dayNearest(layout: TimelineLayout, centre: Point): number | null {
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

// ---------------------------------------------------------------------------
// Search

/** Every term must appear in the name, the title, the notes, a tag, the kind or the date words. */
export function searchCheckpoints(list: readonly Checkpoint[], query: string, dateWords: (c: Checkpoint) => string): Checkpoint[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== "")
  if (terms.length === 0) return []
  return list
    .filter((c) => {
      const hay = [c.name, c.title ?? "", c.notes?.title ?? "", c.notes?.text ?? "", ...(c.notes?.tags ?? []), c.note ?? "", c.kind, dateWords(c)]
        .join("\n")
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
    .sort((a, b) => byTime(b, a))
}

// ---------------------------------------------------------------------------
// Names, words and rules

/** What a card is called: its title, else its name. */
export const shownName = (c: Pick<Checkpoint, "name" | "title" | "notes">): string => c.title ?? c.notes?.title ?? c.name

/** Whether there are notes to show (a title alone is shown as the name, not as notes). */
export const hasNotes = (c: Pick<Checkpoint, "notes" | "note">): boolean =>
  (c.notes !== null && (c.notes.text.trim() !== "" || c.notes.tags.length > 0)) || (c.note !== undefined && c.note !== "")

const SAVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** saves.ts nameError's rule: a save name is a directory name. */
export const validSaveName = (name: string): boolean => name.length > 0 && name.length <= 64 && SAVE_NAME.test(name)

/** winvm's default save name, the local time: "2026-10-21_16-43-05". */
export const timestampName = (d: Date): string =>
  `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`

/**
 * The save name for a checkpoint called `title`: the title made into a
 * directory name ("Before Office 365!" → "Before-Office-365"), or the time
 * when nothing of it is left, and never one already taken (a save of the same
 * name would be replaced). The title itself goes in its notes.
 */
export function saveNameFor(title: string, taken: ReadonlySet<string>, now: Date): string {
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

/** Kinds the viewer won't delete, and why (an i18n key): tests start from goldens, and `rewind` goes back to the baseline. */
export function deleteBlocked(c: Pick<Checkpoint, "kind">): string | null {
  if (c.kind === "golden") return "checkpoints.keep.golden"
  if (c.kind === "baseline") return "checkpoints.keep.baseline"
  return null
}

/** Why it can't load here, as an i18n key: the most specific part that differs. */
export function incompatibleReason(c: Pick<Checkpoint, "compatible" | "incompatible">): string | null {
  if (c.compatible !== false) return null
  for (const part of ["display", "base", "hardware", "firmware", "qemu"]) {
    if (c.incompatible.includes(part)) return `checkpoints.incompatible.${part}`
  }
  return "checkpoints.incompatible.other"
}

/** Automatic kinds, which the view can hide: autosaves and the stow. */
export const isAutomatic = (c: Pick<Checkpoint, "kind">): boolean => c.kind === "auto" || c.kind === "stow"

// ---------------------------------------------------------------------------
// Going back

export type Step = { readonly verb: "save"; readonly name: string; readonly title: string | null } | { readonly verb: "load"; readonly name: string }

export interface GoBackContext {
  /** Windows is running or paused, so what it is doing now can be kept first. */
  readonly live: boolean
  readonly now: Date
  readonly taken: ReadonlySet<string>
  /** What a checkpoint of the present is called, in the app's words ("Before going back to …"). */
  readonly keepTitle: string
}

/**
 * What Go Back does: load the checkpoint, after keeping the present as a
 * checkpoint of its own when asked (and only when there is a running
 * machine to keep).
 */
export function goBackSteps(target: string, saveFirst: boolean, ctx: GoBackContext): Step[] {
  const load: Step = { verb: "load", name: target }
  if (!saveFirst || !ctx.live) return [load]
  return [{ verb: "save", name: saveNameFor(ctx.keepTitle, ctx.taken, ctx.now), title: ctx.keepTitle }, load]
}

/** The Go Back confirmation: what it says, and whether it offers Save Current First. */
export function goBackConfirm(ctx: Pick<GoBackContext, "live">): { readonly body: string; readonly offerSaveFirst: boolean } {
  return ctx.live ? { body: "checkpoints.goBack.bodyLive", offerSaveFirst: true } : { body: "checkpoints.goBack.bodyStopped", offerSaveFirst: false }
}

/** The next checkpoint older (-1) or newer (+1) than `from` in time; from Now, older goes to the newest. */
export function stepThrough(order: readonly string[], from: string | null, direction: -1 | 1): string | null {
  if (order.length === 0) return null
  if (from === null) return direction < 0 ? (order.at(-1) ?? null) : null
  const i = order.indexOf(from)
  if (i < 0) return order.at(-1) ?? null
  const next = i + direction
  if (next >= order.length) return null
  return order[Math.max(0, next)] ?? null
}
