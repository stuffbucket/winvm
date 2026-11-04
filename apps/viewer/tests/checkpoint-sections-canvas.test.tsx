/**
 * Sections on the Checkpoints canvas, end to end in happy-dom with a fake app
 * behind it (the checkpoints `winvm saves --json` gives, the settings kept in
 * memory): the Section tool, drawing, naming the tab in place, carrying a
 * section with what is in it, dropping cards in and out, resizing by a handle,
 * never touching, removing only the section, the keys, and it all coming back
 * from the settings. Pointer events carry client coordinates; nothing is laid
 * out here, so positions are read from the nodes' own world transforms and
 * mapped through the camera.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { CheckpointCanvas } = await import("../ui/src/features/checkpoints/CheckpointCanvas")
const { GAP, GRID, intersecting } = await import("../ui/src/features/checkpoints/sections")
const { parseSettings } = await import("../ui/src/features/checkpoints/settings")

type Section = import("../ui/src/features/checkpoints/sections").Section
/** A section on the canvas, with its element (not enumerable). */
type Sec = Section & { readonly el: HTMLElement }

afterAll(() => GlobalRegistrator.unregister())

const INSTANCE = "work-pc"
const at = (y: number, m: number, d: number, h = 12): string => new Date(y, m - 1, d, h, 0).toISOString()
const save = (name: string, createdAt: string): Record<string, unknown> => ({
  name,
  kind: "manual",
  createdAt,
  bytes: 1,
  compatible: true,
  incompatible: [],
  title: null,
  screenshot: null,
  thumbnail: null,
  notes: null,
})
const SAVES = [save("a", at(2026, 8, 9, 10)), save("b", at(2026, 10, 20, 9)), save("c", at(2026, 10, 20, 15)), save("d", at(2026, 10, 21, 8))]

interface World {
  readonly host: HTMLElement
  readonly store: { value: unknown; writes: unknown[] }
  unmount(): void
}
let mounted: World | null = null
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// happy-dom has no pointer capture; the canvas asks for it when a drag begins.
for (const name of ["setPointerCapture", "releasePointerCapture"] as const) {
  if (typeof (HTMLElement.prototype as unknown as Record<string, unknown>)[name] !== "function") Object.assign(HTMLElement.prototype, { [name]: () => undefined })
}

async function mount(initial: unknown = null, saves: Record<string, unknown>[] = SAVES): Promise<World> {
  const store = { value: initial, writes: [] as unknown[] }
  const invoke = async (cmd: string, a: { args: string[] }): Promise<unknown> => {
    const out = (stdout: unknown): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" })
    if (cmd !== "winvm") return null
    const [verb, ...rest] = a.args
    if (verb === "settings") {
      const set = rest.find((x) => x.startsWith("--set="))
      if (set !== undefined) {
        store.value = JSON.parse(set.slice("--set=".length))
        store.writes.push(store.value)
      }
      return out(store.value)
    }
    if (verb === "saves") return out(saves)
    return out("")
  }
  Object.assign(window, { __TAURI__: { core: { invoke } } })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <CheckpointCanvas
        instance={INSTANCE}
        machine="Work PC"
        phase="running"
        busy={false}
        aspect={1.6}
        displayRect={() => null}
        liveSource={() => null}
        run={async () => null}
        closeRequest={0}
        onClosed={() => undefined}
      />,
    )
    await sleep(40)
  })
  const w: World = { host, store, unmount: () => act(() => root.unmount()) }
  mounted = w
  return w
}

afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.replaceChildren()
  delete (window as { __TAURI__?: unknown }).__TAURI__
})

// ---- Reading the canvas ----------------------------------------------------

const viewport = (): HTMLElement => document.querySelector<HTMLElement>(".spatial-canvas__viewport") as HTMLElement
const camera = (): { x: number; y: number; zoom: number } => {
  const m = /translate3d\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px[^)]*\) scale\((-?[\d.e+-]+)\)/.exec(document.querySelector<HTMLElement>(".spatial-canvas__scene")?.style.transform ?? "")
  return { x: Number(m?.[1]), y: Number(m?.[2]), zoom: Number(m?.[3]) }
}
const toScreen = (p: { x: number; y: number }): { x: number; y: number } => {
  const c = camera()
  return { x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y }
}
const boxOf = (el: HTMLElement): { x: number; y: number; w: number; h: number } => {
  const m = /translate3d\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px/.exec(el.style.transform)
  return { x: Number(m?.[1]), y: Number(m?.[2]), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }
}
const sections = (): Sec[] =>
  [...document.querySelectorAll<HTMLElement>(".section")].map((el) => {
    const b = boxOf(el)
    const s = { id: el.dataset["section"] ?? "", name: el.querySelector(".section__name")?.textContent ?? "", ...b }
    // Not enumerable: a failed comparison would otherwise try to print a whole DOM node.
    return Object.defineProperty(s, "el", { value: el, enumerable: false }) as Sec
  })
const sectionBox = (s: Section): Section => ({ id: s.id, name: s.name, x: s.x, y: s.y, w: s.w, h: s.h })
const cardBox = (name: string): { x: number; y: number; w: number; h: number } => boxOf(document.querySelector<HTMLElement>(`.checkpoint[data-name="${name}"]`) as HTMLElement)
const onGrid = (v: number): boolean => Math.abs(v / GRID - Math.round(v / GRID)) < 1e-6
const tool = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('button[aria-label="Section"]') as HTMLButtonElement
const said = (): string => [...document.querySelectorAll('.checkpoints__sr[role="status"]')].map((e) => e.textContent).join("|")
const stored = (w: World): { list: Section[]; members: Record<string, { section: string; x: number; y: number }> } | undefined => {
  const settings = parseSettings(w.store.value)
  return settings.sections?.[INSTANCE] as never
}

// ---- Driving the pointer and keys ------------------------------------------

type PointerInit = { x: number; y: number }
const Pointer = (globalThis as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
function fire(target: EventTarget, type: string, p: PointerInit, init: Record<string, unknown> = {}): void {
  target.dispatchEvent(new Pointer(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, pointerId: 1, ...init } as MouseEventInit))
}
async function drag(target: EventTarget, from: PointerInit, to: PointerInit, { release = true } = {}): Promise<void> {
  await act(async () => {
    fire(target, "pointerdown", from)
    const steps = 6
    for (let i = 1; i <= steps; i += 1) fire(viewport(), "pointermove", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps })
    if (release) fire(viewport(), "pointerup", to)
  })
}
const release = (p: PointerInit): Promise<void> =>
  act(async () => {
    fire(viewport(), "pointerup", p)
  })
const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}): Promise<void> =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }))
  })
const click = (el: Element): Promise<void> =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  })
function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  return act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    set?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/** Draws a section by its world corners with the tool: S, a drag across the canvas. */
async function draw(a: PointerInit, b: PointerInit, { hold = false } = {}): Promise<void> {
  await key(window, "s")
  await drag(viewport(), toScreen(a), toScreen(b), { release: !hold })
}
const nameField = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>(".section__input")
async function nameIt(name: string): Promise<void> {
  const input = nameField() as HTMLInputElement
  await typeInto(input, name)
  await key(input, "Enter")
}

/** A world rectangle round a card, with air. */
function around(...names: string[]): { a: PointerInit; b: PointerInit } {
  const boxes = names.map(cardBox)
  const x0 = Math.min(...boxes.map((b) => b.x)) - 40
  const y0 = Math.min(...boxes.map((b) => b.y)) - 40
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 40
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 150
  return { a: { x: x0, y: y0 }, b: { x: x1, y: y1 } }
}
/** Somewhere clear at the left of the stack, in world units. */
const FREE = { a: { x: -1300, y: -400 }, b: { x: -900, y: -150 } }

// ---------------------------------------------------------------------------

describe("the Section tool", () => {
  it("is a button in the bar with its state and its tip, and S and Esc turn it on and off", async () => {
    await mount()
    expect(tool().getAttribute("aria-pressed")).toBe("false")
    expect(tool().title).toBe("Section (S)")
    expect(viewport().dataset["tool"]).toBe("select")
    await click(tool())
    expect(tool().getAttribute("aria-pressed")).toBe("true")
    expect(viewport().dataset["tool"]).toBe("section")
    await key(window, "Escape")
    expect(tool().getAttribute("aria-pressed")).toBe("false")
    await key(window, "s")
    expect(tool().getAttribute("aria-pressed")).toBe("true")
    await key(window, "S")
    expect(tool().getAttribute("aria-pressed")).toBe("false")
    // Not while typing in the search field.
    const search = document.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }))
    })
    expect(tool().getAttribute("aria-pressed")).toBe("false")
  })

  it("draws a section on the grid, named Section, its tab a field at once, and goes back to select", async () => {
    const w = await mount()
    await draw({ x: FREE.a.x + 5, y: FREE.a.y + 7 }, FREE.b)
    const [s] = sections()
    expect(sections()).toHaveLength(1)
    expect([s?.x, s?.y, s?.w, s?.h].every((v) => onGrid(v ?? 1))).toBe(true)
    expect(s?.x).toBe(-1296)
    expect(s?.w).toBe(408)
    expect(tool().getAttribute("aria-pressed")).toBe("false")
    expect(viewport().dataset["tool"]).toBe("select")
    // The tab is a field with the default name, selected, focused.
    const input = nameField()
    expect(input?.value).toBe("Section")
    expect(document.activeElement).toBe(input)
    expect(said()).toContain("Created section Section")
    expect(stored(w)?.list).toHaveLength(1)
  })

  it("makes nothing from a click, nor from a drag too small to be a section's room", async () => {
    await mount()
    await key(window, "s")
    await drag(viewport(), toScreen({ x: -1300, y: -400 }), toScreen({ x: -1299, y: -399 }))
    expect(sections()).toHaveLength(0)
    expect(tool().getAttribute("aria-pressed")).toBe("true")
  })

  it("shows the grid while drawing, moving and resizing, and not otherwise", async () => {
    await mount()
    const grid = (): string | undefined => document.querySelector<HTMLElement>(".checkpoints__grid")?.dataset["on"]
    expect(grid()).toBe("false")
    await draw(FREE.a, FREE.b, { hold: true })
    expect(grid()).toBe("true")
    expect(document.querySelector(".section-draft")).not.toBeNull()
    await release(toScreen(FREE.b))
    expect(grid()).toBe("false")
    await key(nameField() as HTMLInputElement, "Escape")
    const tab = document.querySelector<HTMLElement>(".section__tab") as HTMLElement
    const s = sections()[0] as Sec
    await drag(tab, toScreen({ x: s.x + 10, y: s.y - 10 }), toScreen({ x: s.x + 60, y: s.y + 40 }), { release: false })
    expect(grid()).toBe("true")
    await release(toScreen({ x: s.x + 60, y: s.y + 40 }))
    expect(grid()).toBe("false")
  })

  it("won't draw over Now or under the timeline", async () => {
    await mount()
    const now = boxOf(document.querySelector<HTMLElement>(".checkpoint--now") as HTMLElement)
    await draw({ x: now.x - 600, y: now.y - 500 }, { x: now.x + 300, y: now.y + 300 })
    const [s] = sections()
    expect(s).toBeDefined()
    const clear = (s?.x ?? 0) + (s?.w ?? 0) + GAP <= now.x || (s?.y ?? 0) + (s?.h ?? 0) + GAP <= now.y || (s?.y ?? 0) >= now.y + now.h + 120 + GAP
    expect(clear).toBe(true)
    // The timeline's strip starts this far from the window's right edge.
    const c = camera()
    const railX = (window.innerWidth - 132 - c.x) / c.zoom
    await nameIt("Left")
    await draw({ x: railX - 500, y: -1500 }, { x: railX + 2000, y: -1250 })
    // Its tab is the field, so it has no name text yet.
    const second = sections().find((x) => x.name === "")
    expect(second).toBeDefined()
    expect((second?.x ?? 0) + (second?.w ?? 0)).toBeLessThanOrEqual(railX)
  })
})

describe("the tab", () => {
  async function made(name = "Section"): Promise<World> {
    const w = await mount()
    await draw(FREE.a, FREE.b)
    if (name !== "Section") await nameIt(name)
    else await key(nameField() as HTMLInputElement, "Escape")
    return w
  }

  it("keeps the default name on Esc, and a typed one on Return", async () => {
    await made()
    expect(sections()[0]?.name).toBe("Section")
    expect(nameField()).toBeNull()
  })

  it("is renamed in place: Return keeps what was typed, said quietly, and written to the settings", async () => {
    const w = await made("Yesterday's runs")
    expect(sections()[0]?.name).toBe("Yesterday's runs")
    expect(nameField()).toBeNull()
    expect(said()).toContain("Renamed section to Yesterday's runs")
    expect(stored(w)?.list[0]?.name).toBe("Yesterday's runs")
    expect(document.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Section: Yesterday's runs, no checkpoints")
  })

  it("is edited by a click on the tab (without a drag), and by Return or F2 on the focused section", async () => {
    await made("One")
    const tab = document.querySelector<HTMLElement>(".section__tab") as HTMLElement
    const s = sections()[0] as Sec
    await act(async () => {
      fire(tab, "pointerdown", toScreen({ x: s.x + 10, y: s.y - 10 }))
      fire(viewport(), "pointerup", toScreen({ x: s.x + 10, y: s.y - 10 }))
    })
    expect(nameField()?.value).toBe("One")
    await key(nameField() as HTMLInputElement, "Escape")
    expect(nameField()).toBeNull()
    const el = s.el
    await key(el, "F2")
    expect(nameField()?.value).toBe("One")
    await key(nameField() as HTMLInputElement, "Escape")
    await key(el, "Enter")
    expect(nameField()?.value).toBe("One")
  })

  it("puts the name back on Esc, keeps the old one when emptied, and takes a typed one when the field is left", async () => {
    await made("Keep")
    const el = sections()[0]?.el as HTMLElement
    await key(el, "F2")
    await typeInto(nameField() as HTMLInputElement, "Nope")
    await key(nameField() as HTMLInputElement, "Escape")
    expect(sections()[0]?.name).toBe("Keep")
    await key(el, "F2")
    await typeInto(nameField() as HTMLInputElement, "   ")
    await key(nameField() as HTMLInputElement, "Enter")
    expect(sections()[0]?.name).toBe("Keep")
    await key(el, "F2")
    await typeInto(nameField() as HTMLInputElement, "Left alone")
    await act(async () => {
      ;(nameField() as HTMLInputElement).dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    })
    expect(sections()[0]?.name).toBe("Left alone")
  })

  it("won't keep a name with control or invisible characters, or over 80: it says why and stays; leaving puts the old one back", async () => {
    await made("Plain")
    const el = sections()[0]?.el as HTMLElement
    await key(el, "F2")
    await typeInto(nameField() as HTMLInputElement, "bell\u0007")
    await key(nameField() as HTMLInputElement, "Enter")
    expect(nameField()).not.toBeNull()
    expect(nameField()?.getAttribute("aria-invalid")).toBe("true")
    expect(document.querySelector(".section__problem")?.textContent).toBe("Use one line of plain text.")
    await typeInto(nameField() as HTMLInputElement, "x".repeat(81))
    await key(nameField() as HTMLInputElement, "Enter")
    expect(document.querySelector(".section__problem")?.textContent).toBe("Keep it to 80 characters or fewer.")
    await typeInto(nameField() as HTMLInputElement, "a​b")
    await key(nameField() as HTMLInputElement, "Enter")
    expect(nameField()).not.toBeNull()
    await act(async () => {
      ;(nameField() as HTMLInputElement).dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    })
    expect(nameField()).toBeNull()
    expect(sections()[0]?.name).toBe("Plain")
  })

  it("numbers a name that is taken", async () => {
    await mount()
    await draw(FREE.a, FREE.b)
    await key(nameField() as HTMLInputElement, "Escape")
    await draw({ x: FREE.a.x, y: FREE.b.y + 100 }, { x: FREE.b.x, y: FREE.b.y + 350 })
    expect(nameField()?.value).toBe("Section 2")
  })

  it("moves with its keys back to the section after a rename, so Delete and the arrows go on working", async () => {
    await made("Focus")
    const el = sections()[0]?.el as HTMLElement
    expect(document.activeElement).toBe(el)
  })
})

describe("what is in a section", () => {
  it("is every loose card whose centre is in it when it is drawn, counted in its name for a screen reader", async () => {
    const w = await mount()
    // Round the cards of both days' tails: b and c are Oct 20's, d is Oct 21's.
    const { a, b } = around("c", "d")
    await draw(a, b)
    await key(nameField() as HTMLInputElement, "Escape")
    const group = document.querySelector('[role="group"]') as HTMLElement
    expect(Object.keys(stored(w)?.members ?? {}).sort()).toEqual(["b", "c", "d"])
    expect(group.getAttribute("aria-label")).toBe("Section: Section, 3 checkpoints")
    // The one not round it is loose.
    expect(stored(w)?.members["a"]).toBeUndefined()
    const s = sections()[0] as Sec
    // Each keeps its place relative to the section.
    const c = cardBox("c")
    expect(stored(w)?.members["c"]).toEqual({ section: s.id, x: c.x - s.x, y: c.y - s.y })
  })

  it("goes with the section when it is carried by its tab, snapped to the grid", async () => {
    const w = await mount()
    const { a, b } = around("c", "d")
    await draw(a, b)
    await key(nameField() as HTMLInputElement, "Escape")
    const before = sections()[0] as Sec
    const cBefore = cardBox("c")
    const dBefore = cardBox("d")
    const tab = document.querySelector<HTMLElement>(".section__tab") as HTMLElement
    await drag(tab, toScreen({ x: before.x + 10, y: before.y - 10 }), toScreen({ x: before.x + 10 - 300.4, y: before.y - 10 - 410.7 }))
    const after = sections()[0] as Sec
    expect(onGrid(after.x) && onGrid(after.y)).toBe(true)
    const dx = after.x - before.x
    const dy = after.y - before.y
    expect(Math.abs(dx + 300)).toBeLessThanOrEqual(GRID / 2)
    expect(Math.abs(dy + 410.7)).toBeLessThanOrEqual(GRID / 2)
    expect(cardBox("c")).toMatchObject({ x: cBefore.x + dx, y: cBefore.y + dy })
    expect(cardBox("d")).toMatchObject({ x: dBefore.x + dx, y: dBefore.y + dy })
    // Who is in it did not change, nor their places in it; only the section's own place did.
    expect(stored(w)?.members["c"]).toEqual({ section: before.id, x: cBefore.x - before.x, y: cBefore.y - before.y })
    expect(stored(w)?.list[0]).toMatchObject({ x: after.x, y: after.y })
  })

  it("is carried by its border, and by its empty body once it is selected, but its body is the canvas's until then", async () => {
    await mount()
    await draw(FREE.a, FREE.b)
    await key(nameField() as HTMLInputElement, "Escape")
    // Deselect, then press its body: nothing of the section takes it.
    await key(window, "Escape")
    const s = sections()[0] as Sec
    expect(s.el.dataset["selected"]).toBe("false")
    const body = s.el.querySelector<HTMLElement>(".section__body") as HTMLElement
    // The stylesheet is what lets a press through (pointer-events); the rule here is that a press on the body of one that isn't selected is not a move.
    await drag(body, toScreen({ x: s.x + 100, y: s.y + 80 }), toScreen({ x: s.x + 200, y: s.y + 80 }))
    expect(sections()[0]?.x).toBe(s.x)
    // By its border it is carried, and so selected.
    const edge = s.el.querySelector<HTMLElement>('.section__edge[data-handle="n"]') as HTMLElement
    await drag(edge, toScreen({ x: s.x + 100, y: s.y }), toScreen({ x: s.x + 220, y: s.y }))
    expect(sections()[0]?.x).toBe(s.x + 120)
    expect(sections()[0]?.el.dataset["selected"]).toBe("true")
    // Selected, its empty body carries it.
    const moved = sections()[0] as Sec
    await drag(body, toScreen({ x: moved.x + 100, y: moved.y + 80 }), toScreen({ x: moved.x + 100, y: moved.y + 176 }))
    expect(sections()[0]?.y).toBe(moved.y + 96)
  })

  it("takes a card dropped in it, by the card's centre, and lets it go when it is dragged out", async () => {
    const w = await mount()
    // A section clear of the stack.
    await draw({ x: -1600, y: -900 }, { x: -1000, y: -400 })
    await key(nameField() as HTMLInputElement, "Escape")
    const s = sections()[0] as Sec
    const d0 = cardBox("d")
    const card = document.querySelector<HTMLElement>('.checkpoint[data-name="d"] .checkpoint__hit') as HTMLElement
    const from = toScreen({ x: d0.x + 20, y: d0.y + 20 })
    const centreTo = { x: s.x + s.w / 2, y: s.y + s.h / 2 }
    const to = toScreen({ x: centreTo.x - d0.w / 2 + 20, y: centreTo.y - d0.h / 2 + 20 })
    await drag(card, from, to)
    expect(stored(w)?.members["d"]?.section).toBe(s.id)
    expect(document.querySelector('[role="group"]')?.getAttribute("aria-label")).toContain("1 checkpoint")
    const inside = cardBox("d")
    expect(inside.x).toBeGreaterThanOrEqual(s.x)
    expect(inside.x + inside.w).toBeLessThanOrEqual(s.x + s.w)
    expect(inside.y + inside.h).toBeLessThanOrEqual(s.y + s.h)
    // Out again.
    const out = toScreen({ x: s.x + s.w + 400, y: s.y + s.h + 400 })
    await drag(card, toScreen({ x: inside.x + 20, y: inside.y + 20 }), out)
    expect(stored(w)?.members["d"]).toBeUndefined()
    expect(parseSettings(w.store.value).layouts[INSTANCE]?.["d"]).toBeDefined()
    expect(document.querySelector('[role="group"]')?.getAttribute("aria-label")).toContain("no checkpoints")
  })

  it("is decided on the drop only: a card dragged across a section but dropped outside is not in it", async () => {
    const w = await mount()
    await draw({ x: -1600, y: -900 }, { x: -1000, y: -400 })
    await key(nameField() as HTMLInputElement, "Escape")
    const s = sections()[0] as Sec
    const d0 = cardBox("d")
    const card = document.querySelector<HTMLElement>('.checkpoint[data-name="d"] .checkpoint__hit') as HTMLElement
    await act(async () => {
      fire(card, "pointerdown", toScreen({ x: d0.x + 20, y: d0.y + 20 }))
      fire(viewport(), "pointermove", toScreen({ x: s.x + s.w / 2, y: s.y + s.h / 2 }))
    })
    // Over it: the section shows that it would take it.
    expect(sections()[0]?.el.dataset["target"]).toBe("true")
    expect(stored(w)?.members["d"]).toBeUndefined()
    await act(async () => {
      fire(viewport(), "pointermove", toScreen({ x: s.x + s.w + 900, y: s.y }))
      fire(viewport(), "pointerup", toScreen({ x: s.x + s.w + 900, y: s.y }))
    })
    expect(stored(w)?.members["d"]).toBeUndefined()
    expect(sections()[0]?.el.dataset["target"]).toBe("false")
  })

  it("leaves Now out: it is not a checkpoint and can't be put in a section", async () => {
    const w = await mount()
    const now = boxOf(document.querySelector<HTMLElement>(".checkpoint--now") as HTMLElement)
    await draw({ x: now.x - 100, y: now.y - 100 }, { x: now.x + now.w + 100, y: now.y + now.h + 300 })
    for (const s of stored(w)?.list ?? []) {
      expect(s.y + s.h + GAP <= now.y || s.x + s.w + GAP <= now.x || s.x >= now.x + now.w + GAP).toBe(true)
    }
    expect(Object.keys(stored(w)?.members ?? {})).not.toContain("now")
  })

  it("keeps the day's date for its cards that are in no section, and drops it when all of them are in", async () => {
    await mount()
    await sleep(520)
    await act(async () => {
      await sleep(20)
    })
    const day = (key: string): Element | null => document.querySelector(`.checkpoints__day[data-day="${key}"]`)
    const any = document.querySelectorAll(".checkpoints__day").length
    expect(any).toBeGreaterThan(0)
    const newest = "2026-10-21"
    expect(day(newest)).not.toBeNull()
    const { a, b } = around("d")
    await draw(a, b)
    await key(nameField() as HTMLInputElement, "Escape")
    expect(day(newest)).toBeNull()
    // The day before has two cards: one in a section leaves the date with the other.
    expect(day("2026-10-20")).not.toBeNull()
  })

  it("dims by a search like any other, whether it is in a section or not", async () => {
    await mount()
    const { a, b } = around("c", "d")
    await draw(a, b)
    await key(nameField() as HTMLInputElement, "Escape")
    const search = document.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement
    await act(async () => {
      search.focus()
    })
    await typeInto(search, "b")
    const dimmed = (n: string): string | undefined => document.querySelector<HTMLElement>(`.checkpoint[data-name="${n}"]`)?.dataset["dimmed"]
    // b matches; c is in the section and a is outside it, and neither does.
    expect(dimmed("b")).toBe("false")
    expect(dimmed("c")).toBe("true")
    expect(dimmed("a")).toBe("true")
  })
})

describe("selecting and resizing", () => {
  async function one(): Promise<{ w: World; s: Sec }> {
    const w = await mount()
    await draw({ x: -1300, y: -900 }, { x: -700, y: -500 })
    await key(nameField() as HTMLInputElement, "Escape")
    return { w, s: sections()[0] as Sec }
  }
  const handle = (h: string): HTMLElement => document.querySelector<HTMLElement>(`[data-handle="${h}"]`) as HTMLElement

  it("shows eight handles when it is selected, and none when it is not", async () => {
    await one()
    expect(document.querySelectorAll(".section__corner")).toHaveLength(4)
    expect(document.querySelectorAll(".section__edge")).toHaveLength(4)
    await key(window, "Escape")
    expect(sections()[0]?.el.dataset["selected"]).toBe("false")
    expect(document.querySelectorAll(".section__corner")).toHaveLength(0)
  })

  it("is selected by its tab, and Esc lets go of it", async () => {
    await one()
    await key(window, "Escape")
    const s = sections()[0] as Sec
    await act(async () => {
      fire(s.el.querySelector(".section__tab") as HTMLElement, "pointerdown", toScreen({ x: s.x + 10, y: s.y - 10 }))
      fire(viewport(), "pointerup", toScreen({ x: s.x + 10, y: s.y - 10 }))
    })
    expect(sections()[0]?.el.dataset["selected"]).toBe("true")
    await key(nameField() as HTMLInputElement, "Escape")
    await key(window, "Escape")
    expect(sections()[0]?.el.dataset["selected"]).toBe("false")
  })

  it("resizes by a corner: the dragged edges snap to the grid and the opposite ones stay", async () => {
    const { s } = await one()
    const right = s.x + s.w
    const bottom = s.y + s.h
    await drag(handle("nw"), toScreen({ x: s.x, y: s.y }), toScreen({ x: s.x - 101, y: s.y - 53 }))
    const r = sections()[0] as Sec
    expect([r.x, r.y, r.w, r.h].every(onGrid)).toBe(true)
    expect(r.x + r.w).toBe(right)
    expect(r.y + r.h).toBe(bottom)
    expect(r.x).toBe(s.x - 96)
    expect(r.y).toBe(s.y - 48)
    await drag(handle("se"), toScreen({ x: right, y: bottom }), toScreen({ x: right + 130, y: bottom + 10 }))
    const r2 = sections()[0] as Sec
    expect(r2.x).toBe(r.x)
    expect(r2.y).toBe(r.y)
    expect(r2.x + r2.w).toBe(right + 120)
    expect(r2.y + r2.h).toBe(bottom)
  })

  it("resizes by an edge, one way only, and never below the least size", async () => {
    const { s } = await one()
    await drag(handle("e"), toScreen({ x: s.x + s.w, y: s.y + 50 }), toScreen({ x: s.x + s.w + 70, y: s.y + 400 }))
    const r = sections()[0] as Sec
    expect([r.x, r.y, r.h]).toEqual([s.x, s.y, s.h])
    expect(r.w).toBe(s.w + 72)
    await drag(handle("w"), toScreen({ x: r.x, y: r.y + 50 }), toScreen({ x: r.x + 5000, y: r.y + 50 }))
    const small = sections()[0] as Sec
    expect(small.w).toBe(5 * GRID)
    expect(small.x + small.w).toBe(r.x + r.w)
  })

  it("holds its cards where they stand when it is resized, and stops at them", async () => {
    const w = await mount()
    const { a, b } = around("d")
    await draw(a, b)
    await key(nameField() as HTMLInputElement, "Escape")
    const s = sections()[0] as Sec
    const d = cardBox("d")
    await drag(handle("nw"), toScreen({ x: s.x, y: s.y }), toScreen({ x: s.x - 200, y: s.y - 150 }))
    expect(cardBox("d")).toMatchObject({ x: d.x, y: d.y })
    expect(stored(w)?.members["d"]?.section).toBe(s.id)
    const grown = sections()[0] as Sec
    // Squeezing from the east, the section stops at its card (with its air) instead of leaving it outside.
    await drag(handle("e"), toScreen({ x: grown.x + grown.w, y: grown.y + 80 }), toScreen({ x: grown.x + 20, y: grown.y + 80 }))
    const squeezed = sections()[0] as Sec
    expect(squeezed.x + squeezed.w).toBeGreaterThanOrEqual(d.x + d.w + 12)
    expect(cardBox("d")).toMatchObject({ x: d.x, y: d.y })
  })

  it("takes in the loose cards it grows over", async () => {
    const w = await mount()
    const c = cardBox("c")
    await draw({ x: c.x - 600, y: c.y - 400 }, { x: c.x - 200, y: c.y - 200 })
    await key(nameField() as HTMLInputElement, "Escape")
    const s = sections()[0] as Sec
    expect(Object.keys(stored(w)?.members ?? {})).toEqual([])
    await drag(handle("se"), toScreen({ x: s.x + s.w, y: s.y + s.h }), toScreen({ x: c.x + c.w, y: c.y + c.h + 200 }))
    expect(stored(w)?.members["c"]?.section).toBe(s.id)
  })
})

describe("never touching", () => {
  async function two(): Promise<{ w: World; a: Sec; b: Sec }> {
    const w = await mount()
    await draw({ x: -1300, y: -900 }, { x: -900, y: -600 })
    await key(nameField() as HTMLInputElement, "Escape")
    await draw({ x: -600, y: -900 }, { x: -300, y: -600 })
    await key(nameField() as HTMLInputElement, "Escape")
    const [a, b] = sections().sort((p, q) => p.x - q.x) as [Sec, Sec]
    return { w, a, b }
  }
  const gapsOk = (list: Section[]): boolean => !intersecting(list.map(sectionBox))

  it("stops a section carried against another one cell away, and slides along it", async () => {
    const { a, b } = await two()
    const tab = b.el.querySelector<HTMLElement>(".section__tab") as HTMLElement
    await drag(tab, toScreen({ x: b.x + 10, y: b.y - 10 }), toScreen({ x: b.x + 10 - 600, y: b.y - 10 + 100 }))
    const [a2, b2] = sections().sort((p, q) => p.x - q.x) as [Sec, Sec]
    expect(a2.id).toBe(a.id)
    expect(b2.x - (a2.x + a2.w)).toBe(GAP)
    expect(b2.y).toBe(b.y + 96)
    expect(gapsOk([a2, b2])).toBe(true)
  })

  it("stops a resize against another section one cell away", async () => {
    const { a, b } = await two()
    await act(async () => {
      fire(a.el.querySelector(".section__tab") as HTMLElement, "pointerdown", toScreen({ x: a.x + 10, y: a.y - 10 }))
      fire(viewport(), "pointerup", toScreen({ x: a.x + 10, y: a.y - 10 }))
    })
    await key(nameField() as HTMLInputElement, "Escape")
    await drag(document.querySelector<HTMLElement>('[data-handle="e"]') as HTMLElement, toScreen({ x: a.x + a.w, y: a.y + 100 }), toScreen({ x: b.x + 200, y: a.y + 100 }))
    const [a2, b2] = sections().sort((p, q) => p.x - q.x) as [Sec, Sec]
    expect(a2.x + a2.w + GAP).toBe(b2.x)
    expect(gapsOk([a2, b2])).toBe(true)
  })

  it("stops a drawn rectangle one cell short of a section", async () => {
    const { b } = await two()
    await draw({ x: b.x + b.w + 400, y: b.y }, { x: b.x - 100, y: b.y + 250 })
    await key(nameField() as HTMLInputElement, "Escape")
    const all = sections().sort((p, q) => p.x - q.x)
    expect(all).toHaveLength(3)
    expect(gapsOk(all)).toBe(true)
    const third = all.at(-1) as Sec
    expect(third.x).toBe(b.x + b.w + GAP)
  })

  it("makes stored sections that touch not touch, when they are read", async () => {
    const w = await mount({
      sections: {
        [INSTANCE]: {
          list: [
            { id: "p", name: "P", x: -1200, y: -900, w: 480, h: 240 },
            { id: "q", name: "Q", x: -1000, y: -880, w: 480, h: 240 },
          ],
          members: {},
        },
      },
    })
    void w
    expect(sections()).toHaveLength(2)
    expect(gapsOk(sections())).toBe(true)
  })
})

describe("removing a section", () => {
  it("takes only the section: Delete leaves its cards exactly where they were, and keeps them", async () => {
    const w = await mount()
    const { a, b } = around("c", "d")
    await draw(a, b)
    await key(nameField() as HTMLInputElement, "Escape")
    const c = cardBox("c")
    const d = cardBox("d")
    const el = sections()[0]?.el as HTMLElement
    await key(el, "Delete")
    expect(sections()).toHaveLength(0)
    expect(document.querySelector('.checkpoint[data-name="c"]')).not.toBeNull()
    expect(cardBox("c")).toMatchObject({ x: c.x, y: c.y })
    expect(cardBox("d")).toMatchObject({ x: d.x, y: d.y })
    expect(stored(w)).toBeUndefined()
    expect(said()).toContain("Removed section")
    // They are loose cards now, remembered where they stand.
    const moves = parseSettings(w.store.value).layouts[INSTANCE]
    for (const name of Object.keys(moves ?? {})) expect(["b", "c", "d"]).toContain(name)
  })

  it("is also a button on the selected section's tab, with a tip that says what it does", async () => {
    await mount()
    await draw(FREE.a, FREE.b)
    await key(nameField() as HTMLInputElement, "Escape")
    const button = document.querySelector<HTMLButtonElement>(".section__remove") as HTMLButtonElement
    expect(button.getAttribute("aria-label")).toBe("Remove section")
    expect(button.title).toContain("checkpoints stay")
    await click(button)
    expect(sections()).toHaveLength(0)
  })

  it("is not confirmed, and Backspace does it too, from the canvas when focus has fallen to it", async () => {
    await mount()
    await draw(FREE.a, FREE.b)
    await key(nameField() as HTMLInputElement, "Escape")
    await key(document.body, "Backspace")
    expect(sections()).toHaveLength(0)
  })
})

describe("the keys", () => {
  async function focused(): Promise<{ w: World; s: Sec }> {
    const w = await mount()
    await draw({ x: -1300, y: -900 }, { x: -900, y: -600 })
    await key(nameField() as HTMLInputElement, "Escape")
    return { w, s: sections()[0] as Sec }
  }

  it("makes a section a labelled group you can Tab to", async () => {
    const { s } = await focused()
    expect(s.el.getAttribute("role")).toBe("group")
    expect(s.el.getAttribute("tabindex")).toBe("0")
    expect(s.el.getAttribute("aria-label")).toBe("Section: Section, no checkpoints")
  })

  it("orders sections in reading order: top to bottom, then left to right", async () => {
    await mount()
    await draw({ x: -600, y: -900 }, { x: -300, y: -600 })
    await key(nameField() as HTMLInputElement, "Escape")
    await draw({ x: -1300, y: -900 }, { x: -900, y: -600 })
    await key(nameField() as HTMLInputElement, "Escape")
    await draw({ x: -1300, y: -400 }, { x: -900, y: -150 })
    await key(nameField() as HTMLInputElement, "Escape")
    const els = [...document.querySelectorAll<HTMLElement>(".section")].map((e) => boxOf(e))
    for (let i = 1; i < els.length; i += 1) {
      const p = els[i - 1] as { x: number; y: number }
      const q = els[i] as { x: number; y: number }
      expect(p.y < q.y || (p.y === q.y && p.x < q.x)).toBe(true)
    }
  })

  it("nudges by one cell with an arrow and four with Shift, snapped", async () => {
    const { w, s } = await focused()
    await key(s.el, "ArrowRight")
    expect(sections()[0]).toMatchObject({ x: s.x + GRID, y: s.y })
    await key(s.el, "ArrowDown", { shiftKey: true })
    expect(sections()[0]).toMatchObject({ x: s.x + GRID, y: s.y + 4 * GRID })
    await key(s.el, "ArrowLeft")
    await key(s.el, "ArrowUp", { shiftKey: true })
    expect(sections()[0]).toMatchObject({ x: s.x, y: s.y })
    expect(said()).toContain("Moved section")
    expect(stored(w)?.list[0]).toMatchObject({ x: s.x, y: s.y })
  })

  it("stops an arrow at a neighbour, a cell away", async () => {
    const w = await mount()
    await draw({ x: -1300, y: -900 }, { x: -900, y: -600 })
    await key(nameField() as HTMLInputElement, "Escape")
    await draw({ x: -840, y: -900 }, { x: -500, y: -600 })
    await key(nameField() as HTMLInputElement, "Escape")
    void w
    const [a, b] = sections().sort((p, q) => p.x - q.x) as [Sec, Sec]
    const gap = b.x - (a.x + a.w)
    expect(gap).toBeGreaterThanOrEqual(GAP)
    for (let i = 0; i < 6; i += 1) await key(a.el, "ArrowRight", { shiftKey: true })
    const [a2, b2] = sections().sort((p, q) => p.x - q.x) as [Sec, Sec]
    expect(b2.x - (a2.x + a2.w)).toBe(GAP)
  })

  it("takes the keys after a press on its border or a carry, whatever the canvas held on to", async () => {
    const { s } = await focused()
    await act(async () => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    const edge = s.el.querySelector<HTMLElement>('.section__edge[data-handle="s"]') as HTMLElement
    await act(async () => {
      fire(edge, "pointerdown", toScreen({ x: s.x + 100, y: s.y + s.h }))
      fire(viewport(), "pointerup", toScreen({ x: s.x + 100, y: s.y + s.h }))
    })
    expect(document.activeElement).toBe(s.el)
    await act(async () => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    // Selected now, so its border resizes.
    await drag(edge, toScreen({ x: s.x + 100, y: s.y + s.h }), toScreen({ x: s.x + 100, y: s.y + s.h + 48 }))
    expect(sections()[0]?.h).toBe(s.h + 48)
    expect(document.activeElement).toBe(sections()[0]?.el ?? null)
  })

  it("leaves the arrows to the name field while it is edited", async () => {
    const { s } = await focused()
    await key(s.el, "F2")
    const input = nameField() as HTMLInputElement
    await key(input, "ArrowRight")
    expect(sections()[0]).toMatchObject({ x: s.x })
  })

  it("says what it did, quietly, in a live region", async () => {
    await focused()
    const live = document.querySelector('.checkpoints__sr[role="status"][aria-live="polite"]')
    expect(live).not.toBeNull()
    expect(live?.textContent).toContain("Created section")
  })
})

describe("kept", () => {
  const filled = {
    sections: {
      [INSTANCE]: {
        list: [
          { id: "s1", name: "Runs", x: -1200, y: -912, w: 480, h: 432 },
          { id: "s2", name: "Notes", x: -600, y: -912, w: 240, h: 192 },
        ],
        members: { c: { section: "s1", x: 24, y: 24 }, d: { section: "s1", x: 200, y: 24 }, gone: { section: "s1", x: 0, y: 0 }, b: { section: "nope", x: 0, y: 0 } },
      },
    },
  }

  it("comes back as it was: sections, names, who is in them, and where", async () => {
    await mount(filled)
    const all = sections()
    expect(all.map((s) => s.name).sort()).toEqual(["Notes", "Runs"])
    const runs = all.find((s) => s.id === "s1") as Sec
    expect(runs).toMatchObject({ x: -1200, y: -912, w: 480, h: 432 })
    // A member's place is the section's top left plus its offset; a deleted checkpoint is dropped, a section may be empty.
    expect(cardBox("c")).toMatchObject({ x: -1176, y: -888 })
    expect(cardBox("d")).toMatchObject({ x: -1000, y: -888 })
    expect(runs.el.getAttribute("aria-label")).toBe("Section: Runs, 2 checkpoints")
    expect(all.find((s) => s.id === "s2")?.el.getAttribute("aria-label")).toBe("Section: Notes, no checkpoints")
  })

  it("is written again, whole and sound, with the next change, and a later mount reads the same", async () => {
    const w = await mount(filled)
    const runs = sections().find((s) => s.id === "s1") as Sec
    await key(runs.el, "ArrowDown")
    const after = stored(w)
    expect(after?.list.find((s) => s.id === "s1")).toMatchObject({ y: -888 })
    // The dropped checkpoint is not written back.
    expect(Object.keys(after?.members ?? {}).sort()).toEqual(["c", "d"])
    const kept = w.store.value
    w.unmount()
    mounted = null
    document.body.replaceChildren()
    const again = await mount(kept)
    expect(sections().find((s) => s.id === "s1")).toMatchObject({ y: -888 })
    expect(stored(again)?.list).toHaveLength(2)
  })

  it("keeps sections when the layout is reset, and puts only the loose cards back", async () => {
    const w = await mount({ ...filled, layouts: { [INSTANCE]: { a: { x: 50, y: 60 } } } })
    const reset = document.querySelector<HTMLButtonElement>('button[aria-label="Reset layout"]') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    await click(reset)
    expect(sections()).toHaveLength(2)
    expect(parseSettings(w.store.value).layouts[INSTANCE]).toBeUndefined()
    expect(stored(w)?.members["c"]).toEqual({ section: "s1", x: 24, y: 24 })
    expect(cardBox("c")).toMatchObject({ x: -1176, y: -888 })
  })
})
