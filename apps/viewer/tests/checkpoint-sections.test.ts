/**
 * Sections' rules (features/checkpoints/sections.ts): the grid, not touching,
 * sliding along a neighbour, resizing by a handle with the opposite edges
 * fixed, the minimum size, making stored sections sound, which section a card
 * is in (by its centre), places relative to a section, and carrying members.
 */
import { describe, expect, it } from "bun:test"

import {
  type Arrangement,
  capture,
  clampInto,
  dropCard,
  dropInto,
  drawSection,
  extentOf,
  GAP,
  GRID,
  type Handle,
  intersecting,
  type Keepout,
  keepoutsOf,
  looseNames,
  membersBox,
  membersOf,
  MIN_H,
  MIN_W,
  moveSection,
  nameProblem,
  nextId,
  normalizeSections,
  nudgeSection,
  PAD,
  placeMembers,
  readingOrder,
  removeSection,
  resizeSection,
  type Section,
  sectionAt,
  shiftMembers,
  snap,
  soundMembers,
  soundSection,
  uniqueName,
} from "../ui/src/features/checkpoints/sections"
import { CAPTION_ROOM } from "../ui/src/features/checkpoints/checkpoints"
import { loadSettings, parseSettings, saveSettings } from "../ui/src/features/checkpoints/settings"

const sec = (id: string, x: number, y: number, w = 10 * GRID, h = 8 * GRID, name = id): Section => ({ id, name, x, y, w, h })
const onGrid = (v: number): boolean => Math.abs(v / GRID - Math.round(v / GRID)) < 1e-9
const gridded = (s: Section): boolean => [s.x, s.y, s.w, s.h].every(onGrid)

describe("the grid", () => {
  it("is 24 world units, a gap is one cell, and a section is at least 5 by 4 cells", () => {
    expect(GRID).toBe(24)
    expect(GAP).toBe(GRID)
    expect(MIN_W).toBe(5 * GRID)
    expect(MIN_H).toBe(4 * GRID)
  })

  it("snaps to the nearest line, never to -0", () => {
    expect(snap(11)).toBe(0)
    expect(snap(12)).toBe(24)
    expect(snap(-11)).toBe(0)
    expect(Object.is(snap(-11), -0)).toBe(false)
    expect(snap(-13)).toBe(-24)
    expect(snap(100.2)).toBe(96)
  })
})

describe("names", () => {
  it("numbers a name that is taken, without regard to case", () => {
    expect(uniqueName("Section", [])).toBe("Section")
    expect(uniqueName("Section", ["Section"])).toBe("Section 2")
    expect(uniqueName("Section", ["section", "Section 2"])).toBe("Section 3")
    expect(uniqueName("Section", ["Other"])).toBe("Section")
  })

  it("takes a machine's title rules: one line, 80 characters, no control or invisible characters", () => {
    expect(nameProblem("Yesterday's runs")).toBeNull()
    expect(nameProblem("")).toBeNull()
    expect(nameProblem("x".repeat(80))).toBeNull()
    expect(nameProblem("x".repeat(81))).toBe("long")
    expect(nameProblem("a\nb")).toBe("control")
    expect(nameProblem("a​b")).toBe("control")
    expect(nameProblem("a‮b")).toBe("control")
    expect(nameProblem("👩‍💻 team")).toBeNull()
  })

  it("makes ids that are not in use", () => {
    expect(nextId([])).toBe("s1")
    expect(nextId([{ id: "s1" }])).toBe("s2")
    expect(nextId([{ id: "s2" }])).toBe("s3")
    expect(nextId([{ id: "s2" }, { id: "s3" }])).toBe("s4")
  })
})

describe("moving a section", () => {
  it("snaps its top left to the grid", () => {
    expect(moveSection(sec("a", 0, 0), { x: 50, y: 61 }, [])).toEqual({ x: 48, y: 72 })
    expect(moveSection(sec("a", 0, 0), { x: -5, y: -30 }, [])).toEqual({ x: 0, y: -24 })
  })

  it("stops one cell short of another section, and touching is not allowed", () => {
    const b = sec("b", 408, 0)
    const keep = keepoutsOf([b])
    const at = moveSection(sec("a", 0, 0), { x: 400, y: 0 }, keep)
    // a is 240 wide: it stops at b.x - GAP - w.
    expect(at).toEqual({ x: 408 - GAP - 10 * GRID, y: 0 })
    expect(at.x + 10 * GRID + GAP).toBe(b.x)
  })

  it("slides along the neighbour when the pointer keeps going the other way", () => {
    const b = sec("b", 400, 0)
    const keep = keepoutsOf([b])
    const stuck = moveSection(sec("a", 0, 0), { x: 700, y: 0 }, keep)
    const slid = moveSection({ ...sec("a", 0, 0), ...stuck }, { x: 700, y: 120 }, keep)
    expect(slid.x).toBe(stuck.x)
    expect(slid.y).toBe(120)
  })

  it("never jumps over a neighbour, however far the pointer goes in one step", () => {
    const keep = keepoutsOf([sec("b", 312, 0)])
    const at = moveSection(sec("a", 0, 0), { x: 5000, y: 0 }, keep)
    expect(at.x).toBe(312 - GAP - 240)
  })

  it("goes round a neighbour when the pointer does", () => {
    const keep = keepoutsOf([sec("b", 300, 0)])
    let at = { x: 0, y: 0 }
    // Down, past it, then across: each step from the last good place.
    for (const to of [{ x: 0, y: 120 }, { x: 0, y: 240 }, { x: 600, y: 240 }]) at = moveSection({ ...sec("a", 0, 0), ...at }, to, keep)
    expect(at).toEqual({ x: 600, y: 240 })
  })

  it("stops against a section above or below too", () => {
    const keep = keepoutsOf([sec("b", 0, 408)])
    const at = moveSection(sec("a", 0, 0), { x: 0, y: 900 }, keep)
    expect(at.y).toBe(408 - GAP - 8 * GRID)
    const up = moveSection(sec("a", 0, 1008), { x: 0, y: 0 }, keep)
    expect(up.y).toBe(408 + 8 * GRID + GAP)
  })

  it("allows exactly one cell between two sections", () => {
    const keep = keepoutsOf([sec("b", 240 + GAP, 0)])
    const at = moveSection(sec("a", 0, 0), { x: 24, y: 0 }, keep)
    expect(at.x).toBe(0)
    expect(intersecting([sec("a", at.x, 0), sec("b", 240 + GAP, 0)])).toBe(false)
    expect(intersecting([sec("a", 1, 0), sec("b", 240 + GAP, 0)])).toBe(true)
  })

  it("keeps clear of a keepout with its own gap, like Now, and of the timeline's strip with none", () => {
    const now: Keepout = { rect: { x: 0, y: 500, width: 440, height: 400 }, gap: GAP }
    const rail: Keepout = { rect: { x: 1000, y: -1e6, width: 1e6, height: 2e6 }, gap: 0 }
    const down = moveSection(sec("a", 0, 0), { x: 0, y: 2000 }, [now])
    expect(down.y).toBe(24 * Math.floor((500 - GAP - 8 * GRID) / 24))
    const across = moveSection(sec("a", 0, 0), { x: 5000, y: 0 }, [rail])
    expect(across.x).toBe(24 * Math.floor((1000 - 240) / 24))
    expect(across.x + 240).toBeLessThanOrEqual(1000)
  })

  it("nudges by whole cells and stops at what is in the way", () => {
    const keep = keepoutsOf([sec("b", 240 + 2 * GAP, 0)])
    expect(nudgeSection(sec("a", 0, 0), { x: 1, y: 0 }, keep)).toEqual({ x: 24, y: 0 })
    expect(nudgeSection(sec("a", 24, 0), { x: 4, y: 0 }, keep)).toEqual({ x: 24, y: 0 })
    expect(nudgeSection(sec("a", 0, 0), { x: 0, y: -4 }, [])).toEqual({ x: 0, y: -96 })
  })
})

describe("resizing by a handle", () => {
  const s = sec("a", 240, 240, 240, 192)

  it("moves the dragged edges to the grid and keeps the opposite ones where they are", () => {
    const east = resizeSection(s, "e", { x: 600.9, y: 0 }, [])
    expect(east).toMatchObject({ x: 240, y: 240, w: 360, h: 192 })
    const west = resizeSection(s, "w", { x: 100, y: 999 }, [])
    expect(west).toMatchObject({ x: 96, y: 240, w: 384, h: 192 })
    expect(west.x + west.w).toBe(480)
    const north = resizeSection(s, "n", { x: 0, y: 100 }, [])
    expect(north).toMatchObject({ x: 240, y: 96, w: 240 })
    expect(north.y + north.h).toBe(432)
    const south = resizeSection(s, "s", { x: 0, y: 600 }, [])
    expect(south).toMatchObject({ y: 240, h: 360 })
  })

  it("moves two edges by a corner, the opposite corner fixed", () => {
    const nw = resizeSection(s, "nw", { x: 200, y: 190 }, [])
    expect(nw).toMatchObject({ x: 192, y: 192, w: 288, h: 240 })
    const se = resizeSection(s, "se", { x: 700, y: 700 }, [])
    expect(se).toMatchObject({ x: 240, y: 240, w: 456, h: 456 })
    for (const h of ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as Handle[]) expect(gridded(resizeSection(s, h, { x: 333, y: 111 }, []))).toBe(true)
  })

  it("never goes below the minimum size, nor flips over", () => {
    const tiny = resizeSection(s, "e", { x: 0, y: 0 }, [])
    expect(tiny.w).toBe(MIN_W)
    expect(tiny.x).toBe(240)
    const north = resizeSection(s, "n", { x: 0, y: 5000 }, [])
    expect(north.h).toBe(MIN_H)
    expect(north.y + north.h).toBe(432)
    const corner = resizeSection(s, "se", { x: -900, y: -900 }, [])
    expect([corner.w, corner.h]).toEqual([MIN_W, MIN_H])
  })

  it("stops at a neighbour one cell short, and slides its other edge", () => {
    const keep = keepoutsOf([sec("b", 600, 200)])
    const east = resizeSection(s, "e", { x: 900, y: 0 }, keep)
    expect(east.x + east.w).toBe(600 - GAP)
    // A corner pulled into it: the blocked edge stops, the free one goes on.
    const corner = resizeSection(s, "se", { x: 900, y: 900 }, keep)
    expect(corner.x + corner.w).toBe(600 - GAP)
    expect(corner.y + corner.h).toBe(912)
  })

  it("does not jump over a neighbour in one step", () => {
    const keep = keepoutsOf([sec("b", 504, 200)])
    const east = resizeSection(s, "e", { x: 4000, y: 0 }, keep)
    expect(east.x + east.w).toBe(504 - GAP)
  })

  it("shrinking is never blocked, and nothing touching comes of any handle", () => {
    const others = [sec("b", 480 + GAP, 240), sec("c", 240, 432 + GAP)]
    const keep = keepoutsOf(others)
    for (const h of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]) {
      for (const p of [{ x: 0, y: 0 }, { x: 1500, y: 1500 }, { x: 300, y: 300 }, { x: 500, y: 100 }, { x: -500, y: 700 }]) {
        const r = resizeSection(s, h, p, keep)
        expect(intersecting([r, ...others])).toBe(false)
        expect(gridded(r)).toBe(true)
      }
    }
  })

  it("can't squeeze the cards inside it: the edge stops at their box with padding", () => {
    const inside = { x: 300, y: 300, width: 100, height: 100 }
    const e = resizeSection(s, "e", { x: 0, y: 0 }, [], inside)
    expect(e.x + e.w).toBeGreaterThanOrEqual(400 + PAD)
    expect(onGrid(e.x + e.w)).toBe(true)
    const w = resizeSection(s, "w", { x: 5000, y: 0 }, [], inside)
    expect(w.x).toBeLessThanOrEqual(300 - PAD)
    const n = resizeSection(s, "n", { x: 0, y: 5000 }, [], inside)
    expect(n.y).toBeLessThanOrEqual(300 - PAD)
    const south = resizeSection(s, "s", { x: 0, y: 0 }, [], inside)
    expect(south.y + south.h).toBeGreaterThanOrEqual(400 + PAD)
  })
})

describe("drawing a section", () => {
  it("snaps both corners and goes whichever way the pointer does", () => {
    expect(drawSection({ x: 101, y: 99 }, { x: 301, y: 251 }, [])).toEqual({ box: { x: 96, y: 96, width: 216, height: 144 }, ok: true })
    const back = drawSection({ x: 300, y: 300 }, { x: 100, y: 100 }, [])
    expect(back.box).toEqual({ x: 96, y: 96, width: 216, height: 216 })
    expect(back.ok).toBe(true)
  })

  it("is at least the minimum size, towards the pointer", () => {
    const d = drawSection({ x: 240, y: 240 }, { x: 250, y: 250 }, [])
    expect(d.box).toEqual({ x: 240, y: 240, width: MIN_W, height: MIN_H })
    const up = drawSection({ x: 240, y: 240 }, { x: 230, y: 230 }, [])
    expect(up.box).toEqual({ x: 240 - MIN_W, y: 240 - MIN_H, width: MIN_W, height: MIN_H })
  })

  it("stops one cell short of what is in its way, and is not big enough to keep when that leaves too little", () => {
    const keep = keepoutsOf([sec("b", 504, 0, 240, 480)])
    const d = drawSection({ x: 100, y: 100 }, { x: 900, y: 300 }, keep)
    expect(d.box).toMatchObject({ x: 96, y: 96 })
    expect((d.box?.x ?? 0) + (d.box?.width ?? 0)).toBe(504 - GAP)
    expect(d.ok).toBe(true)
    const cramped = drawSection({ x: 400, y: 100 }, { x: 900, y: 300 }, keep)
    expect(cramped.ok).toBe(false)
  })

  it("steps out of a neighbour's margin to start a cell from it, and can't start on one", () => {
    const keep = keepoutsOf([sec("b", 0, 0, 240, 240)])
    const near = drawSection({ x: 250, y: 100 }, { x: 600, y: 300 }, keep)
    expect(near.box?.x).toBe(240 + GAP)
    expect(drawSection({ x: 100, y: 100 }, { x: 600, y: 300 }, keep).box).toBeNull()
  })

  it("keeps clear of Now and of the timeline", () => {
    const now: Keepout = { rect: { x: 0, y: 400, width: 440, height: 400 }, gap: GAP }
    const d = drawSection({ x: 0, y: 100 }, { x: 300, y: 900 }, [now])
    expect((d.box?.y ?? 0) + (d.box?.height ?? 0)).toBeLessThanOrEqual(400 - GAP)
  })
})

describe("making stored sections sound", () => {
  it("snaps a section to the grid and gives it at least the minimum size", () => {
    expect(soundSection({ id: "a", name: "A", x: 13, y: 100, w: 30, h: 10 })).toEqual({ id: "a", name: "A", x: 24, y: 96, w: MIN_W, h: MIN_H })
  })

  it("drops what is not a section, and gives a bad name the default", () => {
    expect(soundSection(null)).toBeNull()
    expect(soundSection({ id: "a", x: 0, y: 0, w: "wide", h: 5 })).toBeNull()
    expect(soundSection({ id: "", x: 0, y: 0, w: 240, h: 240 })).toBeNull()
    expect(soundSection({ id: "a", x: Number.NaN, y: 0, w: 240, h: 240 })).toBeNull()
    expect(soundSection({ id: "a", name: "bad\nname", x: 0, y: 0, w: 240, h: 240 }, "Section")?.name).toBe("Section")
    expect(soundSection({ id: "a", name: "   ", x: 0, y: 0, w: 240, h: 240 }, "Untitled")?.name).toBe("Untitled")
    expect(soundSection({ id: "a", name: "  Kept  ", x: 0, y: 0, w: 240, h: 240 })?.name).toBe("Kept")
  })

  it("leaves sections that are clear as they are", () => {
    const ok = [sec("a", 0, 0), sec("b", 240 + GAP, 0), sec("c", 0, 192 + GAP)]
    expect(normalizeSections(ok)).toEqual(ok)
  })

  it("nudges a section that touches an earlier one out along the way it overlaps least", () => {
    const out = normalizeSections([sec("a", 0, 0), sec("b", 200, 24)])
    expect(out).toHaveLength(2)
    expect(intersecting(out)).toBe(false)
    expect(out[0]).toEqual(sec("a", 0, 0))
    // 40 across (to the right) is less than 168 down.
    expect(out[1]).toMatchObject({ x: 240 + GAP, y: 24 })
  })

  it("nudges one off Now too, and is the same every time", () => {
    const now: Keepout = { rect: { x: 100, y: 100, width: 100, height: 100 }, gap: GAP }
    const input = [sec("a", 0, 0), sec("b", 300, 40), sec("c", 120, 60)]
    const a = normalizeSections(input, [now])
    expect(normalizeSections(input, [now])).toEqual(a)
    expect(intersecting(a, [now])).toBe(false)
    expect(a.every(gridded)).toBe(true)
  })

  it("shrinks a section that has nowhere to be nudged to, and drops one that can't be saved", () => {
    // Boxed in on both sides by sections 2 cells apart from each other, and a third on the same place.
    const a = sec("a", 0, 0, 240, 192)
    const wall = sec("w", 240 + GAP + 120 + GAP, 0, 240, 192)
    const out = normalizeSections([a, wall, sec("m", 240 + GAP + 24, 0, 240, 192)])
    expect(intersecting(out)).toBe(false)
    expect(out.every((x) => x.w >= MIN_W && x.h >= MIN_H)).toBe(true)
    // Exactly on the same spot as another and unable to fit anywhere: still never touching.
    const dupes = normalizeSections([sec("a", 0, 0), sec("b", 0, 0), sec("c", 0, 0)])
    expect(intersecting(dupes)).toBe(false)
  })

  it("drops a repeated id", () => {
    expect(normalizeSections([sec("a", 0, 0), sec("a", 1000, 0)])).toHaveLength(1)
  })

  it("never gives touching sections whatever it is given", () => {
    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let round = 0; round < 60; round += 1) {
      const input = Array.from({ length: 6 }, (_, i) => ({ id: `s${String(i)}`, name: "x", x: rand(600) - 100, y: rand(600) - 100, w: 20 + rand(500), h: 20 + rand(400) }))
      const now: Keepout = { rect: { x: rand(300), y: rand(300), width: 200, height: 200 }, gap: GAP }
      const out = normalizeSections(input, [now])
      expect(intersecting(out, [now])).toBe(false)
      expect(out.every(gridded)).toBe(true)
    }
  })
})

describe("cards in sections", () => {
  const a = sec("a", 240, 240, 480, 432)
  const card = (x: number, y: number) => ({ x, y, width: 240, height: 150 })

  it("is in the section its centre is in, the left and top edges in, the right and bottom out", () => {
    expect(sectionAt([a], { x: 240, y: 240 })?.id).toBe("a")
    expect(sectionAt([a], { x: 719.9, y: 671.9 })?.id).toBe("a")
    expect(sectionAt([a], { x: 720, y: 300 })).toBeNull()
    expect(sectionAt([a], { x: 300, y: 672 })).toBeNull()
    expect(sectionAt([a], { x: 100, y: 100 })).toBeNull()
  })

  it("decides by the picture's centre, whatever else hangs outside", () => {
    // Centre at (x + 120, y + 75).
    expect(dropInto([a], card(130, 200))?.section).toBe("a")
    expect(dropInto([a], card(100, 200))).toBeNull()
    expect(dropInto([a], card(560, 520))?.section).toBe("a")
    expect(dropInto([a], card(620, 520))).toBeNull()
  })

  it("keeps a card inside: PAD from the edges, caption included, and a too big one at the top left", () => {
    const into = dropInto([a], card(130, 200))
    expect(into).toEqual({ section: "a", x: PAD, y: PAD })
    const low = dropInto([a], card(300, 520))
    expect(low?.y).toBe(a.h - (150 + CAPTION_ROOM) - PAD)
    expect(clampInto(sec("t", 0, 0, 120, 96), { x: 50, y: 50 }, { width: 240, height: 270 })).toEqual({ x: PAD, y: PAD })
    expect(extentOf(card(0, 0))).toEqual({ width: 240, height: 150 + CAPTION_ROOM })
  })

  const slot = { x: 1000, y: 1000, width: 240, height: 150 }
  const none: Arrangement = { sections: [a], members: {}, moves: {} }

  it("drops a card into a section: its place from the section's top left replaces a move", () => {
    const next = dropCard({ ...none, moves: { c: { x: 5, y: 5 } } }, "c", slot, { x: -600, y: -700 })
    // Slot + offset = (400, 300): centre (520, 375) is inside.
    expect(next.members["c"]).toEqual({ section: "a", x: 160, y: 60 })
    expect(next.moves).toEqual({})
  })

  it("drops a card out of a section: a move replaces the membership", () => {
    const inside: Arrangement = { ...none, members: { c: { section: "a", x: 10, y: 10 } } }
    const out = dropCard(inside, "c", slot, { x: 30, y: -20 })
    expect(out.members).toEqual({})
    expect(out.moves).toEqual({ c: { x: 30, y: -20 } })
    // Back in its slot: no move at all.
    expect(dropCard(inside, "c", slot, { x: 0, y: 0 }).moves).toEqual({})
  })

  it("takes in the loose cards a new or resized section covers, and only those", () => {
    const placed = new Map([
      ["in", card(300, 300)],
      ["out", card(900, 900)],
      ["already", card(300, 450)],
      ["hidden", card(320, 320)],
    ])
    const start: Arrangement = { sections: [a, sec("z", 2000, 2000)], members: { already: { section: "z", x: 0, y: 0 } }, moves: { in: { x: 4, y: 4 } } }
    const got = capture(start, "a", placed, new Set(["in", "out", "already"]))
    expect(got.members["in"]).toMatchObject({ section: "a" })
    expect(got.members["out"]).toBeUndefined()
    expect(got.members["already"]).toEqual({ section: "z", x: 0, y: 0 })
    expect(got.members["hidden"]).toBeUndefined()
    expect(got.moves).toEqual({})
  })

  it("places members from their section, so moving the section moves them, and leaves the rest", () => {
    const cards = new Map([
      ["m", { ...card(0, 0), name: "m" }],
      ["l", { ...card(5, 5), name: "l" }],
    ])
    const members = { m: { section: "a", x: 40, y: 60 } }
    expect(placeMembers(cards, [a], members).get("m")).toMatchObject({ x: 280, y: 300 })
    const moved = { ...a, x: a.x + 120, y: a.y - 48 }
    expect(placeMembers(cards, [moved], members).get("m")).toMatchObject({ x: 400, y: 252 })
    expect(placeMembers(cards, [moved], members).get("l")).toMatchObject({ x: 5, y: 5 })
    // A member of a section that isn't there is where the layout put it.
    expect(placeMembers(cards, [], members).get("m")).toMatchObject({ x: 0, y: 0 })
  })

  it("brings a member that sticks out of a shrunken section back in, and never moves a card that is not its own", () => {
    const cards = new Map([["m", { ...card(0, 0), name: "m" }]])
    const small = sec("a", 0, 0, 480, 384)
    const at = placeMembers(cards, [small], { m: { section: "a", x: 900, y: 900 } }).get("m")
    expect(at?.x).toBe(480 - 240 - PAD)
    expect(at?.y).toBe(384 - 270 - PAD)
  })

  it("finds the box of a section's members, with their captions, or none", () => {
    const placed = new Map([
      ["m", card(300, 300)],
      ["n", card(500, 350)],
    ])
    const members = { m: { section: "a", x: 0, y: 0 }, n: { section: "a", x: 0, y: 0 }, o: { section: "b", x: 0, y: 0 } }
    expect(membersBox(members, "a", placed)).toEqual({ x: 300, y: 300, width: 440, height: 200 + CAPTION_ROOM })
    expect(membersBox(members, "z", placed)).toBeNull()
    expect(membersOf(members, "a").sort()).toEqual(["m", "n"])
  })

  it("keeps members where they stand in the world while the section's top left moves by a resize", () => {
    const members = { m: { section: "a", x: 40, y: 60 }, o: { section: "b", x: 1, y: 2 } }
    expect(shiftMembers(members, "a", 24, -48)).toEqual({ m: { section: "a", x: 64, y: 12 }, o: { section: "b", x: 1, y: 2 } })
    expect(shiftMembers(members, "a", 0, 0)).toBe(members)
  })
})

describe("removing a section", () => {
  it("takes only the section: its cards stay exactly where they stand, as loose cards", () => {
    const a = sec("a", 240, 240, 480, 432)
    const slots = new Map([
      ["m", { x: 1000, y: 1000, width: 240, height: 150 }],
      ["n", { x: 1300, y: 1000, width: 240, height: 150 }],
      ["x", { x: 5, y: 5, width: 240, height: 150 }],
    ])
    const placed = new Map([
      ["m", { x: 252, y: 252, width: 240, height: 150 }],
      ["n", { x: 1300, y: 1000, width: 240, height: 150 }],
      ["x", { x: 5, y: 5, width: 240, height: 150 }],
    ])
    const start: Arrangement = {
      sections: [a, sec("b", 3000, 0)],
      members: { m: { section: "a", x: 12, y: 12 }, n: { section: "b", x: 0, y: 0 } },
      moves: { x: { x: 1, y: 1 } },
    }
    const got = removeSection(start, "a", placed, slots)
    expect(got.sections.map((s) => s.id)).toEqual(["b"])
    expect(got.members).toEqual({ n: { section: "b", x: 0, y: 0 } })
    // Offsets that put m back where it stood: 252 - 1000.
    expect(got.moves).toEqual({ x: { x: 1, y: 1 }, m: { x: -748, y: -748 } })
    // Every card is where it was.
    expect(1000 + (got.moves["m"]?.x ?? 0)).toBe(252)
  })
})

describe("what the canvas reads", () => {
  it("reads members of sections that are there, in places that are numbers, of checkpoints that are", () => {
    const got = soundMembers({ a: { section: "s1", x: 1, y: 2 }, b: { section: "gone", x: 1, y: 2 }, c: { section: "s1", x: "1", y: 2 }, d: null, e: { section: "s1", x: 3, y: 4 } }, [{ id: "s1" }], new Set(["a", "b", "c", "d"]))
    expect(got).toEqual({ a: { section: "s1", x: 1, y: 2 } })
    expect(soundMembers("no", [{ id: "s1" }])).toEqual({})
  })

  it("orders sections top to bottom, then left to right", () => {
    expect(readingOrder([sec("c", 500, 100), sec("a", 0, 0), sec("b", 300, 0)]).map((s) => s.id)).toEqual(["a", "b", "c"])
  })

  it("leaves a day's date with the cards that are in no section", () => {
    expect(looseNames(["a", "b", "c"], { b: { section: "s", x: 0, y: 0 } })).toEqual(["a", "c"])
    expect(looseNames(["a"], { a: { section: "s", x: 0, y: 0 } })).toEqual([])
  })
})

describe("keeping sections in the settings", () => {
  const stored = {
    sections: {
      "work-pc": {
        list: [sec("s1", 24, 48, 480, 432, "Yesterday's runs"), sec("s2", 528, 48, 240, 192, "Notes")],
        members: { a: { section: "s1", x: 12, y: 12 }, b: { section: "s1", x: 252, y: 12 }, c: { section: "s2", x: 12, y: 12 } },
      },
    },
  }

  it("has none by default, and writes no key for none", () => {
    expect(parseSettings(null).sections).toBeUndefined()
    expect(parseSettings({ showAutomatic: false }).sections).toBeUndefined()
    expect(parseSettings({ sections: "no" }).sections).toBeUndefined()
    expect(parseSettings({ sections: { m: { list: [], members: {} } } }).sections).toBeUndefined()
    expect(JSON.stringify(parseSettings({ zoom: 2 }))).not.toContain("sections")
  })

  it("comes back as it was written (a round trip through the file's JSON)", () => {
    const first = parseSettings(stored)
    expect(first.sections).toEqual(stored.sections)
    expect(parseSettings(JSON.parse(JSON.stringify(first)))).toEqual(first)
  })

  it("keeps sections per machine, and the cards and moves besides", () => {
    const both = parseSettings({ layouts: { "work-pc": { x: { x: 1, y: 2 } } }, ...stored, zoom: 0.5 })
    expect(both.zoom).toBe(0.5)
    expect(both.layouts).toEqual({ "work-pc": { x: { x: 1, y: 2 } } })
    expect(Object.keys(both.sections ?? {})).toEqual(["work-pc"])
  })

  it("keeps keys it doesn't know, for another version of the app", () => {
    const got = parseSettings({ ...stored, futureThing: { a: 1 } }) as unknown as Record<string, unknown>
    expect(got["futureThing"]).toEqual({ a: 1 })
  })

  it("makes what it reads sound: on the grid, never touching, members of sections that are there", () => {
    const odd = parseSettings({
      sections: {
        m: {
          list: [
            { id: "a", name: "A", x: 13, y: 7, w: 250, h: 190 },
            { id: "b", name: "B", x: 100, y: 50, w: 300, h: 200 },
            { id: "a", name: "again", x: 900, y: 900, w: 240, h: 192 },
            "nonsense",
          ],
          members: { x: { section: "a", x: 1, y: 2 }, y: { section: "gone", x: 1, y: 2 } },
        },
      },
    })
    const list = odd.sections?.["m"]?.list ?? []
    expect(list.map((s) => s.id)).toEqual(["a", "b"])
    expect(intersecting([...list])).toBe(false)
    expect(list.every(gridded)).toBe(true)
    expect(odd.sections?.["m"]?.members).toEqual({ x: { section: "a", x: 1, y: 2 } })
  })

  it("drops a machine whose sections can't be read, and keeps the others", () => {
    const got = parseSettings({ sections: { bad: "x", worse: { list: "no" }, ok: { list: [sec("a", 0, 0)], members: {} } } })
    expect(Object.keys(got.sections ?? {})).toEqual(["ok"])
  })

  it("is written through the one writer, as part of the checkpoints section", async () => {
    let written: unknown = null
    const calls: string[][] = []
    const invoke = async (_cmd: string, a: { args: string[] }): Promise<unknown> => {
      calls.push(a.args)
      const set = a.args.find((x) => x.startsWith("--set="))
      if (set !== undefined) written = JSON.parse(set.slice("--set=".length))
      return { code: 0, stdout: JSON.stringify(written), stderr: "" }
    }
    Object.assign(globalThis, { window: { __TAURI__: { core: { invoke } } } })
    try {
      const settings = parseSettings(stored)
      await saveSettings(settings)
      expect(calls.every((c) => c[0] === "settings" && c[1] === "--section" && c[2] === "checkpoints")).toBe(true)
      expect(await loadSettings()).toEqual(settings)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})
