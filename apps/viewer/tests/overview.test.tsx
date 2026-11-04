/**
 * A suspended machine's screen: its note (loading, autosave, Escape and blur,
 * leaving, switching machines), the layout that lets the note grow upward with
 * the controls held still (as far as a DOM with no layout can show: the
 * structure and the stylesheet's rules; scripts/render-overview.mjs measures
 * the rest in WebKit), and the backdrop (its picture, its fallback, and
 * contrast over the worst picture there could be). Rendered in happy-dom with
 * the app's Tauri bridge faked.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Overview } = await import("../ui/src/features/overview/Overview")
const { MachineNotes } = await import("../ui/src/features/overview/MachineNotes")
const { Backdrop } = await import("../ui/src/features/overview/Backdrop")
const { createNoteSaver, parseMachineNote, SAVE_DELAY_MS } = await import("../ui/src/features/overview/machineNote")
const { pickPicture } = await import("../ui/src/features/overview/backdropPicture")
const en = (await import("../ui/src/i18n/en.json")).default as Record<string, string>
const word = (key: string): string => en[key] ?? ""

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  delete (window as { __TAURI__?: unknown }).__TAURI__
  jest.useRealTimers()
})
afterAll(() => GlobalRegistrator.unregister())

function render(node: JSX.Element): HTMLElement {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
  return host
}
const rerender = (node: JSX.Element): void => act(() => root?.render(node))

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

// ---- A fake app -----------------------------------------------------------------

interface Fake {
  /** Each machine's note, as `winvm note` keeps it. */
  readonly notes: Map<string, string>
  /** Every `winvm note --text=` that was run, in order. */
  readonly writes: { instance: string; text: string }[]
  saves: unknown[]
  failWrites: boolean
}

function install(init: Partial<Fake> = {}): Fake {
  const fake: Fake = { notes: new Map(), writes: [], saves: [], failWrites: false, ...init }
  const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (cmd === "checkpoint_image") return new Uint8Array([137, 80, 78, 71]).buffer
    if (cmd !== "winvm") throw new Error(`unexpected ${cmd}`)
    const [verb, ...rest] = args["args"] as string[]
    const instance = rest[rest.indexOf("-i") + 1] ?? ""
    const ok = (stdout: unknown): unknown => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "" })
    if (verb === "note") {
      const set = rest.find((a) => a.startsWith("--text="))
      if (set === undefined) {
        const text = fake.notes.get(instance)
        return ok(text === undefined ? null : { text, updatedAt: "2026-11-03T09:00:00.000Z" })
      }
      if (fake.failWrites) return { code: 2, stdout: "", stderr: "disk full" }
      const text = set.slice("--text=".length)
      fake.writes.push({ instance, text })
      if (text.trim() === "") fake.notes.delete(instance)
      else fake.notes.set(instance, text)
      return ok(null)
    }
    if (verb === "saves") return ok(fake.saves)
    throw new Error(`unexpected winvm ${String(verb)}`)
  }
  Object.assign(window, { __TAURI__: { core: { invoke } } })
  return fake
}

const field = (): HTMLTextAreaElement => {
  const el = document.querySelector<HTMLTextAreaElement>(".notes__field")
  if (el === null) throw new Error("no note field")
  return el
}

function type(el: HTMLTextAreaElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  act(() => {
    set?.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const save = (name: string, kind: string, createdAt: string, picture: boolean) => ({
  name,
  kind,
  createdAt,
  bytes: 1,
  compatible: true,
  title: null,
  notes: null,
  incompatible: [],
  screenshot: picture ? `/h/saves/dev/${name}/screen.png` : null,
  thumbnail: picture ? `/h/saves/dev/${name}/thumb.png` : null,
})

const stowedOverview = (instance: string): JSX.Element => (
  <Overview instance={instance} phase="stowed" status={null} steps={null} canStart onStart={() => undefined} />
)

// ---- The note's store and saver -------------------------------------------------

describe("the note's store", () => {
  it("reads what `winvm note --json` printed: the text, empty for none, null when it is not that", () => {
    expect(parseMachineNote('{"text":"hello","updatedAt":"2026-11-03T09:00:00.000Z"}')).toBe("hello")
    expect(parseMachineNote("null")).toBe("")
    expect(parseMachineNote("not json")).toBeNull()
    expect(parseMachineNote('{"text":5}')).toBeNull()
  })

  it("saves after a pause in typing, once, with the last text", async () => {
    jest.useFakeTimers()
    const wrote: string[] = []
    const saver = createNoteSaver(
      async (t) => {
        wrote.push(t)
        return true
      },
      () => undefined,
    )
    saver.change("a")
    jest.advanceTimersByTime(SAVE_DELAY_MS - 1)
    saver.change("ab")
    jest.advanceTimersByTime(SAVE_DELAY_MS - 1)
    expect(wrote).toEqual([])
    jest.advanceTimersByTime(1)
    await saver.flush()
    expect(wrote).toEqual(["ab"])
  })

  it("flushes at once, and never writes an older text after a newer one", async () => {
    const order: string[] = []
    const gates: (() => void)[] = []
    const saver = createNoteSaver(
      (t) =>
        new Promise<boolean>((done) => {
          gates.push(() => {
            order.push(t)
            done(true)
          })
        }),
      () => undefined,
    )
    saver.change("one")
    const first = saver.flush()
    saver.change("two")
    const second = saver.flush()
    await Promise.resolve()
    expect(gates.length).toBe(1)
    gates[0]?.()
    await first
    await Promise.resolve()
    gates[1]?.()
    await second
    expect(order).toEqual(["one", "two"])
  })

  it("keeps a failed text for the next try, and says so", async () => {
    const results: boolean[] = []
    let ok = false
    const wrote: string[] = []
    const saver = createNoteSaver(
      async (t) => {
        wrote.push(t)
        return ok
      },
      (r) => results.push(r),
    )
    saver.change("draft")
    await saver.flush()
    ok = true
    await saver.flush()
    expect(wrote).toEqual(["draft", "draft"])
    expect(results).toEqual([false, true])
  })
})

// ---- The note, in the window ------------------------------------------------------

describe("the note", () => {
  it("is empty with a quiet placeholder, and a label for screen readers", async () => {
    install()
    render(<MachineNotes instance="dev" title="Windows is suspended" />)
    await flush()
    expect(field().value).toBe("")
    expect(field().placeholder).toBe(word("overview.notes.placeholder"))
    expect(field().getAttribute("aria-label")).toBe(word("overview.notes.label"))
    expect(document.querySelector("h1")?.textContent).toBe("Windows is suspended")
  })

  it("shows what the machine's note already says, and is read-only until it has", async () => {
    install({ notes: new Map([["dev", "Licence key is in the drawer."]]) })
    render(<MachineNotes instance="dev" title="t" />)
    expect(field().readOnly).toBe(true)
    await flush()
    expect(field().readOnly).toBe(false)
    expect(field().value).toBe("Licence key is in the drawer.")
  })

  it("saves when the field is left, with the whole text and no Save button", async () => {
    const fake = install()
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    type(field(), "Check the display size")
    expect(fake.writes).toEqual([])
    act(() => field().focus())
    act(() => field().blur())
    await flush()
    expect(fake.writes).toEqual([{ instance: "dev", text: "Check the display size" }])
    expect(document.querySelector("button")).toBeNull()
  })

  it("saves on a pause in typing", async () => {
    const fake = install()
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    jest.useFakeTimers()
    type(field(), "first")
    type(field(), "first and second")
    jest.advanceTimersByTime(SAVE_DELAY_MS + 1)
    jest.useRealTimers()
    await flush()
    expect(fake.writes).toEqual([{ instance: "dev", text: "first and second" }])
  })

  it("commits on Escape and leaves the field, and keeps Escape to itself", async () => {
    const fake = install()
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    act(() => field().focus())
    type(field(), "done for now")
    let reachedWindow = false
    const onWindow = (): void => {
      reachedWindow = true
    }
    window.addEventListener("keydown", onWindow)
    act(() => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    })
    window.removeEventListener("keydown", onWindow)
    await flush()
    expect(fake.writes).toEqual([{ instance: "dev", text: "done for now" }])
    expect(document.activeElement).not.toBe(field())
    expect(reachedWindow).toBe(false)
  })

  it("does not take any other key from the app", async () => {
    install()
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    const seen: string[] = []
    const onWindow = (e: Event): void => void seen.push((e as KeyboardEvent).key)
    window.addEventListener("keydown", onWindow)
    for (const key of ["a", "Enter", "Tab", "ArrowUp", "t"]) {
      act(() => {
        field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, metaKey: key === "t", shiftKey: key === "t" }))
      })
    }
    window.removeEventListener("keydown", onWindow)
    expect(seen).toEqual(["a", "Enter", "Tab", "ArrowUp", "t"])
  })

  it("is saved when the screen goes away (the machine starts), without a blur", async () => {
    const fake = install()
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    type(field(), "written just before Start")
    act(() => root?.unmount())
    root = null
    await flush()
    expect(fake.writes).toEqual([{ instance: "dev", text: "written just before Start" }])
    expect(fake.notes.get("dev")).toBe("written just before Start")
  })

  it("persists per machine: switching saves the old one's text to it, and shows the new one's", async () => {
    const fake = install({ notes: new Map([["other", "The other machine's note"]]) })
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    type(field(), "dev's note")
    rerender(<MachineNotes instance="other" title="t" />)
    await flush()
    expect(fake.writes).toEqual([{ instance: "dev", text: "dev's note" }])
    expect(field().value).toBe("The other machine's note")
    rerender(<MachineNotes instance="dev" title="t" />)
    await flush()
    expect(field().value).toBe("dev's note")
  })

  it("clearing it removes the note", async () => {
    const fake = install({ notes: new Map([["dev", "old"]]) })
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    type(field(), "")
    act(() => field().focus())
    act(() => field().blur())
    await flush()
    expect(fake.notes.has("dev")).toBe(false)
  })

  it("says when it could not save, and tries again at the next chance", async () => {
    const fake = install({ failWrites: true })
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    type(field(), "keep this")
    act(() => field().focus())
    act(() => field().blur())
    await flush()
    expect(document.querySelector('[role="status"]')?.textContent).toBe(word("overview.notes.failed"))
    expect(field().getAttribute("aria-invalid")).toBe("true")
    fake.failWrites = false
    act(() => field().focus())
    act(() => field().blur())
    await flush()
    expect(fake.notes.get("dev")).toBe("keep this")
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it("mirrors its text on the wrapper, which is what gives the area the height of its text", async () => {
    install()
    render(<MachineNotes instance="dev" title="t" />)
    await flush()
    type(field(), "one\ntwo\nthree")
    expect(document.querySelector(".notes")?.getAttribute("data-value")).toBe("one\ntwo\nthree")
  })
})

// ---- The layout: what can be known without a layout engine -----------------------

const CSS = readFileSync(resolve(import.meta.dir, "../ui/src/styles/styles.css"), "utf8")
/** The declarations of every rule that names `selector` (among others, perhaps), joined. */
const rule = (selector: string): string => {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, "")
  const found: string[] = []
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((m[1] ?? "").split(",").some((s) => s.trim() === selector)) found.push(m[2] ?? "")
  }
  if (found.length === 0) throw new Error(`no rule for ${selector}`)
  return found.join("\n")
}

describe("the layout that lets the note grow upward", () => {
  it("puts the heading and the note in one block above the controls, and the controls after it", async () => {
    install()
    const host = render(stowedOverview("dev"))
    await flush()
    const content = host.querySelector(".overview__content")
    const kids = [...(content?.children ?? [])].map((c) => c.className)
    expect(kids[0]).toBe("overview__upper")
    expect(kids.slice(1)).toEqual(["facts", "actions", "abilities"].filter((k) => host.querySelector(`.${k}`) !== null))
    const upper = host.querySelector(".overview__upper")
    expect([...(upper?.children ?? [])].map((c) => c.tagName + "." + c.className)).toEqual(["H1.overview__title", "DIV.notes"])
  })

  it("makes that block the only part that takes up the slack, aligned to its bottom", () => {
    const upper = rule(".overview__upper")
    expect(upper).toMatch(/flex:\s*1 1 0/)
    expect(upper).toMatch(/justify-content:\s*flex-end/)
    expect(upper).toMatch(/min-height:/)
    expect(rule(".overview__upper > .overview__title")).toMatch(/flex:\s*none/)
    // The note itself shrinks (and then scrolls) rather than pushing anything down.
    expect(rule(".notes")).toMatch(/flex:\s*0 1 auto/)
    expect(rule(".notes")).toMatch(/min-height:\s*var\(--notes-min\)/)
    expect(rule(".notes__field")).toMatch(/overflow-y:\s*auto/)
    // Nothing is centered by auto margins any more, which is what would have moved the controls.
    expect(rule(".overview--notes .overview__content")).toMatch(/margin-block:\s*0/)
    expect(rule(".overview--notes .overview__content")).toMatch(/overflow-y:\s*auto/)
  })

  it("leaves the top of the column (the heading's stop) as clearance below the toolbar", () => {
    expect(rule(".overview--notes .overview__content")).toMatch(/padding:\s*var\(--space-6\)/)
  })
})

// ---- The backdrop -------------------------------------------------------------------

describe("the backdrop", () => {
  it("picks the picture from when the machine was put away, else the newest", () => {
    const list = [
      save("a", "manual", "2026-11-01T10:00:00.000Z", true),
      save("old-stow", "stow", "2026-10-01T10:00:00.000Z", true),
      save("stow", "stow", "2026-10-20T10:00:00.000Z", true),
      save("b", "manual", "2026-11-02T10:00:00.000Z", true),
      save("stow-no-picture", "stow", "2026-11-03T10:00:00.000Z", false),
    ] as never[]
    expect(pickPicture(list)).toEqual({ path: "/h/saves/dev/stow/thumb.png", version: "2026-10-20T10:00:00.000Z" })
    expect(pickPicture(list.filter((s) => (s as { kind: string }).kind !== "stow"))?.path).toBe("/h/saves/dev/b/thumb.png")
    expect(pickPicture([save("x", "manual", "2026-11-01T10:00:00.000Z", false)] as never[])).toBeNull()
    expect(pickPicture([])).toBeNull()
  })

  it("is the drawn wallpaper when there is no picture: no icons, no text, hidden from screen readers", () => {
    const host = render(<Backdrop picture={null} />)
    expect(host.querySelector(".backdrop")?.getAttribute("aria-hidden")).toBe("true")
    expect(host.querySelector("svg.backdrop__wallpaper")).not.toBeNull()
    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector("text, image, use")).toBeNull()
    expect(host.textContent).toBe("")
  })

  it("fades a picture in over the wallpaper only once it has loaded", () => {
    const host = render(<Backdrop picture="blob:one" />)
    const img = host.querySelector("img")
    expect(img?.className).toBe("backdrop__picture")
    act(() => {
      img?.dispatchEvent(new Event("load"))
    })
    expect(host.querySelector("img")?.className).toContain("backdrop__picture--ready")
    expect(host.querySelector("svg.backdrop__wallpaper")).not.toBeNull()
    // Another picture starts hidden again, so it is never shown half-drawn.
    rerender(<Backdrop picture="blob:two" />)
    expect(host.querySelector("img")?.className).toBe("backdrop__picture")
  })

  it("keeps the layers out of the layout, so a picture arriving moves nothing", () => {
    expect(rule(".backdrop")).toMatch(/position:\s*absolute/)
    expect(rule(".backdrop")).toMatch(/pointer-events:\s*none/)
    expect(rule(".backdrop__picture")).toMatch(/opacity:\s*0/)
    expect(rule(".backdrop__picture")).toMatch(/transition:\s*opacity/)
  })

  it("shows the suspended machine's screenshot, and not another machine's", async () => {
    install({ saves: [save("stow", "stow", "2026-11-02T10:00:00.000Z", true)] })
    Object.assign(URL, { createObjectURL: () => "blob:fake" })
    const host = render(stowedOverview("dev"))
    await flush()
    expect(host.querySelector(".backdrop__picture")?.getAttribute("src")).toBe("blob:fake")
    // Another machine, with no picture: its wallpaper at once, never dev's picture.
    install({ saves: [save("manual", "manual", "2026-11-02T10:00:00.000Z", false)] })
    rerender(stowedOverview("other"))
    expect(host.querySelector(".backdrop__picture")).toBeNull()
    await flush()
    expect(host.querySelector(".backdrop__picture")).toBeNull()
    expect(host.querySelector("svg.backdrop__wallpaper")).not.toBeNull()
  })

  it("has a note and a backdrop for a suspended machine only", async () => {
    install()
    for (const phase of ["stopped", "missing"] as const) {
      const host = render(<Overview instance="dev" phase={phase} status={null} steps={null} canStart onStart={() => undefined} />)
      await flush()
      expect(host.querySelector(".notes")).toBeNull()
      expect(host.querySelector(".backdrop")).toBeNull()
      act(() => root?.unmount())
      root = null
      document.body.replaceChildren()
    }
    const host = render(stowedOverview("dev"))
    await flush()
    expect(host.querySelector(".notes")).not.toBeNull()
    expect(host.querySelector(".backdrop")).not.toBeNull()
    // The old line is gone.
    expect(host.textContent).not.toContain("picks up exactly where you left off")
    expect(host.textContent).toContain(word("overview.stowed.title"))
  })
})

// ---- Contrast over the backdrop -------------------------------------------------

const TOKENS = readFileSync(resolve(import.meta.dir, "../ui/src/styles/tokens.css"), "utf8")

/** A theme's colors, from tokens.css: the dark `:root` block or the `[data-theme="light"]` one. */
function theme(which: "dark" | "light"): Map<string, string> {
  const head = which === "light" ? '[data-theme="light"] {' : "color-scheme: dark;"
  const from = TOKENS.indexOf(head)
  if (from === -1) throw new Error(`no ${which} theme`)
  const body = TOKENS.slice(from, TOKENS.indexOf("}", from))
  return new Map([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1] ?? "", m[2] ?? ""]))
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
const lin = (c: number): number => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
const lum = ([r, g, b]: [number, number, number]): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** The backdrop's tone: `--backdrop-opacity` and the contrast()/brightness() it filters with (saturation cannot move a gray). */
function tone(): { opacity: number; apply: (v: number) => number } {
  const block = rule(".backdrop")
  const opacity = Number(/--backdrop-opacity:\s*([\d.]+)/.exec(block)?.[1])
  const filter = /--backdrop-filter:\s*([^;]+);/.exec(block)?.[1] ?? ""
  const contrast = Number(/contrast\(([\d.]+)\)/.exec(filter)?.[1] ?? 1)
  const brightness = Number(/brightness\(([\d.]+)\)/.exec(filter)?.[1] ?? 1)
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  return { opacity, apply: (v) => clamp(clamp((v - 0.5) * contrast + 0.5) * brightness) }
}

describe("text over the backdrop", () => {
  it("clears WCAG AA (4.5:1) in both themes against the worst picture: pure black or pure white", () => {
    const { opacity, apply } = tone()
    expect(opacity).toBeGreaterThanOrEqual(0.1)
    expect(opacity).toBeLessThanOrEqual(0.2)
    for (const which of ["dark", "light"] as const) {
      const colors = theme(which)
      // The display is --surface-card while there is no screen (.display).
      for (const surface of ["--surface-card"]) {
        const under = rgb(colors.get(surface) ?? "")
        for (const extreme of [0, 1]) {
          const picture = apply(extreme) * 255
          const bg = under.map((c) => c * (1 - opacity) + picture * opacity) as [number, number, number]
          // What is drawn straight on the backdrop: the heading, the figures, the labels and errors
          // (text: 4.5:1), and the abilities' icons (--link, a glyph: 3:1).
          const needs: [string, number][] = [
            ["--text-strong", 4.5],
            ["--text-base-color", 4.5],
            ["--status-error", 4.5],
            ["--link", 3],
          ]
          for (const [text, least] of needs) {
            const got = ratio(rgb(colors.get(text) ?? ""), bg)
            expect({ which, surface, extreme, text, ratio: got.toFixed(2), ok: got >= least }).toMatchObject({ ok: true })
          }
        }
      }
    }
  })

  it("keeps --text-muted off the backdrop, where it would not clear 4.5:1 everywhere", () => {
    expect(rule(".overview--notes .fact dt")).toMatch(/color:\s*var\(--text-base-color\)/)
    expect(rule(".overview--notes .abilities__title")).toMatch(/color:\s*var\(--text-base-color\)/)
  })

  it("has no raw color of its own: the wallpaper and the layers take the app's tokens", () => {
    const source = readFileSync(resolve(import.meta.dir, "../ui/src/features/overview/Backdrop.tsx"), "utf8")
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
    expect(source).toMatch(/var\(--accent\)/)
  })
})
