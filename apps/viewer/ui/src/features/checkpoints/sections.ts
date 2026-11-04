/**
 * Sections: named containers on the Checkpoints canvas, after FigJam's. The
 * rules are here and pure (geometry in world units, no DOM), so they are
 * tested without a canvas; Section.tsx draws them and CheckpointCanvas wires
 * the pointer and the keys to them.
 *
 * - The grid is GRID world units. A section's corners and edges are always on
 *   it: drawing, moving and resizing snap what moves.
 * - Sections never touch: two are at least one GRID apart (and so is a section
 *   from the Now card, and from the timeline at the right of the window). A
 *   section being moved, resized or drawn stops at the edge of what is in its
 *   way instead of overlapping it, and slides along it when the pointer keeps
 *   going the other way (`moveSection`, `growSection`: each axis in turn, from
 *   the last good place, so a fast pointer never jumps over a neighbour).
 * - A checkpoint is in a section by its card's centre, decided when it is
 *   dropped, and keeps its place relative to the section's top left, so a
 *   section carries what is in it. Cards stay inside the body (clamped when
 *   dropped, and when a section is shown); a section never resizes itself.
 * - Removing a section only frees its cards, where they stand.
 */
import type { Point, Rect } from "@winvm/canvas"

import { titleProblem } from "../machines/machines"
import { CAPTION_ROOM, type Moves } from "./checkpoints"

/** The grid, in world units: sections snap to it, and the dot grid shown while they are worked on is drawn at it. */
export const GRID = 24
/** The least a section can be: 5 cells wide, 4 high (room for its name and one small card's worth of corner). */
export const MIN_W = 5 * GRID
export const MIN_H = 4 * GRID
/** Between two sections, or a section and Now: one cell. Touching is not allowed. */
export const GAP = GRID
/** The air kept between a card and the section's edge, and the least a resize may squeeze its members to. */
export const PAD = GRID / 2
export const SECTION_NAME_MAX = 80

export interface Section {
  readonly id: string
  readonly name: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Where a checkpoint sits in a section: its picture's top left, from the section's top left. */
export interface Member {
  readonly section: string
  readonly x: number
  readonly y: number
}
export type Members = Readonly<Record<string, Member>>

/** Something a section keeps `gap` clear of. */
export interface Keepout {
  readonly rect: Rect
  readonly gap: number
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]

/** Edges: left, top, right, bottom. What the moving and resizing work on. */
interface Edges {
  readonly l: number
  readonly t: number
  readonly r: number
  readonly b: number
}

const edgesOf = (s: Pick<Section, "x" | "y" | "w" | "h">): Edges => ({ l: s.x, t: s.y, r: s.x + s.w, b: s.y + s.h })
const rectOf = (e: Edges): Rect => ({ x: e.l, y: e.t, width: e.r - e.l, height: e.b - e.t })

/** A section's box as a canvas Rect. */
export const sectionRect = (s: Pick<Section, "x" | "y" | "w" | "h">): Rect => ({ x: s.x, y: s.y, width: s.w, height: s.h })

/** The nearest grid line (never -0). */
export const snap = (v: number, step: number = GRID): number => Math.round(v / step) * step + 0
const floorGrid = (v: number): number => Math.floor(v / GRID) * GRID + 0
const ceilGrid = (v: number): number => Math.ceil(v / GRID) * GRID + 0

export const snapPoint = (p: Point): Point => ({ x: snap(p.x), y: snap(p.y) })

// ---- Names ----------------------------------------------------------------

/** Why `name` can't be a section's name (the rules of a machine's title: one line, 80 characters), or null. Empty is no problem: it keeps the old name. */
export const nameProblem = (name: string): "long" | "control" | null => titleProblem(name)

/** `base`, or `base 2`, `base 3`… the first not among `taken` (compared without case). */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n += 1) {
    const name = `${base} ${String(n)}`
    if (!used.has(name.toLowerCase())) return name
  }
}

/** An id not in use: s1, s2… */
export function nextId(sections: readonly Pick<Section, "id">[]): string {
  const used = new Set(sections.map((s) => s.id))
  for (let n = sections.length + 1; ; n += 1) if (!used.has(`s${String(n)}`)) return `s${String(n)}`
}

// ---- Not touching ---------------------------------------------------------

/** Whether a box at `e` is closer than `k.gap` to `k` (touching, overlapping or inside the margin). Exactly `gap` apart is fine. */
function blocked(e: Edges, k: Keepout): boolean {
  const o = edgesOf({ x: k.rect.x, y: k.rect.y, w: k.rect.width, h: k.rect.height })
  return e.l < o.r + k.gap && o.l - k.gap < e.r && e.t < o.b + k.gap && o.t - k.gap < e.b
}

/** Sections as keepouts for each other: one GAP. */
export const keepoutsOf = (sections: readonly Section[], except?: string): Keepout[] => sections.filter((s) => s.id !== except).map((s) => ({ rect: sectionRect(s), gap: GAP }))

/** Whether any two sections are closer than the gap, or one is on a keepout. */
export function intersecting(sections: readonly Section[], keep: readonly Keepout[] = []): boolean {
  return sections.some((s, i) => [...keepoutsOf(sections.slice(0, i)), ...keep].some((k) => blocked(edgesOf(s), k)))
}

/** The keepouts that share some of the box's extent across an axis (so they can block movement along the other). */
const across = (e: Edges, keep: readonly Keepout[], axis: "x" | "y"): Keepout[] =>
  keep.filter((k) => {
    const lo = axis === "x" ? k.rect.y : k.rect.x
    const hi = lo + (axis === "x" ? k.rect.height : k.rect.width)
    const [from, to] = axis === "x" ? [e.t, e.b] : [e.l, e.r]
    return from < hi + k.gap && lo - k.gap < to
  })

/**
 * Where a box spanning `[pos, pos + size]` gets to moving along one axis
 * towards `target` without coming within the keepouts' gaps. Each is a
 * wall: the box stops at the grid line short of it. A keepout the box is
 * already within the gap of is no wall (it can't get worse by moving away,
 * and a box never starts within one).
 */
function travel(pos: number, size: number, target: number, walls: readonly { readonly lo: number; readonly hi: number }[]): number {
  if (target > pos) {
    let limit = target
    for (const w of walls) if (pos + size <= w.lo && target + size > w.lo) limit = Math.min(limit, Math.max(pos, floorGrid(w.lo - size)))
    return limit
  }
  let limit = target
  for (const w of walls) if (pos >= w.hi && target < w.hi) limit = Math.max(limit, Math.min(pos, ceilGrid(w.hi)))
  return limit
}

const wallsOf = (keep: readonly Keepout[], axis: "x" | "y"): { readonly lo: number; readonly hi: number }[] =>
  keep.map((k) => (axis === "x" ? { lo: k.rect.x - k.gap, hi: k.rect.x + k.rect.width + k.gap } : { lo: k.rect.y - k.gap, hi: k.rect.y + k.rect.height + k.gap }))

// ---- Moving ---------------------------------------------------------------

/**
 * Moves a section towards `to` (its ideal top left, before snapping): snapped
 * to the grid, then stopped by sections and other keepouts. `from` is where
 * it last was, which must not be touching anything; the move is swept from
 * there, one axis and then the other, so it slides along what stops it, and a
 * jump of the pointer far across a neighbour stops at the neighbour.
 */
export function moveSection(from: Pick<Section, "x" | "y" | "w" | "h">, to: Point, keep: readonly Keepout[]): Point {
  const start = edgesOf(from)
  const wanted = snapPoint(to)
  const x = travel(start.l, from.w, wanted.x, wallsOf(across(start, keep, "x"), "x"))
  const mid = { l: x, t: start.t, r: x + from.w, b: start.b }
  const y = travel(mid.t, from.h, wanted.y, wallsOf(across(mid, keep, "y"), "y"))
  const end = { l: x, t: y, r: x + from.w, b: y + from.h }
  // Never leave a state that touches, whatever the input.
  return keep.some((k) => blocked(end, k)) && !keep.some((k) => blocked(start, k)) ? { x: from.x, y: from.y } : { x, y }
}

/** One step of the arrow keys: `cells` grid cells right and down (negative: left and up), stopping at what is in the way. */
export function nudgeSection(s: Section, cells: Point, keep: readonly Keepout[]): Point {
  return moveSection(s, { x: s.x + cells.x * GRID, y: s.y + cells.y * GRID }, keep)
}

// ---- Resizing and drawing -------------------------------------------------

/**
 * Grows the box `start` out to `want` (edges that stand still equal the
 * start's), each growing edge stopping short of the keepouts. Shrinking is
 * never blocked. Horizontal first, with the box as it is; then vertical, with
 * the box as it now is: so the corner that is pulled slides along a wall.
 */
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

/**
 * Resizes `s` by one of its handles to the pointer at `to`: the edges the
 * handle moves snap to the grid, the opposite ones stay where they are. It
 * can't go below the minimum size, can't squeeze `inside` (the bounding box
 * of its members: they stay in, with PAD around them) and stops at the
 * keepouts.
 */
export function resizeSection(s: Section, handle: Handle, to: Point, keep: readonly Keepout[], inside: Rect | null = null): Section {
  const e = edgesOf(s)
  const p = snapPoint(to)
  let { l, t, r, b } = e
  if (handle.includes("w")) l = Math.min(p.x, e.r - MIN_W)
  if (handle.includes("e")) r = Math.max(p.x, e.l + MIN_W)
  if (handle.includes("n")) t = Math.min(p.y, e.b - MIN_H)
  if (handle.includes("s")) b = Math.max(p.y, e.t + MIN_H)
  if (inside !== null) {
    if (handle.includes("w")) l = Math.min(l, floorGrid(inside.x - PAD))
    if (handle.includes("e")) r = Math.max(r, ceilGrid(inside.x + inside.width + PAD))
    if (handle.includes("n")) t = Math.min(t, floorGrid(inside.y - PAD))
    if (handle.includes("s")) b = Math.max(b, ceilGrid(inside.y + inside.height + PAD))
  }
  const want = { l, t, r, b }
  const got = grow(e, want, keep)
  if (keep.some((k) => blocked(got, k)) && !keep.some((k) => blocked(e, k))) return s
  return { ...s, x: got.l, y: got.t, w: got.r - got.l, h: got.b - got.t }
}

export interface Drawn {
  /** The rectangle so far, or null when it can't start here (the press is on another section, or has no room beside it). */
  readonly box: Rect | null
  /** It is big enough to keep as a section. */
  readonly ok: boolean
}

/**
 * A grid point that is within a keepout's margin (but not on the keepout
 * itself) moved out of it, by the way that is shortest, so a press just beside
 * a section starts a rectangle one cell from it. Null for a point on a keepout
 * or one with no room.
 */
function stepOut(p: Point, keep: readonly Keepout[]): Point | null {
  let at = p
  for (let i = 0; i < 8; i += 1) {
    const e = { l: at.x, t: at.y, r: at.x, b: at.y }
    const k = keep.find((x) => blocked(e, x))
    if (k === undefined) return at
    const { x, y, width, height } = k.rect
    if (at.x > x && at.x < x + width && at.y > y && at.y < y + height) return null
    const out = [
      { by: at.x - (x - k.gap), to: { x: floorGrid(x - k.gap), y: at.y } },
      { by: x + width + k.gap - at.x, to: { x: ceilGrid(x + width + k.gap), y: at.y } },
      { by: at.y - (y - k.gap), to: { x: at.x, y: floorGrid(y - k.gap) } },
      { by: y + height + k.gap - at.y, to: { x: at.x, y: ceilGrid(y + height + k.gap) } },
    ].sort((m, n) => m.by - n.by)[0]
    if (out === undefined) return null
    at = out.to
  }
  return null
}

/**
 * The rectangle drawn from `anchor` (where the press began) to `to`: both
 * corners snapped, at least the minimum size towards the pointer, stopped by
 * the keepouts like a resize.
 */
export function drawSection(anchor: Point, to: Point, keep: readonly Keepout[]): Drawn {
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

// ---- Loading --------------------------------------------------------------

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

/** `s` with its name made sound and its box on the grid and at least the minimum size, or null for something that isn't a section. */
export function soundSection(raw: unknown, unnamed = "Section"): Section | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Partial<Record<keyof Section, unknown>>
  if (typeof r.id !== "string" || r.id === "" || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) return null
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

/**
 * Sections that don't touch, from whatever was stored: each made sound, then,
 * in order, one that touches an earlier one or a keepout is nudged out along
 * the axis it overlaps least, then (if that doesn't clear it) shrunk from the
 * side it overlaps least, and dropped only if neither helps. The same input
 * always gives the same output. A repeated id is dropped.
 */
export function normalizeSections(input: readonly unknown[], keep: readonly Keepout[] = [], unnamed = "Section"): Section[] {
  const out: Section[] = []
  for (const raw of input) {
    const s = soundSection(raw, unnamed)
    if (s === null || out.some((o) => o.id === s.id)) continue
    const fixed = clear(s, [...keepoutsOf(out), ...keep])
    if (fixed !== null) out.push(fixed)
  }
  return out
}

/** The first of `keep` that blocks `e`, with how far `e` would have to move or shrink in each direction to clear it. */
function overlap(e: Edges, keep: readonly Keepout[]): { readonly left: number; readonly right: number; readonly up: number; readonly down: number } | null {
  for (const k of keep) {
    if (!blocked(e, k)) continue
    const o = edgesOf({ x: k.rect.x, y: k.rect.y, w: k.rect.width, h: k.rect.height })
    return { left: e.r - (o.l - k.gap), right: o.r + k.gap - e.l, up: e.b - (o.t - k.gap), down: o.b + k.gap - e.t }
  }
  return null
}

function clear(s: Section, keep: readonly Keepout[]): Section | null {
  let e = edgesOf(s)
  // Nudge out.
  for (let i = 0; i < 16; i += 1) {
    const o = overlap(e, keep)
    if (o === null) return { ...s, x: e.l, y: e.t, w: e.r - e.l, h: e.b - e.t }
    const least = Math.min(o.left, o.right, o.up, o.down)
    const by = ceilGrid(least)
    if (least === o.left) e = { ...e, l: e.l - by, r: e.r - by }
    else if (least === o.right) e = { ...e, l: e.l + by, r: e.r + by }
    else if (least === o.up) e = { ...e, t: e.t - by, b: e.b - by }
    else e = { ...e, t: e.t + by, b: e.b + by }
  }
  // Still in the way (pushed from one to another): shrink instead, from where it began.
  e = edgesOf(s)
  for (let i = 0; i < 16; i += 1) {
    const o = overlap(e, keep)
    if (o === null) return { ...s, x: e.l, y: e.t, w: e.r - e.l, h: e.b - e.t }
    const least = Math.min(o.left, o.right, o.up, o.down)
    const by = ceilGrid(least)
    const next = least === o.left ? { ...e, r: e.r - by } : least === o.right ? { ...e, l: e.l + by } : least === o.up ? { ...e, b: e.b - by } : { ...e, t: e.t + by }
    if (next.r - next.l < MIN_W || next.b - next.t < MIN_H) return null
    e = next
  }
  return null
}

// ---- Cards in sections ----------------------------------------------------

/** What a card takes up in a section: its picture and the caption plate hanging below it. */
export const extentOf = (box: Rect): { readonly width: number; readonly height: number } => ({ width: box.width, height: box.height + CAPTION_ROOM })

/** The centre of a card's picture: what decides which section it is in. */
export const centreOfCard = (box: Rect): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

/** The section whose body holds `p` (its left and top edges are in, its right and bottom are out), or null. Sections don't touch, so there is at most one. */
export function sectionAt(sections: readonly Section[], p: Point): Section | null {
  return sections.find((s) => p.x >= s.x && p.x < s.x + s.w && p.y >= s.y && p.y < s.y + s.h) ?? null
}

/** A place relative to `s`'s top left kept inside it (PAD from the edges); a card too big for the section is put at its top left. */
export function clampInto(s: Section, at: Point, size: { readonly width: number; readonly height: number }): Point {
  const room = (inner: number, outer: number, v: number): number => Math.max(PAD, Math.min(v, outer - inner - PAD))
  return { x: room(size.width, s.w, at.x), y: room(size.height, s.h, at.y) }
}

/** Where a card (its picture at `box`, in the world) is dropped: the section it is in, with its place in it, or null for loose. */
export function dropInto(sections: readonly Section[], box: Rect): Member | null {
  const s = sectionAt(sections, centreOfCard(box))
  if (s === null) return null
  return { section: s.id, ...clampInto(s, { x: box.x - s.x, y: box.y - s.y }, extentOf(box)) }
}

export interface Arrangement {
  readonly sections: readonly Section[]
  readonly members: Members
  /** Loose cards' offsets from their slots (a member's place is its section's). */
  readonly moves: Moves
}

const withoutKey = <T>(o: Readonly<Record<string, T>>, key: string): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))

/**
 * A card put down at `offset` from its `slot`: in the section its centre is
 * in (its offset from that section kept, in place of a move), else loose
 * (the move kept, in place of any membership).
 */
export function dropCard(a: Arrangement, name: string, slot: Rect, offset: Point): Arrangement {
  const box = { ...slot, x: slot.x + offset.x, y: slot.y + offset.y }
  const into = dropInto(a.sections, box)
  if (into !== null) return { ...a, members: { ...a.members, [name]: into }, moves: withoutKey(a.moves, name) }
  return { ...a, members: withoutKey(a.members, name), moves: offset.x === 0 && offset.y === 0 ? withoutKey(a.moves, name) : { ...a.moves, [name]: offset } }
}

/** The cards `s` has: those loose with their centre in it join (their place kept as it is). Members already in it stay; a card moving from another section is not touched. */
export function capture(a: Arrangement, id: string, placed: ReadonlyMap<string, Rect>, shown: ReadonlySet<string>): Arrangement {
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

/**
 * Takes a section away and only that: its cards stay exactly where they are,
 * as loose cards (a move from their slot, found from where they stood).
 */
export function removeSection(a: Arrangement, id: string, placed: ReadonlyMap<string, Rect>, slots: ReadonlyMap<string, Rect>): Arrangement {
  let moves = { ...a.moves }
  const members: Record<string, Member> = {}
  for (const [name, m] of Object.entries(a.members)) {
    if (m.section !== id) {
      members[name] = m
      continue
    }
    const at = placed.get(name)
    const slot = slots.get(name)
    // A checkpoint not shown (a hidden automatic one) has no slot now: it goes back to its slot when it is.
    if (at === undefined || slot === undefined) continue
    const by = { x: at.x - slot.x, y: at.y - slot.y }
    if (by.x !== 0 || by.y !== 0) moves = { ...moves, [name]: by }
  }
  return { sections: a.sections.filter((s) => s.id !== id), members, moves }
}

/**
 * The members of `id` after its top left moved by (`dx`, `dy`) with its edges
 * (a resize by the west or north edge): their places from it change the
 * opposite way, so they stay where they stand in the world.
 */
export function shiftMembers(members: Members, id: string, dx: number, dy: number): Members {
  if (dx === 0 && dy === 0) return members
  return Object.fromEntries(Object.entries(members).map(([name, m]) => [name, m.section === id ? { ...m, x: m.x + dx, y: m.y + dy } : m]))
}

/** The cards in `id`, by name. */
export const membersOf = (members: Members, id: string): string[] => Object.entries(members).flatMap(([name, m]) => (m.section === id ? [name] : []))

/**
 * Every card at its place in the world: a member's from its section, the
 * rest as they were. A member whose section is gone (or whose checkpoint is
 * not shown) is as the layout put it; one placed outside its section (a section
 * that was shrunk by normalizing) is brought in.
 */
export function placeMembers<T extends Rect>(cards: ReadonlyMap<string, T>, sections: readonly Section[], members: Members): Map<string, T> {
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

/** The box (world) the members of `id` take up with their captions, or null with none. Resizing can't squeeze them. */
export function membersBox(members: Members, id: string, placed: ReadonlyMap<string, Rect>): Rect | null {
  const boxes = membersOf(members, id).flatMap((n) => {
    const b = placed.get(n)
    return b === undefined ? [] : [{ x: b.x, y: b.y, width: b.width, height: b.height + CAPTION_ROOM }]
  })
  if (boxes.length === 0) return null
  const l = Math.min(...boxes.map((b) => b.x))
  const t = Math.min(...boxes.map((b) => b.y))
  return { x: l, y: t, width: Math.max(...boxes.map((b) => b.x + b.width)) - l, height: Math.max(...boxes.map((b) => b.y + b.height)) - t }
}

/** Members that are sound: of a section that is there, in a place that is a number, and of a checkpoint that is (when `known` says). */
export function soundMembers(raw: unknown, sections: readonly Pick<Section, "id">[], known?: ReadonlySet<string>): Record<string, Member> {
  if (typeof raw !== "object" || raw === null) return {}
  const ids = new Set(sections.map((s) => s.id))
  const out: Record<string, Member> = {}
  for (const [name, m] of Object.entries(raw)) {
    if (known !== undefined && !known.has(name)) continue
    const v = m as Partial<Record<keyof Member, unknown>> | null
    if (typeof v !== "object" || v === null || typeof v.section !== "string" || !ids.has(v.section) || !finite(v.x) || !finite(v.y)) continue
    out[name] = { section: v.section, x: v.x, y: v.y }
  }
  return out
}

// ---- Reading order and words ----------------------------------------------

/** Top to bottom, then left to right: the order Tab and a screen reader take them in. */
export const readingOrder = (sections: readonly Section[]): Section[] => [...sections].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))

/** Which names of a day's cards are in no section (the day's date follows these). */
export const looseNames = (names: readonly string[], members: Members): string[] => names.filter((n) => members[n] === undefined)
