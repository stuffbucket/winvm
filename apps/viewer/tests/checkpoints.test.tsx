/**
 * The Checkpoints view's rules: where cards sit, the timeline, search, names,
 * settings, and what Go Back and Delete ask and do. And the confirmation
 * dialog's third button, rendered in happy-dom.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, mock, setSystemTime } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const cp = await import("../ui/src/features/checkpoints/checkpoints")
const { loadSettings, parseSettings, saveSettings } = await import("../ui/src/features/checkpoints/settings")
const { draftOf, tagsOf } = await import("../ui/src/features/checkpoints/CheckpointDetails")
const { ConfirmDialog } = await import("../ui/src/components/ConfirmDialog")
const { ControlBar } = await import("../ui/src/features/checkpoints/ControlBar")
const { levelFor, textScale, FULL_WIDTH, NAME_WIDTH, MIN_TEXT, CheckpointCard, cardLabel, absoluteTime, kindIcon } = await import("../ui/src/features/checkpoints/CheckpointCard")
const { NewCheckpointForm } = await import("../ui/src/features/checkpoints/NewCheckpoint")
const { parseNote, parseSaves } = await import("../ui/src/model")
const { centreOf, clampCamera, fitRect } = await import("@winvm/canvas")

type Checkpoint = import("../ui/src/features/checkpoints/checkpoints").Checkpoint
type CardBox = import("../ui/src/features/checkpoints/checkpoints").CardBox
type Moves = import("../ui/src/features/checkpoints/checkpoints").Moves

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
    expect(parseSettings(null)).toEqual({ showAutomatic: true, zoom: null, layouts: {} })
    expect(parseSettings({ showAutomatic: false, zoom: 0.5 })).toEqual({ showAutomatic: false, zoom: 0.5, layouts: {} })
    expect(parseSettings({ showAutomatic: "yes", zoom: -1 })).toEqual({ showAutomatic: true, zoom: null, layouts: {} })
    expect(parseSettings("nonsense")).toEqual({ showAutomatic: true, zoom: null, layouts: {} })
  })

  it("keeps where cards were moved, per machine, and drops what isn't sound", () => {
    const layouts = { "work-pc": { b: { x: 40, y: -12.5 } }, other: { c: { x: 1, y: 2 } } }
    expect(parseSettings({ layouts }).layouts).toEqual(layouts)
    expect(parseSettings({ layouts: "no" }).layouts).toEqual({})
    expect(parseSettings({ layouts: { "work-pc": { b: { x: "far", y: 0 } } } }).layouts).toEqual({})
    // An older file, from before cards could be moved, has none.
    expect(parseSettings({ showAutomatic: false, zoom: 2 }).layouts).toEqual({})
  })

  it("go through `winvm settings --section checkpoints`, the file's one writer", async () => {
    const calls: string[][] = []
    let stored: unknown = null
    const invoke = async (cmd: string, a: { args: string[] }): Promise<unknown> => {
      if (cmd !== "winvm") throw new Error(`unexpected ${cmd}`)
      calls.push(a.args)
      const set = a.args.find((x) => x.startsWith("--set="))
      if (set !== undefined) stored = JSON.parse(set.slice("--set=".length))
      return { code: 0, stdout: JSON.stringify(stored), stderr: "" }
    }
    Object.assign(window, { __TAURI__: { core: { invoke } } })
    try {
      expect(await loadSettings()).toEqual({ showAutomatic: true, zoom: null, layouts: {} })
      await saveSettings({ showAutomatic: false, zoom: 2, layouts: { m: { b: { x: 3, y: 4 } } } })
      expect(await loadSettings()).toEqual({ showAutomatic: false, zoom: 2, layouts: { m: { b: { x: 3, y: 4 } } } })
      expect(calls[0]).toEqual(["settings", "--section", "checkpoints"])
      expect(calls[1]).toEqual(["settings", "--section", "checkpoints", '--set={"showAutomatic":false,"zoom":2,"layouts":{"m":{"b":{"x":3,"y":4}}}}'])
    } finally {
      delete (window as { __TAURI__?: unknown }).__TAURI__
    }
  })
})

describe("moved cards", () => {
  const base = cp.layoutTimeline(list, 16 / 10)

  it("leaves the layout as it was when nothing is moved, or what moved isn't there", () => {
    expect(cp.placeCards(base, {})).toBe(base)
    expect(cp.placeCards(base, { gone: { x: 10, y: 10 } })).toBe(base)
    expect(cp.placeCards(base, { b: { x: 0, y: 0 } })).toBe(base)
  })

  it("moves a card by its offset from its slot, and nothing else", () => {
    const placed = cp.placeCards(base, { b: { x: 500, y: -90 } })
    const was = base.cards.get("b")
    const now = placed.cards.get("b")
    expect(now?.x).toBe((was?.x ?? 0) + 500)
    expect(now?.y).toBe((was?.y ?? 0) - 90)
    expect(now?.width).toBe(was?.width)
    expect(placed.cards.get("c")).toEqual(base.cards.get("c"))
    expect(placed.days).toBe(base.days)
    expect(placed.now).toBe(base.now)
    expect(placed.order).toBe(base.order)
  })

  it("grows the bounds to hold a card moved out of them, and its caption", () => {
    const placed = cp.placeCards(base, { b: { x: 9000, y: 4000 } })
    const b = placed.cards.get("b")
    expect(placed.bounds.x + placed.bounds.width).toBeGreaterThanOrEqual((b?.x ?? 0) + (b?.width ?? 0))
    expect(placed.bounds.y + placed.bounds.height).toBeGreaterThanOrEqual((b?.y ?? 0) + (b?.height ?? 0) + cp.CAPTION_ROOM)
    // Moved within them, nothing grows.
    expect(cp.placeCards(base, { b: { x: 1, y: 1 } }).bounds).toEqual(base.bounds)
  })
})

describe("a card's words", () => {
  it("thin out as the card gets small on screen: time, kind, size and note, then the name, then nothing but the picture", () => {
    expect(levelFor(FULL_WIDTH)).toBe("full")
    expect(levelFor(FULL_WIDTH - 1)).toBe("name")
    expect(levelFor(NAME_WIDTH)).toBe("name")
    expect(levelFor(NAME_WIDTH - 1)).toBe("picture")
  })

  it("never draw smaller than they read: a card's scale up close, the least that reads when far out", () => {
    // Close up an older day's words are a little smaller, like its card.
    expect(textScale(0.8, 2)).toBeCloseTo(0.8, 6)
    // Far out they are scaled up in the world, so on screen they stay at MIN_TEXT of their size.
    for (const zoom of [0.5, 0.3, 0.1]) {
      expect(textScale(0.7, zoom) * zoom).toBeGreaterThanOrEqual(MIN_TEXT - 1e-9)
    }
  })
})

describe("the control bar", () => {
  let root: ReturnType<typeof createRoot> | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })
  const noop = (): void => undefined
  function bar(over: Partial<import("react").ComponentProps<typeof ControlBar>> = {}): { host: HTMLElement; calls: Record<string, ReturnType<typeof mock>> } {
    const calls = { onNew: mock(noop), onNewest: mock(noop), onToggleAutomatic: mock(noop), onDone: mock(noop), onSearchToggle: mock(noop), onReset: mock(noop), onFit: mock(noop) }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() =>
      root?.render(
        <ControlBar
          live
          busy={false}
          creating={false}
          showAutomatic
          zoom={0.53}
          searchOpen={false}
          query=""
          inputRef={{ current: null }}
          onAutomaticHint={noop}
          onSearchFocus={noop}
          onSearchBlur={noop}
          onQuery={noop}
          onSearchKey={noop}
          onZoomOut={noop}
          onZoomIn={noop}
          arranged={false}
          {...calls}
          {...over}
        />,
      ),
    )
    return { host, calls }
  }
  const named = (host: HTMLElement, name: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)

  it("is one labelled group of buttons that each have a name and a tooltip", () => {
    const { host } = bar()
    expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe("Checkpoint controls")
    const buttons = [...host.querySelectorAll("button")]
    expect(buttons.length).toBeGreaterThanOrEqual(8)
    for (const b of buttons) {
      expect((b.getAttribute("aria-label") ?? b.textContent ?? "").length).toBeGreaterThan(0)
      expect(b.getAttribute("title") ?? b.textContent ?? "").not.toBe("")
    }
    // The wordy title chip and "(⌘F)" in the placeholder are gone.
    expect(host.textContent).not.toContain("⌘F)")
    expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("Search names and notes")
  })

  it("keeps search to a magnifier until it is used, and takes no Tab stop while folded", () => {
    const folded = bar()
    expect(folded.host.querySelector(".checkpoints__search")?.getAttribute("data-open")).toBe("false")
    expect(folded.host.querySelector("input")?.getAttribute("tabindex")).toBe("-1")
    act(() => root?.unmount())
    document.body.replaceChildren()
    const open = bar({ searchOpen: true })
    expect(open.host.querySelector(".checkpoints__search")?.getAttribute("data-open")).toBe("true")
    expect(open.host.querySelector("input")?.getAttribute("tabindex")).toBe("0")
    // A search with words in it stays open even when focus has left it.
    act(() => root?.unmount())
    document.body.replaceChildren()
    expect(bar({ query: "office" }).host.querySelector(".checkpoints__search")?.getAttribute("data-open")).toBe("true")
  })

  it("makes Automatic a pressed icon button, and New says why it can't be used", () => {
    const { host, calls } = bar({ showAutomatic: false, live: false })
    const auto = named(host, "Automatic checkpoints")
    expect(auto?.getAttribute("aria-pressed")).toBe("false")
    expect(auto?.textContent).toBe("")
    act(() => auto?.click())
    expect(calls["onToggleAutomatic"]).toHaveBeenCalledTimes(1)
    const fresh = named(host, "New Checkpoint")
    expect(fresh?.disabled).toBe(true)
    expect(fresh?.getAttribute("title")).toBe("Start Windows to take a checkpoint")
    expect(fresh?.textContent).toBe("New")
  })

  it("jumps to the newest, takes a checkpoint, finishes, and resets only once something is moved", () => {
    const { host, calls } = bar()
    act(() => named(host, "Back to the newest")?.click())
    act(() => named(host, "New Checkpoint")?.click())
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Done")?.click())
    expect(calls["onNewest"]).toHaveBeenCalledTimes(1)
    expect(calls["onNew"]).toHaveBeenCalledTimes(1)
    expect(calls["onDone"]).toHaveBeenCalledTimes(1)
    expect(named(host, "Reset layout")?.disabled).toBe(true)
    act(() => root?.unmount())
    document.body.replaceChildren()
    const moved = bar({ arranged: true })
    expect(named(moved.host, "Reset layout")?.disabled).toBe(false)
    act(() => named(moved.host, "Reset layout")?.click())
    expect(moved.calls["onReset"]).toHaveBeenCalledTimes(1)
  })

  it("shows the zoom's figure while the zoom changes, and folds it away once it rests", async () => {
    const { ZOOM_FIGURE_MS } = await import("../ui/src/features/checkpoints/ControlBar")
    const { host } = bar({ zoom: 0.5 })
    const group = (): string | null => host.querySelector(".checkpoints__zoom")?.getAttribute("data-figure") ?? null
    // Nothing has changed yet: the figure is folded.
    expect(group()).toBe("false")
    const rerender = (zoom: number): void => {
      act(() =>
        root?.render(
          <ControlBar
            live
            busy={false}
            creating={false}
            showAutomatic
            zoom={zoom}
            searchOpen={false}
            query=""
            inputRef={{ current: null }}
            onNew={noop}
            onNewest={noop}
            onToggleAutomatic={noop}
            onAutomaticHint={noop}
            onSearchToggle={noop}
            onSearchFocus={noop}
            onSearchBlur={noop}
            onQuery={noop}
            onSearchKey={noop}
            onZoomOut={noop}
            onZoomIn={noop}
            onFit={noop}
            arranged={false}
            onReset={noop}
            onDone={noop}
          />,
        ),
      )
    }
    rerender(0.62)
    expect(group()).toBe("true")
    await act(async () => {
      await new Promise((r) => setTimeout(r, ZOOM_FIGURE_MS + 150))
    })
    expect(group()).toBe("false")
  })
})

describe("a day's date", () => {
  const base = cp.layoutTimeline(list, 16 / 10)
  // The day of "b" and "c" (two cards, one line), and its date's place when nothing is moved.
  const day = base.days.find((d) => d.names.includes("b"))
  const cardsOf = (moves: Moves): ReadonlyMap<string, CardBox> => cp.placeCards(base, moves).cards
  const three = [checkpoint("p", at(2026, 10, 25, 8)), checkpoint("q", at(2026, 10, 25, 9)), checkpoint("r", at(2026, 10, 25, 10))]

  it("sits where the layout puts it while the day's cards are where the layout put them", () => {
    for (const d of base.days) {
      const g = cp.dayGroup(d, base.cards)
      expect(g.label).toEqual(d.label)
      expect(g.rect).toEqual({ x: d.x, y: d.y, width: d.width, height: d.height })
    }
  })

  it("follows its cards: moved together it moves with them, at their top left, a little above", () => {
    if (day === undefined) throw new Error("no day")
    const by = { x: 300, y: -220 }
    const g = cp.dayGroup(day, cardsOf({ b: by, c: by }))
    expect(g.label.x).toBeCloseTo(day.label.x + by.x, 6)
    expect(g.label.y).toBeCloseTo(day.label.y + by.y, 6)
    // Only the leftmost, topmost of them decides: moving the one that is neither changes nothing.
    expect(cp.dayGroup(day, cardsOf({ c: { x: 40, y: 0 } })).label).toEqual(day.label)
  })

  it("stays with the rest of the day when one card is dragged out of it", () => {
    const layout = cp.layoutTimeline(three, 16 / 10)
    const d = layout.days[0]
    if (d === undefined) throw new Error("no day")
    // The first card, taken out: the date goes to the two that are left, at the left of them.
    const out = cp.placeCards(layout, { p: { x: -900, y: -700 } })
    const g = cp.dayGroup(d, out.cards)
    const q = out.cards.get("q")
    expect(g.label.x).toBeCloseTo(q?.x ?? 0, 6)
    expect(g.label.y).toBeCloseTo((q?.y ?? 0) - cp.LABEL_LIFT * d.scale, 6)
  })

  it("follows the day's earliest card when they are all apart", () => {
    const layout = cp.layoutTimeline(three, 16 / 10)
    const d = layout.days[0]
    if (d === undefined) throw new Error("no day")
    const apart = cp.placeCards(layout, { p: { x: 0, y: -900 }, q: { x: 0, y: 0 }, r: { x: 0, y: 900 } })
    const p = apart.cards.get("p")
    const g = cp.dayGroup(d, apart.cards)
    expect(g.label).toEqual({ x: p?.x ?? 0, y: (p?.y ?? 0) - cp.LABEL_LIFT * d.scale })
    expect(g.rect.width).toBe(p?.width ?? 0)
  })

  it("keeps the layout's place for a day none of whose cards are shown", () => {
    if (day === undefined) throw new Error("no day")
    expect(cp.dayGroup(day, new Map()).label).toEqual(day.label)
  })
})

describe("a card's note", () => {
  const cardNote = (text: string, tags: string[] = []): ReturnType<typeof cp.noteOf> => cp.noteOf({ notes: { title: null, text, tags, updatedAt: "" } })

  it("is its text's first line, without markdown marks, and the whole text for the tooltip", () => {
    const n = cardNote("\n## Signed in as **test@contoso.com**.\n\n- Excel activated", ["office"])
    expect(n?.line).toBe("Signed in as test@contoso.com.")
    expect(n?.full).toBe("## Signed in as **test@contoso.com**.\n\n- Excel activated\noffice")
  })

  it("falls back to the manifest's note, then to the tags, and is nothing without any", () => {
    expect(cp.noteOf({ notes: null, note: "from the CLI" })?.line).toBe("from the CLI")
    expect(cardNote("", ["ci", "office"])?.line).toBe("ci, office")
    expect(cp.noteOf({ notes: null })).toBeNull()
    expect(cardNote("  ")).toBeNull()
    // A title alone is the name, not a note.
    expect(cp.noteOf({ notes: { title: "Only a title", text: "", tags: [], updatedAt: "" } })).toBeNull()
  })
})

describe("a card", () => {
  let root: ReturnType<typeof createRoot> | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })
  const NOW = new Date(2026, 10, 3, 15, 30).getTime()
  const box = { name: "x", x: 0, y: 0, width: 240, height: 150, frame: 150, scale: 1, day: 0, index: 0 }
  function card(c: Checkpoint, zoom = 1): HTMLElement {
    act(() => root?.unmount())
    document.body.replaceChildren()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() =>
      root?.render(
        <CheckpointCard c={c} box={box} selected={false} zoom={zoom} now={NOW} dimmed={false} lit={false} carried={false} arriving={null} leaving={false} working={null} onSelect={() => undefined} />,
      ),
    )
    return host
  }
  const text = (host: HTMLElement, cls: string): string | undefined => host.querySelector(`.${cls}`)?.textContent ?? undefined
  const taken = at(2026, 10, 21, 17, 38)
  const note = { title: null, text: "Signed in.\nMore.", tags: [], updatedAt: "" }
  const GIB = 1024 ** 3

  it("is one button holding the picture and its caption, so they are selected and carried as one", () => {
    const host = card(checkpoint("x", taken, { bytes: 7.8 * GIB }))
    const buttons = host.querySelectorAll("button")
    expect(buttons.length).toBe(1)
    expect(buttons[0]?.querySelector(".checkpoint__frame")).not.toBeNull()
    expect(buttons[0]?.querySelector(".checkpoint__caption")).not.toBeNull()
  })

  it("gives each fact its place: the name, the time, the kind with its glyph, the size, and no note when there is none", () => {
    const c = checkpoint("auto-1", taken, { kind: "auto", bytes: 7.8 * GIB })
    const host = card(c)
    expect(text(host, "checkpoint__name")).toBe("auto-1")
    expect(text(host, "checkpoint__when")).toMatch(/^Oct 21, 2026 at /)
    expect(text(host, "checkpoint__kind")).toBe("Automatic")
    expect(host.querySelector(".checkpoint__kind svg")).not.toBeNull()
    expect(text(host, "checkpoint__size")).toBe("7.8 GiB")
    expect(host.querySelector(".checkpoint__note")).toBeNull()
    expect(host.querySelector(".checkpoint__badge")).toBeNull()
    // Nothing floats on the picture's corner any more.
    expect(host.querySelector(".checkpoint__frame .checkpoint__kind")).toBeNull()
  })

  it("shows a note as its own line: its notebook mark, its first line, the whole of it on hover", () => {
    const host = card(checkpoint("x", taken, { notes: note }))
    const line = host.querySelector(".checkpoint__note")
    expect(line?.textContent).toBe("Signed in.")
    expect(line?.getAttribute("title")).toBe("Signed in.\nMore.")
    expect(line?.querySelector("svg")).not.toBeNull()
    // The note is its own line, apart from the kind.
    expect(host.querySelector(".checkpoint__facts")?.contains(line ?? null)).toBe(false)
  })

  it("states Can't load here on the picture, with the reason in its tooltip, not as a caption row", () => {
    const host = card(checkpoint("x", taken, { compatible: false, incompatible: ["display"] }))
    const badge = host.querySelector(".checkpoint__badge")
    expect(badge?.closest(".checkpoint__frame")).not.toBeNull()
    expect(badge?.closest(".checkpoint__caption")).toBeNull()
    expect(badge?.textContent).toBe("Can't load here")
    expect(badge?.getAttribute("title")).toBe("Made with a different display, so it can't load here")
  })

  it("names every fact in its one accessible name", () => {
    const c = checkpoint("x", taken, { kind: "stow", bytes: 7.8 * GIB, notes: note, compatible: false, incompatible: ["qemu"], title: "stow away" })
    const label = card(c).querySelector("button")?.getAttribute("aria-label")
    expect(label).toBe(cardLabel(c, NOW))
    expect(label).toContain("stow away")
    expect(label).toContain("Put away")
    expect(label).toContain("Oct 21, 2026 at")
    expect(label).toContain("7.8 GiB")
    expect(label).toContain("Has notes")
    expect(label).toContain("can't load here")
    // Without a note or a problem, it says neither.
    const plain = cardLabel(checkpoint("y", taken), NOW)
    expect(plain).not.toContain("Has notes")
    expect(plain).not.toContain("can't load")
  })

  it("thins its caption out with its width on screen: all, then the name alone, then the picture", () => {
    const c = checkpoint("x", taken, { notes: note })
    const parts = (zoom: number): string[] => Array.from(card(c, zoom).querySelectorAll(".checkpoint__caption > span")).map((e) => e.className)
    expect(parts(FULL_WIDTH / 240)).toEqual(["checkpoint__name", "checkpoint__when", "checkpoint__facts", "checkpoint__note"])
    expect(parts(NAME_WIDTH / 240)).toEqual(["checkpoint__name"])
    const picture = card(c, (NAME_WIDTH - 1) / 240)
    expect(picture.querySelector(".checkpoint__caption")).toBeNull()
    expect(picture.querySelector("button")?.getAttribute("title")).toContain("x")
  })

  it("has a glyph for each kind", () => {
    expect(new Set(["manual", "auto", "baseline", "stow", "golden"].map(kindIcon)).size).toBe(5)
  })
})

describe("New Checkpoint's name field", () => {
  let root: ReturnType<typeof createRoot> | null = null
  afterEach(() => {
    setSystemTime()
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })
  const input = (): HTMLInputElement => {
    const field = document.querySelector<HTMLInputElement>("#checkpoint-new-title")
    if (field === null) throw new Error("no field")
    return field
  }
  const mount = (): ReturnType<typeof mock> => {
    const onSubmit = mock((..._: unknown[]) => undefined)
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() => root?.render(<NewCheckpointForm live busy={false} onCancel={() => undefined} onSubmit={onSubmit} />))
    return onSubmit
  }

  it("shows the date and time as its placeholder, with no explaining line", () => {
    const stamp = new Date(2026, 10, 3, 15, 30, 12)
    setSystemTime(stamp)
    mount()
    expect(input().placeholder).toBe(absoluteTime(stamp.getTime()))
    expect(input().placeholder).toMatch(/2026/)
    expect(document.body.textContent).not.toContain("Leave it empty")
    expect(document.querySelector(".checkpoints__hint")).toBeNull()
  })

  it("spells the date out for today as for any day: what is stored never says Today", () => {
    expect(absoluteTime(new Date(2026, 10, 3, 15, 30).getTime(), "en-US")).toBe("Nov 3, 2026 at 3:30 PM")
  })

  it("keeps the placeholder current: it changes when the minute does", async () => {
    setSystemTime(new Date(2026, 10, 3, 15, 30, 59, 940))
    mount()
    const first = input().placeholder
    // The clock is frozen under test: move it across the minute while the form waits for it.
    setSystemTime(new Date(2026, 10, 3, 15, 31, 0, 5))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400))
    })
    expect(input().placeholder).not.toBe(first)
    expect(input().placeholder).toBe(absoluteTime(new Date(2026, 10, 3, 15, 31).getTime()))
  })

  it("hands over what was typed, and the placeholder's name for an empty field to be stored as", () => {
    const stamp = new Date(2026, 10, 3, 15, 30, 12)
    setSystemTime(stamp)
    const onSubmit = mount()
    act(() => document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    expect(onSubmit).toHaveBeenCalledWith("", absoluteTime(stamp.getTime()))
  })
})
