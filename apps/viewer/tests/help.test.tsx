/**
 * The overview's list of things to do, and the help popover each row opens:
 * where the popover goes, how it opens and closes, where focus is, what the
 * keys do, and that every topic has its words and its pictures. Rendered in
 * happy-dom, which computes no layout; the pictures themselves are looked at
 * with scripts/render-help.mjs.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { placeNear } = await import("../ui/src/components/HelpPopover")
const { Abilities } = await import("../ui/src/features/help/Abilities")
const { blockedBy } = await import("../ui/src/features/help/availability")
const { IMAGES } = await import("../ui/src/features/help/images")
const { TOPICS, pictureKey, topicKeys } = await import("../ui/src/features/help/topics")
const { Overview } = await import("../ui/src/features/overview/Overview")
const en = (await import("../ui/src/i18n/en.json")).default as Record<string, string>
const text = (k: string): string => en[k] ?? `(missing ${k})`

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

function render(node: JSX.Element): HTMLElement {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
  return host
}

const rows = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".ability")]
const popover = (): HTMLElement | null => document.querySelector<HTMLElement>(".help")
const title = (): string => popover()?.querySelector(".help__title")?.textContent ?? ""
const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }))
  })
}
const press = (target: EventTarget): void => {
  act(() => {
    target.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  })
}

describe("where the popover goes", () => {
  const view = { width: 1280, height: 820 }
  const panel = { width: 512, height: 600 }
  const row = { left: 100, top: 400, width: 512, height: 60 }

  it("sits to the right of its row, centred on it, so the row stays in view", () => {
    const p = placeNear(row, panel, view, 12, 12)
    expect(p.side).toBe("right")
    expect(p.left).toBe(row.left + row.width + 12)
    expect(p.top).toBe(row.top + row.height / 2 - panel.height / 2)
  })

  it("is moved back inside the window when centring would push it out", () => {
    const high = placeNear({ ...row, top: 0 }, panel, view, 12, 12)
    expect(high.top).toBe(12)
    const low = placeNear({ ...row, top: 800 }, panel, view, 12, 12)
    expect(low.top).toBe(view.height - 12 - panel.height)
  })

  it("goes to the left when the right has no room, and below or above when neither side does", () => {
    const far = { left: 700, top: 400, width: 512, height: 60 }
    expect(placeNear(far, panel, view, 12, 12).side).toBe("left")
    const narrow = { width: 700, height: 900 }
    const wide = { left: 20, top: 100, width: 660, height: 40 }
    const below = placeNear(wide, { width: 600, height: 300 }, narrow, 12, 12)
    expect(below.side).toBe("below")
    expect(below.top).toBe(100 + 40 + 12)
    const above = placeNear({ ...wide, top: 700 }, { width: 600, height: 300 }, narrow, 12, 12)
    expect(above.side).toBe("above")
    expect(above.top).toBe(700 - 12 - 300)
  })

  it("covers the middle of a window with no room anywhere, as tall as the window allows", () => {
    const small = { width: 600, height: 400 }
    const p = placeNear({ left: 20, top: 150, width: 560, height: 50 }, panel, small, 12, 12)
    expect(p.side).toBe("over")
    expect(p.top).toBe(12)
    expect(p.maxHeight).toBe(400 - 24)
    expect(p.left).toBeGreaterThanOrEqual(12)
  })

  it("scrolls a panel taller than the window, beside its row, rather than moving off it", () => {
    const tall = placeNear(row, { width: 512, height: 900 }, view, 12, 12)
    expect(tall.side).toBe("right")
    expect(tall.top).toBe(12)
    expect(tall.maxHeight).toBe(view.height - 24)
  })
})

describe("the topics", () => {
  it("are the five things to do, in the order the overview lists them", () => {
    expect(TOPICS.map((x) => x.id)).toEqual(["exec", "files", "save", "restore", "agent"])
  })

  it("name the thing to do plainly", () => {
    expect(text("ability.exec")).toBe("Open a Windows terminal")
    expect(text("ability.files")).toBe("Copy files between your Mac and Windows")
    expect(text("ability.save")).toBe("Save a checkpoint")
    expect(text("ability.restore")).toBe("Go back to a checkpoint")
    expect(text("ability.agent")).toBe("Use winvm from Claude Code and Claude Desktop")
  })

  it("title the list in a few plain words", () => {
    expect(text("abilities.title")).toBe("What you can do")
    expect(text("abilities.title").split(" ").length).toBeLessThanOrEqual(5)
    expect(text("abilities.title")).not.toMatch(/[:.]$/)
  })

  it("have every sentence they read, and a picture in light and dark for every figure", () => {
    for (const topic of TOPICS) {
      expect(topicKeys(topic).filter((k) => en[k] === undefined)).toEqual([])
      for (const figure of topic.figures) {
        const image = IMAGES[pictureKey(topic.id, figure)]
        expect(image).toBeDefined()
        expect(image?.light).not.toBe(image?.dark)
        expect(image?.width).toBeGreaterThan(0)
        expect(image?.height).toBeGreaterThan(0)
      }
    }
  })
})

describe("the list", () => {
  it("is one button per topic, each saying it opens a dialog, none open yet", () => {
    render(<Abilities />)
    expect(rows().map((r) => r.textContent)).toEqual(TOPICS.map((x) => text(`ability.${x.id}`)))
    for (const r of rows()) {
      expect(r.getAttribute("aria-haspopup")).toBe("dialog")
      expect(r.getAttribute("aria-expanded")).toBe("false")
    }
    expect(popover()).toBeNull()
    expect(document.getElementById("abilities-title")?.textContent).toBe(text("abilities.title"))
  })

  it("keeps each row's icon in a column of its own, apart from the label", () => {
    render(<Abilities />)
    for (const r of rows()) {
      expect(r.children).toHaveLength(3)
      expect(r.children[0]?.className).toBe("ability__icon")
      expect(r.children[1]?.className).toBe("ability__label")
    }
  })

  it("moves between rows with the arrow keys, Home and End", () => {
    render(<Abilities />)
    const all = rows()
    const first = all[0] as HTMLButtonElement
    const second = all[1] as HTMLButtonElement
    const last = all[4] as HTMLButtonElement
    act(() => first.focus())
    key(first as HTMLElement, "ArrowDown")
    expect(document.activeElement).toBe(second)
    key(second as HTMLElement, "ArrowUp")
    expect(document.activeElement).toBe(first)
    key(first as HTMLElement, "End")
    expect(document.activeElement).toBe(last)
    key(last as HTMLElement, "ArrowDown")
    expect(document.activeElement).toBe(last)
    key(last as HTMLElement, "Home")
    expect(document.activeElement).toBe(first)
  })

  it("is part of the overview of a machine that is off", () => {
    render(<Overview phase="stopped" status={null} steps={null} canStart onStart={() => undefined} />)
    expect(rows()).toHaveLength(TOPICS.length)
  })
})

describe("what the machine's state allows", () => {
  type Id = (typeof TOPICS)[number]["id"]
  const unavailable = (phase: Parameters<typeof blockedBy>[1]): Id[] => TOPICS.filter((x) => blockedBy(x.id, phase) !== null).map((x) => x.id)

  it("leaves all five open while Windows runs, and while the state is not known yet", () => {
    expect(unavailable("running")).toEqual([])
    expect(unavailable(null)).toEqual([])
    expect(unavailable(undefined)).toEqual([])
  })

  it("keeps only going back to a checkpoint open while Windows is off or put away", () => {
    for (const phase of ["stopped", "stowed"] as const) {
      expect(unavailable(phase)).toEqual(["exec", "files", "save", "agent"])
      for (const id of ["exec", "files", "save", "agent"] as const) expect(blockedBy(id, phase)).toBe("abilities.why.start")
    }
  })

  it("keeps saving open while Windows is paused, as the Checkpoints view does, and asks to resume for the rest", () => {
    expect(unavailable("paused")).toEqual(["exec", "files", "agent"])
    expect(unavailable("asleep")).toEqual(["exec", "files", "save", "agent"])
    expect(blockedBy("exec", "paused")).toBe("abilities.why.resume")
    expect(blockedBy("exec", "starting")).toBe("abilities.why.starting")
  })

  it("has nothing to offer before Windows is set up", () => {
    expect(unavailable("missing")).toEqual(TOPICS.map((x) => x.id))
    expect(blockedBy("restore", "missing")).toBe("abilities.why.setUp")
  })

  it("has a sentence for every reason", () => {
    for (const k of ["start", "setUp", "starting", "resume"]) expect(en[`abilities.why.${k}`]).toBeDefined()
  })

  it("marks the rows it can't do aria-disabled, with the reason under the label, and leaves the others plain", () => {
    render(<Abilities phase="stowed" />)
    const all = rows()
    expect(all.map((r) => r.getAttribute("aria-disabled"))).toEqual(["true", "true", "true", null, "true"])
    expect(all[0]?.querySelector(".ability__why")?.textContent).toBe(text("abilities.why.start"))
    expect(all[3]?.querySelector(".ability__why")).toBeNull()
    expect(all[3]?.className).not.toContain("ability--off")
    expect(all[0]?.className).toContain("ability--off")
    // Not `disabled`: it stays in the Tab order and can be pressed for its help.
    expect(all[0]?.hasAttribute("disabled")).toBe(false)
  })

  it("marks nothing while Windows runs", () => {
    render(<Abilities phase="running" />)
    for (const r of rows()) {
      expect(r.hasAttribute("aria-disabled")).toBe(false)
      expect(r.querySelector(".ability__why")).toBeNull()
    }
  })

  it("still opens the help of a row that is not available, and says why at the top of it", () => {
    render(<Abilities phase="stopped" />)
    const r = rows()[4] as HTMLButtonElement
    act(() => r.click())
    expect(title()).toBe(text("ability.agent"))
    expect(r.getAttribute("aria-expanded")).toBe("true")
    const p = popover() as HTMLElement
    expect(p.querySelector(".help__unavailable")?.textContent).toBe(`Not available right now. ${text("abilities.why.start")}.`)
    expect(p.querySelector(".help__lead")?.textContent).toBe(text("help.agent.lead"))
    expect(p.querySelectorAll(".help__steps li")).toHaveLength(3)
  })

  it("says nothing of the sort in the help of a row that is available", () => {
    render(<Abilities phase="stopped" />)
    act(() => (rows()[3] as HTMLButtonElement).click())
    expect(popover()?.querySelector(".help__unavailable")).toBeNull()
  })

  it("still moves between unavailable rows with the arrow keys", () => {
    render(<Abilities phase="stowed" />)
    const all = rows()
    act(() => (all[0] as HTMLButtonElement).focus())
    key(all[0] as HTMLElement, "ArrowDown")
    expect(document.activeElement).toBe(all[1] as HTMLElement)
  })

  it("reaches the list from the overview of a suspended machine, with its reasons", () => {
    render(<Overview phase="stowed" status={null} steps={null} canStart onStart={() => undefined} />)
    expect(rows().filter((r) => r.getAttribute("aria-disabled") === "true")).toHaveLength(4)
  })
})

describe("a topic's popover", () => {
  const open = (i: number): HTMLButtonElement => {
    const r = rows()[i] as HTMLButtonElement
    act(() => r.click())
    return r
  }

  it("opens on a click: titled for the row, the row marked expanded, focus inside", () => {
    render(<Abilities />)
    const r = open(0)
    const p = popover()
    expect(p).not.toBeNull()
    expect(p?.getAttribute("role")).toBe("dialog")
    expect(title()).toBe(text("ability.exec"))
    expect(p?.getAttribute("aria-labelledby")).toBe(p?.querySelector(".help__title")?.id ?? "x")
    expect(r.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(p)
  })

  it("is drawn into the body, outside whatever holds the list", () => {
    const host = render(<Abilities />)
    open(1)
    expect(host.querySelector(".help")).toBeNull()
    expect(popover()?.parentElement).toBe(document.body)
  })

  it("says what to do: a sentence, numbered steps, one thing worth knowing, and a picture", () => {
    render(<Abilities />)
    open(2)
    const p = popover() as HTMLElement
    expect(p.querySelector(".help__lead")?.textContent).toBe(text("help.save.lead"))
    expect([...p.querySelectorAll(".help__steps li")].map((li) => li.textContent)).toEqual([text("help.save.step1"), text("help.save.step2"), text("help.save.step3")])
    expect(p.querySelector(".help__note-title")?.textContent).toBe(text("help.save.note.title"))
    const img = p.querySelector("img")
    expect(img?.getAttribute("alt")).toBe(text("help.save.fig.new.alt"))
  })

  it("gives the picture in dark for a dark OS and in light otherwise", () => {
    render(<Abilities />)
    open(0)
    const image = IMAGES[pictureKey("exec", "terminal")]
    const dark = popover()?.querySelector("source")
    expect(dark?.getAttribute("media")).toBe("(prefers-color-scheme: dark)")
    expect(dark?.getAttribute("srcset")).toBe(image?.dark)
    expect(popover()?.querySelector("img")?.getAttribute("src")).toBe(image?.light)
  })

  it("lets a topic with two pictures switch between them", () => {
    render(<Abilities />)
    open(3)
    const buttons = [...(popover()?.querySelectorAll<HTMLButtonElement>(".help__view") ?? [])]
    expect(buttons.map((b) => b.textContent)).toEqual([text("help.restore.fig.browse.label"), text("help.restore.fig.goBack.label")])
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"])
    const browse = IMAGES[pictureKey("restore", "browse")]
    expect(popover()?.querySelector("img")?.getAttribute("src")).toBe(browse?.light)
    act(() => buttons[1]?.click())
    const goBack = IMAGES[pictureKey("restore", "goBack")]
    expect(popover()?.querySelector("img")?.getAttribute("src")).toBe(goBack?.light)
    expect(popover()?.querySelector("img")?.getAttribute("alt")).toBe(text("help.restore.fig.goBack.alt"))
    expect([...popover()?.querySelectorAll(".help__view") ?? []].map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"])
  })

  it("shows no switch for a topic with one picture", () => {
    render(<Abilities />)
    open(4)
    expect(popover()?.querySelector(".help__views")).toBeNull()
  })

  it("closes on a second click on its row, and on its Close button", () => {
    render(<Abilities />)
    open(0)
    open(0)
    expect(popover()).toBeNull()
    open(0)
    act(() => popover()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click())
    expect(popover()).toBeNull()
  })

  it("closes on Escape, and focus goes back to the row", () => {
    render(<Abilities />)
    const r = open(1)
    key(document.activeElement as HTMLElement, "Escape")
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(r)
    expect(r.getAttribute("aria-expanded")).toBe("false")
  })

  it("closes on a press outside it, but not on one inside it", () => {
    render(<Abilities />)
    open(0)
    press(popover()?.querySelector(".help__title") as Element)
    expect(popover()).not.toBeNull()
    press(document.body)
    expect(popover()).toBeNull()
  })

  it("switches topic, rather than closing, when another row is pressed", () => {
    render(<Abilities />)
    open(0)
    press(rows()[1] as Element)
    expect(popover()).not.toBeNull()
    act(() => rows()[1]?.click())
    expect(title()).toBe(text("ability.files"))
    expect(rows()[0]?.getAttribute("aria-expanded")).toBe("false")
    expect(rows()[1]?.getAttribute("aria-expanded")).toBe("true")
  })

  it("steps to the next and previous topic with its buttons and the left and right arrows, round the ends", () => {
    render(<Abilities />)
    open(0)
    const position = (): string => popover()?.querySelector(".help__position")?.textContent ?? ""
    expect(position()).toBe("1 of 5")
    act(() => popover()?.querySelector<HTMLButtonElement>('button[aria-label="Next topic"]')?.click())
    expect(title()).toBe(text("ability.files"))
    expect(position()).toBe("2 of 5")
    key(popover() as HTMLElement, "ArrowRight")
    expect(title()).toBe(text("ability.save"))
    key(popover() as HTMLElement, "ArrowLeft")
    key(popover() as HTMLElement, "ArrowLeft")
    expect(title()).toBe(text("ability.exec"))
    key(popover() as HTMLElement, "ArrowLeft")
    expect(title()).toBe(text("ability.agent"))
    expect(position()).toBe("5 of 5")
    key(popover() as HTMLElement, "ArrowRight")
    expect(title()).toBe(text("ability.exec"))
  })

  it("leaves the arrow keys alone when focus is outside it", () => {
    render(<Abilities />)
    open(0)
    act(() => rows()[0]?.focus())
    key(rows()[0] as HTMLElement, "ArrowRight")
    expect(title()).toBe(text("ability.exec"))
  })

  it("keeps Tab and Shift-Tab inside it", () => {
    render(<Abilities />)
    open(2)
    const p = popover() as HTMLElement
    const items = [...p.querySelectorAll<HTMLElement>("button")]
    const first = items[0] as HTMLElement
    const last = items[items.length - 1] as HTMLElement
    act(() => last.focus())
    key(last, "Tab")
    expect(document.activeElement).toBe(first)
    act(() => first.focus())
    key(first, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)
    // From the panel itself, where focus starts, Shift-Tab also goes to the end.
    act(() => p.focus())
    key(p, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it("stays where it is when focus has moved on before it closes", () => {
    render(<Abilities />)
    open(0)
    const outside = document.createElement("button")
    document.body.append(outside)
    act(() => outside.focus())
    key(window, "Escape")
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(outside)
  })
})
