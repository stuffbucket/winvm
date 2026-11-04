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
const { loadSettings, parseSettings, saveSettings } = await import("../ui/src/features/checkpoints/settings")
const { CHECKPOINT_TITLE_MAX, CheckpointDetails, draftOf, shortReason, tagsOf } = await import("../ui/src/features/checkpoints/CheckpointDetails")
const { t } = await import("../ui/src/i18n")
const { ConfirmDialog } = await import("../ui/src/components/ConfirmDialog")
const { ControlBar } = await import("../ui/src/features/checkpoints/ControlBar")
const { ZoomControl, ZOOM_SHOWN_MS, pointerNear } = await import("../ui/src/features/checkpoints/ZoomControl")
const { levelFor, textScale, FULL_WIDTH, NAME_WIDTH, MIN_TEXT } = await import("../ui/src/features/checkpoints/CheckpointCard")
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
  it("thin out as the card gets small on screen: time and size, then the kind, then nothing but the picture", () => {
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
    const calls = { onNew: mock(noop), onNewest: mock(noop), onToggleAutomatic: mock(noop), onDone: mock(noop), onSearchToggle: mock(noop), onReset: mock(noop) }
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
          searchOpen={false}
          query=""
          inputRef={{ current: null }}
          matchCount={0}
          onAutomaticHint={noop}
          onSearchFocus={noop}
          onSearchBlur={noop}
          onQuery={noop}
          onSearchKey={noop}
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
    expect(buttons.length).toBeGreaterThanOrEqual(6)
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

  it("is one rounded field with the magnifier as its leading icon, and the field before the other controls", () => {
    const { host } = bar({ searchOpen: true })
    const box = host.querySelector(".checkpoints__search-box")
    expect(box?.firstElementChild?.getAttribute("aria-label")).toBe("Search checkpoints")
    expect(box?.firstElementChild?.getAttribute("aria-expanded")).toBe("true")
    expect(box?.querySelector("input")).not.toBeNull()
    // The other controls sit in their own group, after the search.
    expect(host.querySelector(".checkpoints__search + .checkpoints__bar-rest")).not.toBeNull()
    // Nothing to clear yet.
    expect(named(host, "Clear search")).toBeNull()
  })

  it("clears with an x once it has words, keeping the cursor in the field, and says how many match", () => {
    const onQuery = mock(noop)
    const { host } = bar({ query: "office", matchCount: 2, onQuery })
    act(() => named(host, "Clear search")?.click())
    expect(onQuery).toHaveBeenCalledWith("")
    expect(document.activeElement).toBe(host.querySelector("input"))
    const status = host.querySelector(".checkpoints__search [role=status]")
    expect(status?.textContent).toBe("2 checkpoints match")
    act(() => root?.unmount())
    document.body.replaceChildren()
    const none = bar({ query: "zzz", matchCount: 0 })
    expect(none.host.querySelector(".checkpoints__search [role=status]")?.textContent).toBe("No checkpoints match")
    expect(none.host.querySelector(".checkpoints__search")?.getAttribute("data-empty")).toBe("true")
    act(() => root?.unmount())
    document.body.replaceChildren()
    // Folded and empty: nothing is said.
    expect(bar().host.querySelector(".checkpoints__search [role=status]")?.textContent).toBe("")
  })

  it("names the button for the newest plainly, with a target glyph rather than a download arrow", () => {
    const { host } = bar()
    const newest = named(host, "Newest")
    expect(newest?.getAttribute("title")).toBe("Newest")
    expect(newest?.querySelector("circle")).not.toBeNull()
    expect(newest?.querySelector("path[d*='m6 11']")).toBeNull()
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
    act(() => named(host, "Newest")?.click())
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

  it("keeps the zoom out of the bar: Reset layout stays, the zoom is its own control", () => {
    const { host } = bar()
    expect(host.querySelector(".checkpoints__zoom")).toBeNull()
    for (const gone of ["Zoom out (⌘−)", "Zoom in (⌘+)", "Show all checkpoints (⌘0)"]) expect(named(host, gone)).toBeNull()
    expect(named(host, "Reset layout")).not.toBeNull()
  })
})

describe("the checkpoint's panel", () => {
  let root: ReturnType<typeof createRoot> | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })
  const noop = (): void => undefined
  const notes = (over: Partial<NonNullable<Checkpoint["notes"]>> = {}): NonNullable<Checkpoint["notes"]> => ({ title: "Office installed", text: "Signed in.", tags: ["office"], ...over })
  function panel(c: Checkpoint, over: Partial<import("react").ComponentProps<typeof CheckpointDetails>> = {}): { host: HTMLElement; onNote: ReturnType<typeof mock>; onClose: ReturnType<typeof mock> } {
    const onNote = mock(noop)
    const onClose = mock(noop)
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() =>
      root?.render(<CheckpointDetails c={c} now={Date.parse("2026-10-22T20:00:00Z")} busy={false} saving="idle" onClose={onClose} onLook={noop} onNote={onNote} onGoBack={noop} onDelete={noop} {...over} />),
    )
    return { host, onNote, onClose }
  }
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    act(() => {
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  const press = (el: Element, key: string): void => {
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    })
  }
  const titleButton = (host: HTMLElement): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>("header button.checkpoint-details__title-field")
  const titleInput = (host: HTMLElement): HTMLInputElement | null => host.querySelector<HTMLInputElement>("header input")
  const withNotes = checkpoint("office", at(2026, 10, 22, 14), { notes: notes() })

  it("names the checkpoint once, at the top, as text that is edited where it stands", () => {
    const { host } = panel(withNotes)
    expect(titleButton(host)?.textContent).toBe("Office installed")
    expect(titleButton(host)?.getAttribute("title")).toBe("Rename (F2)")
    // No separate Name or Title field, and no second copy of the title.
    expect(host.querySelectorAll("label").length).toBe(0)
    expect(host.textContent?.split("Office installed").length).toBe(2)
    expect(host.querySelectorAll("header input").length).toBe(0)
  })

  it("keeps a new title on Return, and writes it at once", () => {
    const { host, onNote } = panel(withNotes)
    act(() => titleButton(host)?.click())
    const field = titleInput(host)
    expect(field?.value).toBe("Office installed")
    expect(field?.getAttribute("aria-label")).toBe("Title")
    type(field as HTMLInputElement, "Office and Teams")
    press(field as HTMLInputElement, "Enter")
    expect(onNote).toHaveBeenCalledTimes(1)
    expect(onNote.mock.calls[0]?.[0]).toEqual({ title: "Office and Teams", text: "Signed in.", tags: "office" })
    expect(titleButton(host)?.textContent).toBe("Office and Teams")
  })

  it("puts the title back on Escape, and Escape there does not close the panel", () => {
    const { host, onNote, onClose } = panel(withNotes)
    act(() => titleButton(host)?.click())
    type(titleInput(host) as HTMLInputElement, "Something else")
    press(titleInput(host) as HTMLInputElement, "Escape")
    expect(onNote).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(titleButton(host)?.textContent).toBe("Office installed")
  })

  it("keeps the title when the field is left", () => {
    const { host, onNote } = panel(withNotes)
    act(() => titleButton(host)?.click())
    const field = titleInput(host) as HTMLInputElement
    field.focus()
    type(field, "After a pause")
    act(() => field.blur())
    expect(onNote.mock.calls[0]?.[0].title).toBe("After a pause")
  })

  it("says why a title can't be kept, inline, and keeps the field", () => {
    const { host, onNote } = panel(withNotes)
    act(() => titleButton(host)?.click())
    const field = titleInput(host) as HTMLInputElement
    type(field, "x".repeat(CHECKPOINT_TITLE_MAX + 1))
    press(field, "Enter")
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Keep it to 120 characters or fewer.")
    expect(field.getAttribute("aria-invalid")).toBe("true")
    expect(titleInput(host)).not.toBeNull()
    expect(onNote).not.toHaveBeenCalled()
    type(field, "A short one")
    expect(host.querySelector("[role=alert]")).toBeNull()
  })

  it("empties a title back to the name, and says so while the field is empty", () => {
    const { host, onNote } = panel(withNotes)
    act(() => titleButton(host)?.click())
    const field = titleInput(host) as HTMLInputElement
    type(field, "")
    expect(host.textContent).toContain("Leave it empty to use “office”.")
    press(field, "Enter")
    expect(onNote.mock.calls[0]?.[0].title).toBe("")
    expect(titleButton(host)?.textContent).toBe("office")
  })

  it("shows the note as quiet text with a placeholder, and saves it after a pause, with no Save button", async () => {
    const { host, onNote } = panel(checkpoint("plain", at(2026, 10, 22, 14)))
    const note = host.querySelector("textarea") as HTMLTextAreaElement
    expect(note.getAttribute("placeholder")).toBe("Add a note")
    expect(note.getAttribute("aria-label")).toBe("Notes")
    expect([...host.querySelectorAll("button")].some((b) => /save/i.test(b.textContent ?? ""))).toBe(false)
    type(note, "Before the driver update")
    expect(onNote).not.toHaveBeenCalled()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(onNote).toHaveBeenCalledTimes(1)
    expect(onNote.mock.calls[0]?.[0].text).toBe("Before the driver update")
  })

  it("puts the note back on Escape, and saves it as it was", async () => {
    const { host, onNote, onClose } = panel(withNotes)
    const note = host.querySelector("textarea") as HTMLTextAreaElement
    note.focus()
    type(note, "Typed, then thought better of")
    press(note, "Escape")
    expect(note.value).toBe("Signed in.")
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(onNote).not.toHaveBeenCalled()
  })

  it("says a failed save quietly, under the actions", () => {
    const { host } = panel(withNotes, { saving: "failed" })
    const status = host.querySelector("footer [role=status]")
    expect(status?.textContent).toBe("Notes weren't saved")
    expect(status?.getAttribute("data-failed")).toBe("true")
  })

  it("lists its facts as rows, values selectable, with the tags as an editable value", () => {
    const { host } = panel(withNotes)
    const rows = [...host.querySelectorAll(".checkpoint-details__prop")].map((r) => r.querySelector("dt")?.textContent)
    expect(rows).toEqual(["Tags", "Taken", "Kind", "Size", "Loads here", "Name in winvm"])
    const tags = host.querySelector<HTMLInputElement>(".checkpoint-details__prop input")
    expect(tags?.value).toBe("office")
    expect(tags?.getAttribute("aria-label")).toBe("Tags")
  })

  it("says why it can't load in a few words, the whole reason on hover and in its description", () => {
    const { host } = panel(checkpoint("q", at(2026, 10, 21, 12), { compatible: false, incompatible: ["qemu"] }))
    const why = host.querySelector<HTMLElement>(".checkpoint-details__reason")
    const full = "Made with a different version of QEMU, so it can't load here"
    expect(why?.firstElementChild?.tagName.toLowerCase()).toBe("svg")
    expect(why?.childNodes[1]?.textContent).toBe("Different QEMU version")
    expect(why?.getAttribute("title")).toBe(full)
    expect(host.querySelector(`[id="${why?.getAttribute("aria-describedby") ?? ""}"]`)?.textContent).toBe(full)
    // The long sentence is not drawn as a paragraph.
    expect(host.querySelector("p")).toBeNull()
    const goBack = [...host.querySelectorAll("button")].find((b) => b.textContent === "Go Back to This")
    expect(goBack?.disabled).toBe(true)
  })

  it("has a short label for every reason a checkpoint can't load", () => {
    for (const part of ["display", "base", "hardware", "firmware", "qemu", "other"]) {
      const reason = cp.incompatibleReason({ compatible: false, incompatible: part === "other" ? [] : [part] })
      expect(reason).not.toBeNull()
      const key = shortReason(reason as string)
      expect(t(key)).not.toBe(key)
      expect(t(key).length).toBeLessThan(26)
    }
  })

  it("keeps Delete separate from Go Back, each with its icon and its word", () => {
    const { host } = panel(withNotes)
    const buttons = [...host.querySelectorAll("footer button")]
    expect(buttons.map((b) => b.textContent)).toEqual(["Delete…", "Go Back to This"])
    expect(buttons.every((b) => b.querySelector("svg") !== null)).toBe(true)
  })
})

describe("the zoom control", () => {
  let root: ReturnType<typeof createRoot> | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })
  const noop = (): void => undefined
  // Test DOMs compute no layout: the window is 1000x700 and the control sits in its lower left.
  const rect = (left: number, top: number, right: number, bottom: number): DOMRect => ({ left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: noop }) as DOMRect
  function zoomControl(zoom = 0.5): { group: () => HTMLElement; render(zoom: number): void; calls: Record<"out" | "in" | "fit", ReturnType<typeof mock>> } {
    const calls = { out: mock(noop), in: mock(noop), fit: mock(noop) }
    const host = document.createElement("div")
    document.body.append(host)
    host.getBoundingClientRect = () => rect(0, 0, 1000, 700)
    root = createRoot(host)
    const render = (z: number): void => act(() => root?.render(<ZoomControl zoom={z} onZoomOut={calls.out} onZoomIn={calls.in} onFit={calls.fit} />))
    render(zoom)
    const group = (): HTMLElement => host.querySelector<HTMLElement>(".checkpoints__zoom") as HTMLElement
    group().getBoundingClientRect = () => rect(16, 650, 210, 684)
    // No layout here: the host stands in for the offset parent.
    Object.defineProperty(group(), "offsetParent", { value: host })
    return { group, render, calls }
  }
  const move = (x: number, y: number): void => {
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }))
    })
  }
  const shown = (g: HTMLElement): string | null => g.getAttribute("data-shown")
  const rest = async (): Promise<void> => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ZOOM_SHOWN_MS + 150))
    })
  }

  it("is a labelled group of three named buttons and the figure, out of sight at rest", () => {
    const { group, calls } = zoomControl()
    expect(group().getAttribute("role")).toBe("group")
    expect(group().getAttribute("aria-label")).toBe("Zoom")
    expect(shown(group())).toBe("false")
    const buttons = [...group().querySelectorAll("button")]
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Zoom out (⌘−)", "Zoom in (⌘+)", "Show all checkpoints (⌘0)"])
    for (const b of buttons) act(() => b.click())
    expect(calls.out).toHaveBeenCalledTimes(1)
    expect(calls.in).toHaveBeenCalledTimes(1)
    expect(calls.fit).toHaveBeenCalledTimes(1)
    expect(group().textContent).toBe("50%")
  })

  it("eases in when the pointer comes near the lower left, and out a moment after it leaves", async () => {
    const { group } = zoomControl()
    move(500, 300)
    expect(shown(group())).toBe("false")
    move(120, 600)
    expect(shown(group())).toBe("true")
    move(300, 300)
    // The pointer has gone, but the control stays a moment.
    expect(shown(group())).toBe("true")
    await rest()
    expect(shown(group())).toBe("false")
  })

  it("shows while the zoom changes, and folds away once it rests", async () => {
    const { group, render } = zoomControl(0.5)
    // Nothing has changed yet.
    expect(shown(group())).toBe("false")
    render(0.62)
    expect(shown(group())).toBe("true")
    expect(group().textContent).toBe("62%")
    await rest()
    expect(shown(group())).toBe("false")
  })

  it("decides the zone from the window's lower left corner, and around the control where it stands higher", () => {
    const area = rect(0, 0, 720, 520)
    const control = rect(16, 400, 210, 434)
    expect(pointerNear({ x: 100, y: 500 }, control, area)).toBe(true)
    expect(pointerNear({ x: 159, y: 401 }, control, area)).toBe(true)
    expect(pointerNear({ x: 240, y: 420 }, control, area)).toBe(true)
    expect(pointerNear({ x: 400, y: 300 }, control, area)).toBe(false)
    expect(pointerNear({ x: 700, y: 500 }, control, area)).toBe(false)
  })
})
