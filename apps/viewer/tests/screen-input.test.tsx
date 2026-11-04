/**
 * The screen's input path with a fake noVNC: while the guest takes input
 * (running, nothing under way) noVNC is live; in every other phase it is
 * view-only, the Mac's arrow shows, capture is released, nothing is swallowed,
 * held keys and buttons are let go of first, and the Mac's clipboard waits.
 * Rendered in happy-dom, with the app's Tauri bridge faked.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** Every call a connection made, in order, with `viewOnly` as it was when made. */
interface Call {
  readonly what: string
  readonly viewOnly: boolean
}
const calls: Call[] = []
const made: FakeRFB[] = []

class FakeRFB extends EventTarget {
  scaleViewport = false
  clipViewport = false
  resizeSession = true
  background = ""
  focusOnClick = true
  _viewOnly = false
  _mouseButtonMask = 0
  _mousePos: { x?: number; y?: number } = { x: 12, y: 34 }
  _screenID = 0
  _screenFlags = 0
  _sock = { sQpush8() {}, sQpush16() {}, sQpush32() {}, flush() {} }
  _clipboardServerCapabilitiesFormats = { 1: true }
  _display = { flip() {}, _renderQ: [] as unknown[], _fbWidth: 0, _fbHeight: 0 }
  _keyboard = { _allKeysUp: () => this.log("allKeysUp") }
  static messages = { setDesktopSize() {} }
  constructor(
    readonly target: HTMLElement,
    readonly url: string,
  ) {
    super()
    made.push(this)
    // noVNC puts its canvas in the target, and sets its own cursor on it.
    const canvas = document.createElement("canvas")
    canvas.style.cursor = "none"
    target.append(canvas)
  }
  get viewOnly(): boolean {
    return this._viewOnly
  }
  set viewOnly(v: boolean) {
    this.log(`viewOnly=${String(v)}`)
    this._viewOnly = v
  }
  private log(what: string): void {
    calls.push({ what, viewOnly: this._viewOnly })
  }
  sendKey(_keysym: number, code: string, down?: boolean): void {
    if (this._viewOnly) return
    this.log(`key:${code}:${String(down)}`)
  }
  _handleMouseButton(_x: number, _y: number, mask: number): void {
    this.log(`mouse:${String(mask)}`)
    this._mouseButtonMask = mask
  }
  clipboardPasteFrom(text: string): void {
    if (this._viewOnly) return
    this.log(`paste:${text}`)
  }
  sendCredentials(): void {}
  disconnect(): void {}
  connect(): void {
    this.dispatchEvent(new Event("connect"))
  }
}

let mac = "from the Mac"
let focused = true
mock.module("novnc/core/rfb.js", () => ({ default: FakeRFB }))
mock.module("novnc/core/input/util.js", () => ({
  getKeysym: (e: KeyboardEvent) => (e.code === "KeyA" ? 0x61 : null),
  getKeycode: (e: KeyboardEvent) => e.code,
}))
// The app's bridge: the Mac's clipboard is `mac`; everything else is answered with nothing.
// (backend.ts is not mocked: bun's module mocks outlive this file.)
const bridge = {
  core: { invoke: async (cmd: string): Promise<unknown> => (cmd === "read_text" ? mac : null) },
  event: { listen: async (): Promise<() => void> => () => undefined, emit: async () => undefined },
}
Object.assign(window, { __TAURI__: bridge })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Screen } = await import("../ui/src/features/screen/Screen")
const { inputRule } = await import("../ui/src/features/screen/input")

type Root = ReturnType<typeof createRoot>
let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  calls.length = 0
  made.length = 0
  Object.assign(window, { __TAURI__: bridge })
  mac = "from the Mac"
  focused = true
})
afterAll(() => GlobalRegistrator.unregister())
Object.defineProperty(document, "hasFocus", { value: () => focused, configurable: true })

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

type Phase = Parameters<typeof inputRule>[0]
interface Props {
  phase: Phase
  busy?: boolean
  captured?: boolean
}

function Harness(p: Props & { onCaptured(c: boolean): void }): JSX.Element {
  const rule = inputRule(p.phase, p.busy ?? false)
  return (
    <Screen
      connection={{ websocketPort: 5900, password: "x" } as never}
      keyboardCaptured={p.captured ?? false}
      onKeyboardCaptured={p.onCaptured}
      forwardInput={rule.forward}
      resizable={false}
      frozen={p.phase === "paused" || p.phase === "asleep"}
      asleep={p.phase === "asleep"}
      ready={rule.forward}
    />
  )
}

async function mount(initial: Props): Promise<{ set(next: Props): Promise<void>; captures: boolean[]; rfb: FakeRFB; area(): HTMLElement; canvas(): HTMLCanvasElement }> {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  const captures: boolean[] = []
  const render = (p: Props): void => act(() => root?.render(<Harness {...p} onCaptured={(c) => captures.push(c)} />))
  render(initial)
  await flush()
  const rfb = made[0]!
  await act(async () => rfb.connect())
  await flush()
  return {
    async set(next) {
      render(next)
      await flush()
    },
    captures,
    rfb,
    area: () => host.querySelector<HTMLElement>(".screen")!,
    canvas: () => host.querySelector<HTMLCanvasElement>("canvas")!,
  }
}

const key = (target: EventTarget, type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

describe("the screen's input", () => {
  it("is live while Windows runs with nothing under way: noVNC takes input, the guest's cursor shows", async () => {
    const s = await mount({ phase: "running" })
    expect(s.rfb.viewOnly).toBe(false)
    expect(s.rfb.focusOnClick).toBe(true)
    expect(s.area().classList.contains("screen--inert")).toBe(false)
  })

  it.each(["paused", "asleep", "starting", "stopped", "stowed"] as const)("is a picture in %s: view-only, the Mac's arrow, no focus on click (except asleep)", async (phase) => {
    const s = await mount({ phase })
    expect(s.rfb.viewOnly).toBe(true)
    expect(s.area().classList.contains("screen--inert")).toBe(true)
    expect(s.rfb.focusOnClick).toBe(phase === "asleep")
  })

  it("is a picture while a verb is under way, and live again after", async () => {
    const s = await mount({ phase: "running" })
    await s.set({ phase: "running", busy: true })
    expect(s.rfb.viewOnly).toBe(true)
    expect(s.area().classList.contains("screen--inert")).toBe(true)
    await s.set({ phase: "running" })
    expect(s.rfb.viewOnly).toBe(false)
    expect(s.area().classList.contains("screen--inert")).toBe(false)
  })

  it("lets go of held keys and buttons first, while noVNC can still send, and releases capture", async () => {
    const s = await mount({ phase: "running", captured: true })
    key(s.area().querySelector(".screen__canvas")!, "keydown", "MetaLeft", { metaKey: true })
    s.rfb._mouseButtonMask = 1
    calls.length = 0
    await s.set({ phase: "paused", captured: true })
    const names = calls.map((c) => c.what)
    expect(names).toContain("key:MetaLeft:false")
    expect(names).toContain("mouse:0")
    expect(names).toContain("allKeysUp")
    // Every release went out before noVNC went view-only.
    const viewOnlyAt = names.indexOf("viewOnly=true")
    expect(viewOnlyAt).toBeGreaterThan(-1)
    for (const release of ["key:MetaLeft:false", "mouse:0", "allKeysUp"]) expect(names.indexOf(release)).toBeLessThan(viewOnlyAt)
    expect(s.captures).toEqual([false])
  })

  it("swallows no key while paused, wherever it is held", async () => {
    const s = await mount({ phase: "paused" })
    const target = s.area().querySelector(".screen__canvas")!
    for (const init of [{ metaKey: true }, { ctrlKey: true, altKey: true }, {}]) {
      for (const code of ["MetaRight", "MetaLeft", "ControlLeft", "AltLeft", "KeyA"]) {
        const down = key(target, "keydown", code, init)
        key(target, "keyup", code, init)
        expect(down.defaultPrevented).toBe(false)
      }
    }
    expect(s.captures).toEqual([])
    expect(calls.filter((c) => c.what.startsWith("key:"))).toEqual([])
  })

  it("does not capture again by itself when it runs again", async () => {
    const s = await mount({ phase: "running", captured: true })
    await s.set({ phase: "paused", captured: true })
    await s.set({ phase: "running", captured: false })
    expect(s.rfb.viewOnly).toBe(false)
    calls.length = 0
    // Right Command still works as the uncaptured Windows modifier, so capture isn't what it was.
    const e = key(s.area().querySelector(".screen__canvas")!, "keydown", "MetaLeft", { metaKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(calls.filter((c) => c.what.startsWith("key:"))).toEqual([])
  })

  it("sends the Mac's clipboard once it runs again, not while paused", async () => {
    const s = await mount({ phase: "paused" })
    expect(calls.filter((c) => c.what.startsWith("paste:"))).toEqual([])
    await s.set({ phase: "running" })
    await flush()
    expect(calls.filter((c) => c.what.startsWith("paste:")).map((c) => c.what)).toEqual(["paste:from the Mac"])
  })

  it("does not take focus while paused, and a click on an asleep frame focuses it for the wake key", async () => {
    const outside = document.createElement("input")
    document.body.append(outside)
    const s = await mount({ phase: "paused" })
    outside.focus()
    s.area().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    s.area().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    expect(document.activeElement).toBe(outside)
    await s.set({ phase: "asleep" })
    s.area().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    expect(document.activeElement).toBe(s.area())
  })
})
