/**
 * The Checkpoints view's rules: where cards sit, the timeline, search, names,
 * settings, and what Go Back and Delete ask and do. And the confirmation
 * dialog's third button, rendered in happy-dom.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const cp = await import("../ui/src/features/checkpoints/checkpoints")
const { parseSettings } = await import("../ui/src/features/checkpoints/settings")
const { draftOf, tagsOf } = await import("../ui/src/features/checkpoints/CheckpointDetails")
const { ConfirmDialog } = await import("../ui/src/components/ConfirmDialog")
const { parseNote, parseSaves } = await import("../ui/src/model")
const { centreOf, clampCamera, fitRect } = await import("@winvm/canvas")

type Checkpoint = import("../ui/src/features/checkpoints/checkpoints").Checkpoint

afterAll(() => GlobalRegistrator.unregister())

const at = (y: number, m: number, d: number, h = 12, min = 0): string => new Date(y, m - 1, d, h, min).toISOString()

function checkpoint(name: string, createdAt: string, extra: Partial<Checkpoint> = {}): Checkpoint {
  return {
    name,
    kind: "manual",
    createdAt,
    bytes: 1,
    compatible: true,
    title: null,
    screenshot: null,
    thumbnail: null,
    notes: null,
    incompatible: [],
    ...extra,
  }
}

const list = [
  checkpoint("a", at(2026, 8, 9, 10)),
  checkpoint("b", at(2026, 10, 20, 9)),
  checkpoint("c", at(2026, 10, 20, 15)),
  checkpoint("d", at(2026, 10, 21, 8)),
]

describe("the timeline layout", () => {
  const layout = cp.layoutTimeline(list, 16 / 10)

  it("keeps every checkpoint in time order, oldest first", () => {
    expect(layout.order).toEqual(["a", "b", "c", "d"])
    expect([...layout.cards.keys()].sort()).toEqual(["a", "b", "c", "d"])
  })

  it("makes one block per day, oldest at the top, Now at the bottom", () => {
    expect(layout.days.map((d) => d.key)).toEqual(["2026-08-09", "2026-10-20", "2026-10-21"])
    const tops = layout.days.map((d) => d.y)
    expect(tops[0]).toBeLessThan(tops[1] ?? 0)
    expect(tops[1]).toBeLessThan(tops[2] ?? 0)
    const newest = layout.days.at(-1)
    expect(newest).toBeDefined()
    expect((newest?.y ?? 0) + (newest?.height ?? 0)).toBeLessThan(layout.now.y)
    expect(layout.now.y).toBe(0)
  })

  it("lays a day out left to right in the order taken, and draws older days smaller", () => {
    const b = layout.cards.get("b")
    const c = layout.cards.get("c")
    const d = layout.cards.get("d")
    const a = layout.cards.get("a")
    expect(b?.y).toBe(c?.y)
    expect(b?.x ?? 0).toBeLessThan(c?.x ?? 0)
    expect(d?.scale).toBe(1)
    expect(b?.scale).toBeCloseTo(cp.DEPTH_STEP, 6)
    expect(a?.scale).toBeCloseTo(cp.DEPTH_STEP ** 2, 6)
    expect(cp.depthScale(50)).toBe(cp.DEPTH_MIN)
  })

  it("centres each day over Now, and wraps a busy day after `columns`", () => {
    const busy = Array.from({ length: 8 }, (_, i) => checkpoint(`x${String(i)}`, at(2026, 10, 21, 8, i)))
    const l = cp.layoutTimeline(busy, 16 / 10, 3)
    const day = l.days[0]
    expect(day).toBeDefined()
    expect((day?.x ?? 0) + (day?.width ?? 0) / 2).toBeCloseTo(0, 6)
    const lines = new Set(busy.map((c) => l.cards.get(c.name)?.y))
    expect(lines.size).toBe(3)
    // The last, short line is centred under the full ones.
    const last = ["x6", "x7"].map((n) => l.cards.get(n))
    const mid = ((last[0]?.x ?? 0) + (last[1]?.x ?? 0) + (last[1]?.width ?? 0)) / 2
    expect(mid).toBeCloseTo(0, 6)
  })

  it("gives Now the screen's own shape, so it can stand exactly where the screen is", () => {
    const wide = cp.layoutTimeline([], 2)
    expect(wide.now.width / wide.now.frame).toBeCloseTo(2, 2)
    const fallback = cp.layoutTimeline([], Number.NaN)
    expect(fallback.now.width / fallback.now.frame).toBeCloseTo(1.6, 2)
    expect(cp.frameOf(wide.now)).toEqual({ x: wide.now.x, y: wide.now.y, width: wide.now.width, height: wide.now.frame })
  })

  it("bounds everything, dates included", () => {
    const b = layout.bounds
    for (const r of [layout.now, ...layout.cards.values(), ...layout.days.map(cp.withLabel)]) {
      expect(r.x).toBeGreaterThanOrEqual(b.x - 1e-6)
      expect(r.y).toBeGreaterThanOrEqual(b.y - 1e-6)
      expect(r.x + r.width).toBeLessThanOrEqual(b.x + b.width + 1e-6)
      expect(r.y + r.height).toBeLessThanOrEqual(b.y + b.height + 1e-6)
    }
  })

  it("opens on Now and the newest two days", () => {
    const v = cp.openingView(layout)
    const second = layout.days[1]
    expect(second).toBeDefined()
    if (second !== undefined) expect(v.y).toBeCloseTo(cp.withLabel(second).y, 6)
    expect(v.y + v.height).toBeCloseTo(layout.now.y + layout.now.height, 6)
  })

  it("keeps the camera in reach of the stack whatever the zoom", () => {
    const view = { width: 1280, height: 820 }
    const fit = fitRect(layout.bounds, view, 48)
    const lost = clampCamera({ x: 99_999, y: -99_999, zoom: 50 }, layout.bounds, view, 96, { min: fit.zoom * 0.85, max: 3 })
    expect(lost.zoom).toBe(3)
    const c = centreOf(lost, view)
    expect(c.x).toBeGreaterThanOrEqual(layout.bounds.x)
    expect(c.x).toBeLessThanOrEqual(layout.bounds.x + layout.bounds.width)
    expect(c.y).toBeGreaterThanOrEqual(layout.bounds.y)
    expect(c.y).toBeLessThanOrEqual(layout.bounds.y + layout.bounds.height)
  })
})

describe("the timeline's ticks", () => {
  const words = { now: "Now", today: "Today", yesterday: "Yesterday", locale: "en-US" }
  const now = new Date(2026, 9, 21, 16)
  const days = cp.layoutTimeline(list, 1.6).days

  it("spaces a tick per day evenly, Now last, months named where they start", () => {
    const ticks = cp.timelineTicks(days, now, words)
    expect(ticks.map((t) => t.at)).toEqual([0, 1 / 3, 2 / 3, 1])
    expect(ticks.map((t) => t.month)).toEqual(["August", "October", null, null])
    expect(ticks.map((t) => t.label)).toEqual(["August 9", "Yesterday", "Today", "Now"])
    expect(ticks.at(-1)?.kind).toBe("now")
  })

  it("says the weekday within the week, and the year when it isn't this one", () => {
    expect(cp.dayLabel(new Date(2026, 9, 17), now, words)).toBe("Saturday")
    expect(cp.dayLabel(new Date(2025, 11, 30), now, words)).toBe("Dec 30, 2025")
    const ticks = cp.timelineTicks([{ key: "2025-12-30", date: new Date(2025, 11, 30) }], now, words)
    expect(ticks[0]?.month).toBe("December 2025")
  })

  it("finds the tick nearest a point on the timeline, and the day nearest the view", () => {
    const ticks = cp.timelineTicks(days, now, words)
    expect(cp.tickAt(ticks, 0.05)?.key).toBe("2026-08-09")
    expect(cp.tickAt(ticks, 0.95)?.key).toBe("now")
    const layout = cp.layoutTimeline(list, 1.6)
    expect(cp.dayNearest(layout, { x: 0, y: layout.now.y + 10 })).toBeNull()
    const top = layout.days[0]
    expect(cp.dayNearest(layout, { x: 0, y: (top?.y ?? 0) + 1 })).toBe(0)
  })

  it("steps one checkpoint older or newer, from Now to the newest", () => {
    const order = ["a", "b", "c"]
    expect(cp.stepThrough(order, null, -1)).toBe("c")
    expect(cp.stepThrough(order, null, 1)).toBeNull()
    expect(cp.stepThrough(order, "b", -1)).toBe("a")
    expect(cp.stepThrough(order, "a", -1)).toBe("a")
    expect(cp.stepThrough(order, "c", 1)).toBeNull()
    expect(cp.stepThrough([], null, -1)).toBeNull()
  })
})

describe("search", () => {
  const notes = (title: string | null, text: string, tags: string[] = []) => ({ title, text, tags })
  const all = [
    checkpoint("office-installed", at(2026, 10, 16), { title: "Office installed", notes: notes("Office installed", "Excel **activated**", ["office"]) }),
    checkpoint("before-update", at(2026, 10, 18), { notes: notes(null, "KB5050094 pending", ["updates"]) }),
    checkpoint("auto-1", at(2026, 10, 19), { kind: "auto" }),
  ]
  const when = (c: Checkpoint): string => c.createdAt
  it("matches names, titles, notes, tags and kinds, every word, newest first", () => {
    expect(cp.searchCheckpoints(all, "office", when).map((c) => c.name)).toEqual(["office-installed"])
    expect(cp.searchCheckpoints(all, "KB5050094", when).map((c) => c.name)).toEqual(["before-update"])
    expect(cp.searchCheckpoints(all, "updates pending", when).map((c) => c.name)).toEqual(["before-update"])
    expect(cp.searchCheckpoints(all, "updates office", when)).toEqual([])
    expect(cp.searchCheckpoints(all, "AUTO", when).map((c) => c.name)).toEqual(["auto-1"])
    expect(cp.searchCheckpoints(all, "   ", when)).toEqual([])
  })
  it("names a card by its title, and marks one with notes", () => {
    expect(cp.shownName(all[0] as Checkpoint)).toBe("Office installed")
    expect(cp.shownName(all[2] as Checkpoint)).toBe("auto-1")
    expect(cp.hasNotes(all[1] as Checkpoint)).toBe(true)
    expect(cp.hasNotes(checkpoint("t", at(2026, 1, 1), { notes: notes("Only a title", "") }))).toBe(false)
    expect(cp.hasNotes(checkpoint("m", at(2026, 1, 1), { note: "from --note" }))).toBe(true)
  })
})

describe("names and rules", () => {
  const now = new Date(2026, 9, 21, 16, 43, 5)
  it("makes a save name from a title, or the time, never one taken", () => {
    expect(cp.saveNameFor("Before Office 365!", new Set(), now)).toBe("Before-Office-365")
    expect(cp.saveNameFor("  Café crème ", new Set(), now)).toBe("Cafe-creme")
    expect(cp.saveNameFor("", new Set(), now)).toBe("2026-10-21_16-43-05")
    expect(cp.saveNameFor("!!!", new Set(), now)).toBe("2026-10-21_16-43-05")
    expect(cp.saveNameFor("stow", new Set(), now)).toBe("2026-10-21_16-43-05")
    expect(cp.saveNameFor("Clean", new Set(["Clean", "Clean-2"]), now)).toBe("Clean-3")
    for (const title of ["x".repeat(200), "-leading", ".dot", "a/b\\c", "naïve"]) {
      expect(cp.validSaveName(cp.saveNameFor(title, new Set(), now))).toBe(true)
    }
  })
  it("keeps baselines and goldens from being deleted here, and says why", () => {
    expect(cp.deleteBlocked({ kind: "baseline" })).toBe("checkpoints.keep.baseline")
    expect(cp.deleteBlocked({ kind: "golden" })).toBe("checkpoints.keep.golden")
    expect(cp.deleteBlocked({ kind: "manual" })).toBeNull()
    expect(cp.deleteBlocked({ kind: "auto" })).toBeNull()
    expect(cp.deleteBlocked({ kind: "stow" })).toBeNull()
  })
  it("says the most specific reason a checkpoint can't load", () => {
    expect(cp.incompatibleReason({ compatible: true, incompatible: [] })).toBeNull()
    expect(cp.incompatibleReason({ compatible: null, incompatible: [] })).toBeNull()
    expect(cp.incompatibleReason({ compatible: false, incompatible: ["display"] })).toBe("checkpoints.incompatible.display")
    expect(cp.incompatibleReason({ compatible: false, incompatible: ["qemu", "base"] })).toBe("checkpoints.incompatible.base")
    expect(cp.incompatibleReason({ compatible: false, incompatible: [] })).toBe("checkpoints.incompatible.other")
  })
})

describe("going back", () => {
  const ctx = { live: true, now: new Date(2026, 9, 21, 9), taken: new Set(["Before-going-back-to-Office"]), keepTitle: "Before going back to Office" }
  it("loads straight away when asked to", () => {
    expect(cp.goBackSteps("office", false, ctx)).toEqual([{ verb: "load", name: "office" }])
  })
  it("keeps the present first, under a name not taken, when asked to", () => {
    expect(cp.goBackSteps("office", true, ctx)).toEqual([
      { verb: "save", name: "Before-going-back-to-Office-2", title: "Before going back to Office" },
      { verb: "load", name: "office" },
    ])
  })
  it("has nothing to keep when Windows isn't running", () => {
    expect(cp.goBackSteps("office", true, { ...ctx, live: false })).toEqual([{ verb: "load", name: "office" }])
    expect(cp.goBackConfirm({ live: false })).toEqual({ body: "checkpoints.goBack.bodyStopped", offerSaveFirst: false })
    expect(cp.goBackConfirm({ live: true })).toEqual({ body: "checkpoints.goBack.bodyLive", offerSaveFirst: true })
  })
})

describe("the confirmation's three choices", () => {
  let root: ReturnType<typeof createRoot> | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })
  function render(node: JSX.Element): HTMLElement {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() => root?.render(node))
    return host
  }

  it("offers Cancel, Save Current First and Go Back, each doing its own thing", () => {
    const cancel = mock(() => undefined)
    const second = mock(() => undefined)
    const confirm = mock(() => undefined)
    const host = render(
      <ConfirmDialog
        open
        title="Go back to “Office installed”?"
        body={<p>Windows returns to exactly how it was.</p>}
        confirmLabel="Go Back"
        cancelLabel="Cancel"
        secondaryLabel="Save Current First"
        onSecondary={second}
        onCancel={cancel}
        onConfirm={confirm}
      />,
    )
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".confirm-dialog__actions button")]
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Save Current First", "Go Back"])
    act(() => buttons[1]?.click())
    act(() => buttons[2]?.click())
    act(() => buttons[0]?.click())
    expect(second).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("is two choices when there is no third", () => {
    const host = render(<ConfirmDialog open title="Delete “x”?" body={<p>gone</p>} confirmLabel="Delete" tone="danger" onCancel={() => undefined} onConfirm={() => undefined} />)
    const buttons = [...host.querySelectorAll(".confirm-dialog__actions button")]
    expect(buttons).toHaveLength(2)
    expect(buttons[1]?.className).toContain("btn--destructive")
  })
})

describe("what winvm says", () => {
  it("reads today's saves --json, and an older winvm's", () => {
    const now = parseSaves(
      JSON.stringify([
        {
          name: "x",
          kind: "manual",
          createdAt: "2026-10-21T10:00:00.000Z",
          bytes: 5,
          format: "zstd",
          compatible: false,
          incompatible: ["display"],
          screenshot: "/h/saves/i/x/screen.png",
          thumbnail: "/h/saves/i/x/thumb.png",
          screenSize: { width: 1920, height: 1200 },
          title: "X",
          notes: { title: "X", text: "t", tags: ["a"], updatedAt: "2026-10-21T10:00:00.000Z" },
        },
      ]),
    )
    expect(now?.[0]?.thumbnail).toBe("/h/saves/i/x/thumb.png")
    expect(now?.[0]?.incompatible).toEqual(["display"])
    const old = parseSaves(JSON.stringify([{ name: "y", kind: "auto", createdAt: "2026-10-21T10:00:00.000Z", bytes: 5, compatible: true }]))
    expect(old?.[0]).toMatchObject({ title: null, screenshot: null, thumbnail: null, notes: null, incompatible: [] })
  })
  it("reads a note, its absence, and a failure apart", () => {
    expect(parseNote('{"title":"T","text":"x","tags":[],"updatedAt":"z"}')?.title).toBe("T")
    expect(parseNote("null")).toBeNull()
    expect(parseNote("nonsense")).toBeUndefined()
  })
  it("turns a draft into the note's fields and back", () => {
    expect(tagsOf(" a, b ,, a,c ")).toEqual(["a", "b", "c"])
    expect(draftOf(null)).toEqual({ title: "", text: "", tags: "" })
    expect(draftOf({ title: "T", text: "md", tags: ["a", "b"] })).toEqual({ title: "T", text: "md", tags: "a, b" })
  })
})

describe("settings", () => {
  it("falls back to the defaults for anything missing or broken", () => {
    expect(parseSettings(null)).toEqual({ showAutomatic: true, zoom: null })
    expect(parseSettings({ showAutomatic: false, zoom: 0.5 })).toEqual({ showAutomatic: false, zoom: 0.5 })
    expect(parseSettings({ showAutomatic: "yes", zoom: -1 })).toEqual({ showAutomatic: true, zoom: null })
    expect(parseSettings("nonsense")).toEqual({ showAutomatic: true, zoom: null })
  })
})
