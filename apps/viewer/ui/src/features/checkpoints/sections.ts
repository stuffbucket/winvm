import type { Point, Rect } from "@winvm/canvas"

import { titleProblem } from "../machines/machines"
import { CAPTION_ROOM, type Moves } from "./checkpoints"

export const GRID = 24
const MIN_W_CELLS = 5
const MIN_H_CELLS = 4
export const MIN_W = MIN_W_CELLS * GRID
export const MIN_H = MIN_H_CELLS * GRID
export const GAP = 1 * GRID
export const PAD = GRID / 2
export const SECTION_NAME_MAX = 80
const STEP_OUT_TRIES = 8
const CLEAR_TRIES = 16

export interface Section {
  readonly id: string
  readonly name: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface Member {
  readonly section: string
  readonly x: number
  readonly y: number
}
export type Members = Readonly<Record<string, Member>>

export interface Keepout {
  readonly rect: Rect
  readonly gap: number
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
export const HANDLES: readonly Handle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
]

interface Edges {
  readonly l: number
  readonly t: number
  readonly r: number
  readonly b: number
}

const edgesOf = (s: Pick<Section, "x" | "y" | "w" | "h">): Edges => ({
  l: s.x,
  t: s.y,
  r: s.x + s.w,
  b: s.y + s.h,
})
const rectOf = (e: Edges): Rect => ({
  x: e.l,
  y: e.t,
  width: e.r - e.l,
  height: e.b - e.t,
})

export const sectionRect = (s: Pick<Section, "x" | "y" | "w" | "h">): Rect => ({
  x: s.x,
  y: s.y,
  width: s.w,
  height: s.h,
})

export const snap = (v: number, step: number = GRID): number =>
  Math.round(v / step) * step + 0
const floorGrid = (v: number): number => Math.floor(v / GRID) * GRID + 0
const ceilGrid = (v: number): number => Math.ceil(v / GRID) * GRID + 0

const snapPoint = (p: Point): Point => ({ x: snap(p.x), y: snap(p.y) })

export const nameProblem = (name: string): "long" | "control" | null =>
  titleProblem(name)

export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n += 1) {
    const name = `${base} ${String(n)}`
    if (!used.has(name.toLowerCase())) return name
  }
}

export function nextId(sections: readonly Pick<Section, "id">[]): string {
  const used = new Set(sections.map((s) => s.id))
  for (let n = sections.length + 1; ; n += 1)
    if (!used.has(`s${String(n)}`)) return `s${String(n)}`
}

function blocked(e: Edges, k: Keepout): boolean {
  const o = edgesOf({
    x: k.rect.x,
    y: k.rect.y,
    w: k.rect.width,
    h: k.rect.height,
  })
  return (
    e.l < o.r + k.gap &&
    o.l - k.gap < e.r &&
    e.t < o.b + k.gap &&
    o.t - k.gap < e.b
  )
}

export const keepoutsOf = (
  sections: readonly Section[],
  except?: string,
): Keepout[] =>
  sections
    .filter((s) => s.id !== except)
    .map((s) => ({ rect: sectionRect(s), gap: GAP }))

export function intersecting(
  sections: readonly Section[],
  keep: readonly Keepout[] = [],
): boolean {
  return sections.some((s, i) =>
    [...keepoutsOf(sections.slice(0, i)), ...keep].some((k) =>
      blocked(edgesOf(s), k),
    ),
  )
}

const across = (
  e: Edges,
  keep: readonly Keepout[],
  axis: "x" | "y",
): Keepout[] =>
  keep.filter((k) => {
    const lo = axis === "x" ? k.rect.y : k.rect.x
    const hi = lo + (axis === "x" ? k.rect.height : k.rect.width)
    const [from, to] = axis === "x" ? [e.t, e.b] : [e.l, e.r]
    return from < hi + k.gap && lo - k.gap < to
  })

function travel(
  pos: number,
  size: number,
  target: number,
  walls: readonly { readonly lo: number; readonly hi: number }[],
): number {
  if (target > pos) {
    let limit = target
    for (const w of walls)
      if (pos + size <= w.lo && target + size > w.lo)
        limit = Math.min(limit, Math.max(pos, floorGrid(w.lo - size)))
    return limit
  }
  let limit = target
  for (const w of walls)
    if (pos >= w.hi && target < w.hi)
      limit = Math.max(limit, Math.min(pos, ceilGrid(w.hi)))
  return limit
}

const wallsOf = (
  keep: readonly Keepout[],
  axis: "x" | "y",
): { readonly lo: number; readonly hi: number }[] =>
  keep.map((k) =>
    axis === "x"
      ? { lo: k.rect.x - k.gap, hi: k.rect.x + k.rect.width + k.gap }
      : { lo: k.rect.y - k.gap, hi: k.rect.y + k.rect.height + k.gap },
  )

export function moveSection(
  from: Pick<Section, "x" | "y" | "w" | "h">,
  to: Point,
  keep: readonly Keepout[],
): Point {
  const start = edgesOf(from)
  const wanted = snapPoint(to)
  const x = travel(
    start.l,
    from.w,
    wanted.x,
    wallsOf(across(start, keep, "x"), "x"),
  )
  const mid = { l: x, t: start.t, r: x + from.w, b: start.b }
  const y = travel(
    mid.t,
    from.h,
    wanted.y,
    wallsOf(across(mid, keep, "y"), "y"),
  )
  const end = { l: x, t: y, r: x + from.w, b: y + from.h }
  return keep.some((k) => blocked(end, k)) &&
    !keep.some((k) => blocked(start, k))
    ? { x: from.x, y: from.y }
    : { x, y }
}

export function nudgeSection(
  s: Section,
  cells: Point,
  keep: readonly Keepout[],
): Point {
  return moveSection(
    s,
    { x: s.x + cells.x * GRID, y: s.y + cells.y * GRID },
    keep,
  )
}

function grow(start: Edges, want: Edges, keep: readonly Keepout[]): Edges {
  let { l, r } = start
  const xs = across(start, keep, "x")
  if (want.r > r) {
    let limit = want.r
    for (const k of xs) {
      const lo = k.rect.x - k.gap
      if (r <= lo) limit = Math.min(limit, Math.max(r, floorGrid(lo)))
    }
    r = limit
  } else r = want.r
  if (want.l < l) {
    let limit = want.l
    for (const k of xs) {
      const hi = k.rect.x + k.rect.width + k.gap
      if (l >= hi) limit = Math.max(limit, Math.min(l, ceilGrid(hi)))
    }
    l = limit
  } else l = want.l
  let { t, b } = start
  const mid = { l, t, r, b }
  const ys = across(mid, keep, "y")
  if (want.b > b) {
    let limit = want.b
    for (const k of ys) {
      const lo = k.rect.y - k.gap
      if (b <= lo) limit = Math.min(limit, Math.max(b, floorGrid(lo)))
    }
    b = limit
  } else b = want.b
  if (want.t < t) {
    let limit = want.t
    for (const k of ys) {
      const hi = k.rect.y + k.rect.height + k.gap
      if (t >= hi) limit = Math.max(limit, Math.min(t, ceilGrid(hi)))
    }
    t = limit
  } else t = want.t
  return { l, t, r, b }
}

export function resizeSection(
  s: Section,
  handle: Handle,
  to: Point,
  keep: readonly Keepout[],
  inside: Rect | null = null,
): Section {
  const e = edgesOf(s)
  const p = snapPoint(to)
  let { l, t, r, b } = e
  if (handle.includes("w")) l = Math.min(p.x, e.r - MIN_W)
  if (handle.includes("e")) r = Math.max(p.x, e.l + MIN_W)
  if (handle.includes("n")) t = Math.min(p.y, e.b - MIN_H)
  if (handle.includes("s")) b = Math.max(p.y, e.t + MIN_H)
  if (inside !== null) {
    if (handle.includes("w")) l = Math.min(l, floorGrid(inside.x - PAD))
    if (handle.includes("e"))
      r = Math.max(r, ceilGrid(inside.x + inside.width + PAD))
    if (handle.includes("n")) t = Math.min(t, floorGrid(inside.y - PAD))
    if (handle.includes("s"))
      b = Math.max(b, ceilGrid(inside.y + inside.height + PAD))
  }
  const want = { l, t, r, b }
  const got = grow(e, want, keep)
  if (keep.some((k) => blocked(got, k)) && !keep.some((k) => blocked(e, k)))
    return s
  return { ...s, x: got.l, y: got.t, w: got.r - got.l, h: got.b - got.t }
}

export interface Drawn {
  readonly box: Rect | null
  readonly ok: boolean
}

function stepOut(p: Point, keep: readonly Keepout[]): Point | null {
  let at = p
  for (let i = 0; i < STEP_OUT_TRIES; i += 1) {
    const e = { l: at.x, t: at.y, r: at.x, b: at.y }
    const k = keep.find((x) => blocked(e, x))
    if (k === undefined) return at
    const { x, y, width, height } = k.rect
    if (at.x > x && at.x < x + width && at.y > y && at.y < y + height)
      return null
    const out = [
      { by: at.x - (x - k.gap), to: { x: floorGrid(x - k.gap), y: at.y } },
      {
        by: x + width + k.gap - at.x,
        to: { x: ceilGrid(x + width + k.gap), y: at.y },
      },
      { by: at.y - (y - k.gap), to: { x: at.x, y: floorGrid(y - k.gap) } },
      {
        by: y + height + k.gap - at.y,
        to: { x: at.x, y: ceilGrid(y + height + k.gap) },
      },
    ].sort((m, n) => m.by - n.by)[0]
    if (out === undefined) return null
    at = out.to
  }
  return null
}

export function drawSection(
  anchor: Point,
  to: Point,
  keep: readonly Keepout[],
): Drawn {
  const a = stepOut(snapPoint(anchor), keep)
  if (a === null) return { box: null, ok: false }
  const start = { l: a.x, t: a.y, r: a.x, b: a.y }
  const p = snapPoint(to)
  const rightwards = to.x >= anchor.x
  const downwards = to.y >= anchor.y
  const want: Edges = {
    l: rightwards ? a.x : Math.min(p.x, a.x - MIN_W),
    r: rightwards ? Math.max(p.x, a.x + MIN_W) : a.x,
    t: downwards ? a.y : Math.min(p.y, a.y - MIN_H),
    b: downwards ? Math.max(p.y, a.y + MIN_H) : a.y,
  }
  const got = grow(start, want, keep)
  const box = rectOf(got)
  return { box, ok: box.width >= MIN_W && box.height >= MIN_H }
}

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n)

export function soundSection(
  raw: unknown,
  unnamed = "Section",
): Section | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Partial<Record<keyof Section, unknown>>
  if (
    typeof r.id !== "string" ||
    r.id === "" ||
    !finite(r.x) ||
    !finite(r.y) ||
    !finite(r.w) ||
    !finite(r.h)
  )
    return null
  const typed = typeof r.name === "string" ? r.name.trim() : ""
  return {
    id: r.id,
    name: typed === "" || nameProblem(typed) !== null ? unnamed : typed,
    x: snap(r.x),
    y: snap(r.y),
    w: Math.max(MIN_W, snap(r.w)),
    h: Math.max(MIN_H, snap(r.h)),
  }
}

export function normalizeSections(
  input: readonly unknown[],
  keep: readonly Keepout[] = [],
  unnamed = "Section",
): Section[] {
  const out: Section[] = []
  for (const raw of input) {
    const s = soundSection(raw, unnamed)
    if (s === null || out.some((o) => o.id === s.id)) continue
    const fixed = clear(s, [...keepoutsOf(out), ...keep])
    if (fixed !== null) out.push(fixed)
  }
  return out
}

function overlap(
  e: Edges,
  keep: readonly Keepout[],
): {
  readonly left: number
  readonly right: number
  readonly up: number
  readonly down: number
} | null {
  for (const k of keep) {
    if (!blocked(e, k)) continue
    const o = edgesOf({
      x: k.rect.x,
      y: k.rect.y,
      w: k.rect.width,
      h: k.rect.height,
    })
    return {
      left: e.r - (o.l - k.gap),
      right: o.r + k.gap - e.l,
      up: e.b - (o.t - k.gap),
      down: o.b + k.gap - e.t,
    }
  }
  return null
}

function clear(s: Section, keep: readonly Keepout[]): Section | null {
  let e = edgesOf(s)
  for (let i = 0; i < CLEAR_TRIES; i += 1) {
    const o = overlap(e, keep)
    if (o === null) return { ...s, x: e.l, y: e.t, w: e.r - e.l, h: e.b - e.t }
    const least = Math.min(o.left, o.right, o.up, o.down)
    const by = ceilGrid(least)
    if (least === o.left) e = { ...e, l: e.l - by, r: e.r - by }
    else if (least === o.right) e = { ...e, l: e.l + by, r: e.r + by }
    else if (least === o.up) e = { ...e, t: e.t - by, b: e.b - by }
    else e = { ...e, t: e.t + by, b: e.b + by }
  }
  e = edgesOf(s)
  for (let i = 0; i < CLEAR_TRIES; i += 1) {
    const o = overlap(e, keep)
    if (o === null) return { ...s, x: e.l, y: e.t, w: e.r - e.l, h: e.b - e.t }
    const least = Math.min(o.left, o.right, o.up, o.down)
    const by = ceilGrid(least)
    const next =
      least === o.left
        ? { ...e, r: e.r - by }
        : least === o.right
          ? { ...e, l: e.l + by }
          : least === o.up
            ? { ...e, b: e.b - by }
            : { ...e, t: e.t + by }
    if (next.r - next.l < MIN_W || next.b - next.t < MIN_H) return null
    e = next
  }
  return null
}

export const extentOf = (
  box: Rect,
): { readonly width: number; readonly height: number } => ({
  width: box.width,
  height: box.height + CAPTION_ROOM,
})

export const centreOfCard = (box: Rect): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
})

export function sectionAt(
  sections: readonly Section[],
  p: Point,
): Section | null {
  return (
    sections.find(
      (s) => p.x >= s.x && p.x < s.x + s.w && p.y >= s.y && p.y < s.y + s.h,
    ) ?? null
  )
}

export function clampInto(
  s: Section,
  at: Point,
  size: { readonly width: number; readonly height: number },
): Point {
  const room = (inner: number, outer: number, v: number): number =>
    Math.max(PAD, Math.min(v, outer - inner - PAD))
  return { x: room(size.width, s.w, at.x), y: room(size.height, s.h, at.y) }
}

export function dropInto(
  sections: readonly Section[],
  box: Rect,
): Member | null {
  const s = sectionAt(sections, centreOfCard(box))
  if (s === null) return null
  return {
    section: s.id,
    ...clampInto(s, { x: box.x - s.x, y: box.y - s.y }, extentOf(box)),
  }
}

export interface Arrangement {
  readonly sections: readonly Section[]
  readonly members: Members
  readonly moves: Moves
}

const withoutKey = <T>(
  o: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))

export function dropCard(
  a: Arrangement,
  name: string,
  slot: Rect,
  offset: Point,
): Arrangement {
  const box = { ...slot, x: slot.x + offset.x, y: slot.y + offset.y }
  const into = dropInto(a.sections, box)
  if (into !== null)
    return {
      ...a,
      members: { ...a.members, [name]: into },
      moves: withoutKey(a.moves, name),
    }
  return {
    ...a,
    members: withoutKey(a.members, name),
    moves:
      offset.x === 0 && offset.y === 0
        ? withoutKey(a.moves, name)
        : { ...a.moves, [name]: offset },
  }
}

export function capture(
  a: Arrangement,
  id: string,
  placed: ReadonlyMap<string, Rect>,
  shown: ReadonlySet<string>,
): Arrangement {
  const s = a.sections.find((x) => x.id === id)
  if (s === undefined) return a
  let members = a.members
  let moves = a.moves
  for (const [name, box] of placed) {
    if (!shown.has(name) || members[name] !== undefined) continue
    const into = dropInto([s], box)
    if (into === null) continue
    members = { ...members, [name]: into }
    moves = withoutKey(moves, name)
  }
  return { ...a, members, moves }
}

export function removeSection(
  a: Arrangement,
  id: string,
  placed: ReadonlyMap<string, Rect>,
  slots: ReadonlyMap<string, Rect>,
): Arrangement {
  let moves = { ...a.moves }
  const members: Record<string, Member> = {}
  for (const [name, m] of Object.entries(a.members)) {
    if (m.section !== id) {
      members[name] = m
      continue
    }
    const at = placed.get(name)
    const slot = slots.get(name)
    if (at === undefined || slot === undefined) continue
    const by = { x: at.x - slot.x, y: at.y - slot.y }
    if (by.x !== 0 || by.y !== 0) moves = { ...moves, [name]: by }
  }
  return { sections: a.sections.filter((s) => s.id !== id), members, moves }
}

export function shiftMembers(
  members: Members,
  id: string,
  dx: number,
  dy: number,
): Members {
  if (dx === 0 && dy === 0) return members
  return Object.fromEntries(
    Object.entries(members).map(([name, m]) => [
      name,
      m.section === id ? { ...m, x: m.x + dx, y: m.y + dy } : m,
    ]),
  )
}

export const membersOf = (members: Members, id: string): string[] =>
  Object.entries(members).flatMap(([name, m]) =>
    m.section === id ? [name] : [],
  )

export function placeMembers<T extends Rect>(
  cards: ReadonlyMap<string, T>,
  sections: readonly Section[],
  members: Members,
): Map<string, T> {
  const out = new Map(cards)
  const byId = new Map(sections.map((s) => [s.id, s]))
  for (const [name, m] of Object.entries(members)) {
    const s = byId.get(m.section)
    const card = cards.get(name)
    if (s === undefined || card === undefined) continue
    const at = clampInto(s, m, extentOf(card))
    out.set(name, { ...card, x: s.x + at.x, y: s.y + at.y })
  }
  return out
}

export function membersBox(
  members: Members,
  id: string,
  placed: ReadonlyMap<string, Rect>,
): Rect | null {
  const boxes = membersOf(members, id).flatMap((n) => {
    const b = placed.get(n)
    return b === undefined
      ? []
      : [{ x: b.x, y: b.y, width: b.width, height: b.height + CAPTION_ROOM }]
  })
  if (boxes.length === 0) return null
  const l = Math.min(...boxes.map((b) => b.x))
  const t = Math.min(...boxes.map((b) => b.y))
  return {
    x: l,
    y: t,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - l,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - t,
  }
}

export function soundMembers(
  raw: unknown,
  sections: readonly Pick<Section, "id">[],
  known?: ReadonlySet<string>,
): Record<string, Member> {
  if (typeof raw !== "object" || raw === null) return {}
  const ids = new Set(sections.map((s) => s.id))
  const out: Record<string, Member> = {}
  for (const [name, m] of Object.entries(raw)) {
    if (known !== undefined && !known.has(name)) continue
    const v = m as Partial<Record<keyof Member, unknown>> | null
    if (
      typeof v !== "object" ||
      v === null ||
      typeof v.section !== "string" ||
      !ids.has(v.section) ||
      !finite(v.x) ||
      !finite(v.y)
    )
      continue
    out[name] = { section: v.section, x: v.x, y: v.y }
  }
  return out
}

export const readingOrder = (sections: readonly Section[]): Section[] =>
  [...sections].sort(
    (a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
  )

export const looseNames = (
  names: readonly string[],
  members: Members,
): string[] => names.filter((n) => members[n] === undefined)
