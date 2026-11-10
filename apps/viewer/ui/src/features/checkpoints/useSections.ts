/**
 * The Section tool and what is done to sections with the pointer and the
 * keys: drawing one, moving it by its tab, its border or (selected) its body,
 * resizing it by a handle, renaming, removing, nudging. The rules are in
 * sections.ts; this holds the gesture in progress and calls them.
 *
 * What a press does (the hit rules):
 *   Tool on          anywhere: starts drawing (a press that doesn't move makes nothing).
 *   Tab              select; drag moves; a click without a drag renames.
 *   Border (edges)   select; drag moves. While selected, an edge resizes instead.
 *   Corner           (only while selected) resizes.
 *   Body             passes through to the canvas (pans, a click lets go of the
 *                    selection) until the section is selected; selected, a drag
 *                    in its empty body moves it. A card in it is the card's own.
 */
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type RefObject, useCallback, useRef, useState } from "react"

import { type Camera, editableTarget, type Point, type Rect, screenToWorld } from "@winvm/canvas"

import { t } from "../../i18n"
import { CAPTION_ROOM } from "./checkpoints"
import {
  type Arrangement,
  capture,
  type Drawn,
  drawSection,
  GAP,
  type Handle,
  type Keepout,
  keepoutsOf,
  type Members,
  membersBox,
  moveSection,
  nameProblem,
  nextId,
  nudgeSection,
  removeSection,
  resizeSection,
  shiftMembers,
  type Section,
  uniqueName,
} from "./sections"

/** A press moves this far (screen px) before it is a drag. */
const DRAG_FROM = 4

type Gesture =
  | { readonly kind: "draw"; readonly pointer: number; readonly anchor: Point; readonly from: Point; moved: boolean }
  | { readonly kind: "move"; readonly pointer: number; readonly id: string; readonly start: Section; readonly grab: Point; readonly from: Point; readonly tab: boolean; moved: boolean; cur: Section }
  | { readonly kind: "resize"; readonly pointer: number; readonly id: string; readonly handle: Handle; readonly start: Section; readonly grab: Point; readonly from: Point; moved: boolean; cur: Section }

/** What the canvas knows that the rules need, read when a gesture or key needs it (it changes every render). */
export interface SectionsHost {
  readonly viewport: RefObject<HTMLDivElement>
  camera(): Camera
  /** Every shown card's picture, where it is now in the world; and where its slot is. */
  placed(): ReadonlyMap<string, Rect>
  slots(): ReadonlyMap<string, Rect>
  /** The names shown. */
  names(): ReadonlySet<string>
  /** Now's box, caption plate included: sections keep a cell from it. */
  now(): Rect
  /** Where the timeline starts, in client x: sections stop short of it. */
  railX(): number
  /** What is stored: the sections as they stand (not the one being moved), who is in them, the loose cards' moves. */
  arrangement(): Arrangement
  commit(next: Arrangement): void
  /** A section is chosen: no card is. */
  onChosen(): void
}

export interface SectionsApi {
  /** The sections as drawn: the one in the pointer's hand where it is carried. */
  readonly sections: readonly Section[]
  /** Who is in them as drawn: while one is resized by its west or north edge, its members stay where they stand. */
  readonly members: Members
  readonly tool: boolean
  readonly selected: string | null
  readonly editing: string | null
  /** A rectangle being drawn. */
  readonly draft: Drawn | null
  /** The dot grid shows while one is being drawn, moved or resized. */
  readonly working: boolean
  readonly moving: string | null
  /** For a screen reader, quietly. */
  readonly said: string
  setTool(on: boolean): void
  select(id: string | null): void
  startEdit(id: string): void
  /** Commits a typed name (null: leave it); returns why it can't be kept, or null once it is. */
  rename(id: string, typed: string | null): "long" | "control" | null
  remove(id: string): void
  down(e: PointerEvent<HTMLDivElement>): boolean
  move(e: PointerEvent<HTMLDivElement>): boolean
  up(e: PointerEvent<HTMLDivElement>): boolean
  /** Esc: lets go of whatever is going on in the sections (a drag, the tool, the selection); false if there was none. */
  escape(): boolean
  /** Keys on a focused section. */
  key(e: ReactKeyboardEvent<HTMLElement>, id: string): void
  say(text: string): void
}

export function useSections(host: RefObject<SectionsHost | null>, stored: readonly Section[], storedMembers: Members): SectionsApi {
  const [tool, setToolState] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Drawn | null>(null)
  const [live, setLiveState] = useState<{ readonly section: Section; readonly resizing: boolean } | null>(null)
  const setLive = (section: Section | null, resizing = false): void => setLiveState(section === null ? null : { section, resizing })
  const [said, say] = useState("")
  const gesture = useRef<Gesture | null>(null)

  const shown = live === null ? stored : stored.map((s) => (s.id === live.section.id ? live.section : s))
  const original = live === null ? undefined : stored.find((s) => s.id === live.section.id)
  // Resizing by the west or north edge moves the section's top left: its members stay where they stand. Carrying it, they go with it.
  const members =
    original === undefined || live === null || !live.resizing ? storedMembers : shiftMembers(storedMembers, live.section.id, original.x - live.section.x, original.y - live.section.y)

  const world = (e: { readonly clientX: number; readonly clientY: number }): Point => {
    const h = host.current
    const rect = h?.viewport.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    return screenToWorld({ x: e.clientX, y: e.clientY }, h?.camera() ?? { x: 0, y: 0, zoom: 1 }, rect)
  }

  /** What a section keeps clear of: the others, Now and the timeline's strip. */
  const keepouts = (except?: string): Keepout[] => {
    const h = host.current
    if (h === null) return []
    const cam = h.camera()
    const rect = h.viewport.current?.getBoundingClientRect() ?? { left: 0 }
    const railX = (h.railX() - rect.left - cam.x) / cam.zoom
    return [...keepoutsOf(h.arrangement().sections, except), { rect: h.now(), gap: GAP }, { rect: { x: railX, y: -1e7, width: 1e7, height: 2e7 }, gap: 0 }]
  }

  const choose = useCallback(
    (id: string | null): void => {
      setSelected(id)
      if (id !== null) host.current?.onChosen()
      else setEditing(null)
    },
    [host],
  )

  const setTool = (on: boolean): void => {
    setToolState(on)
    if (on) setEditing(null)
  }

  const replace = (s: Section): void => {
    const h = host.current
    if (h === null) return
    const a = h.arrangement()
    h.commit({ ...a, sections: a.sections.map((x) => (x.id === s.id ? s : x)) })
  }

  const finishDraw = (g: Extract<Gesture, { kind: "draw" }>, drawn: Drawn | null): void => {
    const h = host.current
    if (h === null) return
    if (!g.moved) return
    if (drawn === null || drawn.box === null || !drawn.ok) {
      say(t("checkpoints.section.noRoom"))
      return
    }
    const a = h.arrangement()
    const name = uniqueName(t("checkpoints.section.default"), a.sections.map((s) => s.name))
    const section: Section = { id: nextId(a.sections), name, x: drawn.box.x, y: drawn.box.y, w: drawn.box.width, h: drawn.box.height }
    const withIt = { ...a, sections: [...a.sections, section] }
    h.commit(capture(withIt, section.id, h.placed(), h.names()))
    setSelected(section.id)
    h.onChosen()
    setEditing(section.id)
    setToolState(false)
    say(t("checkpoints.section.created", { name }))
  }

  const down = (e: PointerEvent<HTMLDivElement>): boolean => {
    const h = host.current
    if (e.button !== 0 || h === null) return false
    const target = e.target instanceof Element ? e.target : null
    if (tool) {
      if (editableTarget(e.target)) return false
      gesture.current = { kind: "draw", pointer: e.pointerId, anchor: world(e), from: { x: e.clientX, y: e.clientY }, moved: false }
      grab(e)
      return true
    }
    const part = target?.closest<HTMLElement>("[data-part]") ?? null
    const id = part?.dataset["sectionId"]
    const s = id === undefined ? undefined : h.arrangement().sections.find((x) => x.id === id)
    if (part === null || s === undefined) return false
    // Its own controls (the name field, the remove button) act for themselves.
    if (target?.closest("button, input") != null) return true
    const kind = part.dataset["part"]
    // The body of one that isn't selected is the canvas's (the stylesheet says the same).
    if (kind === "body" && selected !== s.id) return false
    const handle = part.dataset["handle"] as Handle | undefined
    const was = selected
    choose(s.id)
    const from = { x: e.clientX, y: e.clientY }
    const point = world(e)
    if (handle !== undefined && was === s.id && (kind === "edge" || kind === "corner")) {
      gesture.current = { kind: "resize", pointer: e.pointerId, id: s.id, handle, start: s, grab: grabOffset(s, handle, point), from, moved: false, cur: s }
    } else {
      gesture.current = { kind: "move", pointer: e.pointerId, id: s.id, start: s, grab: point, from, tab: kind === "tab", moved: false, cur: s }
    }
    grab(e)
    return true
  }

  /** The pointer's hold on the canvas, so a drag that leaves the window still ends. */
  const grab = (e: PointerEvent<HTMLDivElement>): void => {
    if (typeof e.currentTarget.setPointerCapture === "function") e.currentTarget.setPointerCapture(e.pointerId)
  }

  const move = (e: PointerEvent<HTMLDivElement>): boolean => {
    const g = gesture.current
    const h = host.current
    if (g === null || h === null || g.pointer !== e.pointerId) return false
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.from.x, e.clientY - g.from.y) < DRAG_FROM) return true
      g.moved = true
    }
    const p = world(e)
    if (g.kind === "draw") {
      setDraft(drawSection(g.anchor, p, keepouts()))
    } else if (g.kind === "move") {
      const to = { x: g.start.x + p.x - g.grab.x, y: g.start.y + p.y - g.grab.y }
      const at = moveSection(g.cur, to, keepouts(g.id))
      g.cur = { ...g.cur, ...at }
      setLive(g.cur)
    } else {
      const to = { x: p.x - g.grab.x, y: p.y - g.grab.y }
      const inside = membersBox(h.arrangement().members, g.id, h.placed())
      g.cur = resizeSection(g.start, g.handle, to, keepouts(g.id), inside)
      setLive(g.cur, true)
    }
    return true
  }

  const up = (e: PointerEvent<HTMLDivElement>): boolean => {
    const g = gesture.current
    const h = host.current
    if (g === null || h === null || g.pointer !== e.pointerId) return false
    gesture.current = null
    if (typeof e.currentTarget.releasePointerCapture === "function" && e.currentTarget.hasPointerCapture?.(e.pointerId) === true) e.currentTarget.releasePointerCapture(e.pointerId)
    setDraft(null)
    setLive(null)
    if (g.kind === "draw") {
      finishDraw(g, g.moved ? drawSection(g.anchor, world(e), keepouts()) : null)
    } else if (!g.moved) {
      // A click on the tab renames it; on the border or the body it only selected.
      if (g.kind === "move" && g.tab) setEditing(g.id)
    } else if (g.kind === "move") {
      if (g.cur.x !== g.start.x || g.cur.y !== g.start.y) {
        replace(g.cur)
        say(t("checkpoints.section.moved", { name: g.cur.name }))
      }
    } else if (g.cur.x !== g.start.x || g.cur.y !== g.start.y || g.cur.w !== g.start.w || g.cur.h !== g.start.h) {
      const a = h.arrangement()
      const resized = { ...a, sections: a.sections.map((x) => (x.id === g.id ? g.cur : x)), members: shiftMembers(a.members, g.id, g.start.x - g.cur.x, g.start.y - g.cur.y) }
      h.commit(capture(resized, g.id, h.placed(), h.names()))
      say(t("checkpoints.section.resized", { name: g.cur.name }))
    }
    // The keys go to the section (unless its name is about to be edited).
    if (g.kind !== "draw" && !(g.kind === "move" && g.tab && !g.moved)) focusSection(g.id)
    return true
  }

  /** The keys go to the section chosen (the pointer's capture on the canvas would otherwise leave the focus there). */
  const focusSection = (id: string): void => {
    host.current?.viewport.current?.querySelector<HTMLElement>(`.section[data-section="${id}"]`)?.focus({ preventScroll: true })
  }

  const escape = (): boolean => {
    if (gesture.current !== null) {
      gesture.current = null
      setDraft(null)
      setLive(null)
      return true
    }
    if (editing !== null) return false
    if (tool) {
      setToolState(false)
      return true
    }
    if (selected !== null) {
      choose(null)
      return true
    }
    return false
  }

  const remove = (id: string): void => {
    const h = host.current
    const s = h?.arrangement().sections.find((x) => x.id === id)
    if (h === null || s === undefined) return
    h.commit(removeSection(h.arrangement(), id, h.placed(), h.slots()))
    if (selected === id) choose(null)
    setEditing(null)
    say(t("checkpoints.section.removed", { name: s.name }))
  }

  const rename = (id: string, typed: string | null): "long" | "control" | null => {
    const h = host.current
    const s = h?.arrangement().sections.find((x) => x.id === id)
    const next = typed?.trim() ?? ""
    if (h === null || s === undefined || typed === null || next === "") {
      setEditing(null)
      return null
    }
    const problem = nameProblem(next)
    if (problem !== null) return problem
    setEditing(null)
    if (next !== s.name) {
      replace({ ...s, name: next })
      say(t("checkpoints.section.renamed", { name: next }))
    }
    return null
  }

  const nudge = (id: string, cells: Point): void => {
    const h = host.current
    const s = h?.arrangement().sections.find((x) => x.id === id)
    if (h === null || s === undefined) return
    const at = nudgeSection(s, cells, keepouts(id))
    if (at.x === s.x && at.y === s.y) return
    replace({ ...s, ...at })
    say(t("checkpoints.section.moved", { name: s.name }))
  }

  const key = (e: ReactKeyboardEvent<HTMLElement>, id: string): void => {
    // The name field's keys are its own.
    if (editableTarget(e.target) || e.target !== e.currentTarget) return
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault()
      setEditing(id)
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault()
      remove(id)
    } else if (e.key.startsWith("Arrow") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const d = e.shiftKey ? 4 : 1
      nudge(id, { x: e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0, y: e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0 })
    }
  }

  return {
    sections: shown,
    members,
    tool,
    selected,
    editing,
    draft,
    working: draft !== null || live !== null,
    moving: live?.section.id ?? null,
    said,
    setTool,
    select: choose,
    startEdit: (id) => {
      choose(id)
      setEditing(id)
    },
    rename,
    remove,
    down,
    move,
    up,
    escape,
    key,
    say,
  }
}

/** Where on the handle's edges or corner the pointer took hold, so the section doesn't jump to put the edge under it. */
function grabOffset(s: Section, handle: Handle, p: Point): Point {
  return {
    x: handle.includes("w") ? p.x - s.x : handle.includes("e") ? p.x - (s.x + s.w) : 0,
    y: handle.includes("n") ? p.y - s.y : handle.includes("s") ? p.y - (s.y + s.h) : 0,
  }
}

/** A box's caption room, for Now. */
export const withCaption = (r: Rect): Rect => ({ ...r, height: r.height + CAPTION_ROOM })
