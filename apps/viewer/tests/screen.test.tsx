import { afterAll, afterEach, describe, expect, it, jest, mock } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { JSX } from "react"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

class FakeRFB extends EventTarget {
  static made: FakeRFB[] = []
  static messages = { setDesktopSize: (): void => undefined }
  readonly url: string
  readonly password: string | undefined
  disconnected = false
  background = ""
  resizeSession = false
  focusOnClick = false
  viewOnly = false
  scaleViewport = false
  qualityLevel = 6
  _mouseButtonMask = 0
  _mouseMoveTimer: ReturnType<typeof setTimeout> | null = null
  _handleMouseButton(): void {}
  _sock = {}
  _keyboard = { _allKeysUp: (): void => undefined }
  _display = {
    _renderQ: [] as unknown[],
    _fbWidth: 0,
    _fbHeight: 0,
    flip: (): void => undefined,
  }
  constructor(
    _el: Element,
    url: string,
    options: { credentials?: { password?: string } },
  ) {
    super()
    this.url = url
    this.password = options.credentials?.password
    FakeRFB.made.push(this)
  }
  disconnect(): void {
    this.disconnected = true
  }
  sendCredentials(): void {}
  clipboardPasteFrom(): void {}
}

const realRfb = { ...(await import("@winvm/novnc/core/rfb.js")) }
await mock.module("@winvm/novnc/core/rfb.js", () => ({ default: FakeRFB }))

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Screen } = await import("../ui/src/features/screen/Screen")

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  FakeRFB.made = []
  jest.useRealTimers()
})
afterAll(async () => {
  await mock.module("@winvm/novnc/core/rfb.js", () => realRfb)
  await GlobalRegistrator.unregister()
})

interface Shown {
  readonly websocketPort?: number
  readonly password?: string | null
  readonly resizable?: boolean
  readonly frozen?: boolean
}

const screen = ({
  websocketPort = 5700,
  password = "pw",
  resizable = false,
  frozen = false,
}: Shown = {}): JSX.Element => (
  <Screen
    connection={{ display: 9, vncPort: 5909, websocketPort, password }}
    keyboardCaptured={false}
    onKeyboardCaptured={() => undefined}
    resizable={resizable}
    frozen={frozen}
    forwardInput={!frozen}
  />
)

describe("the screen's connection", () => {
  it("connects once, again two seconds after it drops, and anew for another port, password or resizing; never for an unrelated render", () => {
    jest.useFakeTimers()
    const host = document.createElement("div")
    document.body.append(host)
    const r = createRoot(host)
    root = r
    act(() => {
      r.render(screen())
    })
    expect(FakeRFB.made.map((c) => c.url)).toEqual(["ws://127.0.0.1:5700"])

    act(() => {
      r.render(screen({ frozen: true }))
    })
    act(() => {
      r.render(screen({ frozen: true }))
    })
    expect(FakeRFB.made).toHaveLength(1)
    expect(FakeRFB.made[0]?.viewOnly).toBe(true)

    act(() => {
      FakeRFB.made[0]?.dispatchEvent(new Event("disconnect"))
    })
    act(() => {
      jest.advanceTimersByTime(1999)
    })
    expect(FakeRFB.made).toHaveLength(1)
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(FakeRFB.made).toHaveLength(2)
    expect(FakeRFB.made[0]?.disconnected).toBe(true)
    expect(FakeRFB.made[1]?.url).toBe("ws://127.0.0.1:5700")

    act(() => {
      r.render(screen({ frozen: true, password: "other" }))
    })
    expect(FakeRFB.made).toHaveLength(3)
    expect(FakeRFB.made[2]?.password).toBe("other")

    act(() => {
      r.render(screen({ frozen: true, password: "other", websocketPort: 5701 }))
    })
    expect(FakeRFB.made.map((c) => c.url).at(-1)).toBe("ws://127.0.0.1:5701")

    act(() => {
      r.render(
        screen({
          frozen: true,
          password: "other",
          websocketPort: 5701,
          resizable: true,
        }),
      )
    })
    expect(FakeRFB.made).toHaveLength(5)
    expect(FakeRFB.made.slice(0, 4).every((c) => c.disconnected)).toBe(true)
    expect(FakeRFB.made[4]?.disconnected).toBe(false)
  })
})
