import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { JSX } from "react"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { App } = await import("../ui/src/App")
const { OperationOverlay } = await import(
  "../ui/src/features/operation/OperationOverlay"
)
const { VM_OPERATIONS } = await import("../ui/src/model")
const { SYSTEM_KEYS_RENEW_MS } = await import(
  "../ui/src/features/screen/systemKeys"
)

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

class QuietSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  binaryType = "arraybuffer"
  protocol = "binary"
  readyState = 0
  onopen: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  onmessage: unknown = null
  send(): void {}
  close(): void {
    this.readyState = 3
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}
Object.assign(globalThis, { WebSocket: QuietSocket })

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

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

const COPY: Record<(typeof VM_OPERATIONS)[number], string> = {
  start: "Starting Windows",
  stop: "Shutting Down",
  reboot: "Restarting Windows",
  kill: "Turning Off Windows",
  reset: "Resetting Windows",
  snapshot: "Saving Windows",
  save: "Saving Windows",
  "golden-create": "Saving Windows",
  rewind: "Loading Windows",
  load: "Loading Windows",
  "golden-reset": "Loading Windows",
  pause: "Pausing Windows",
  resume: "Resuming Windows",
  sleep: "Suspending Windows",
  wake: "Waking Windows",
  lock: "Locking Windows",
  stow: "Stowing Windows",
  setup: "Installing Windows",
}

describe("OperationOverlay", () => {
  it("says each operation in its own words, from either source", () => {
    expect(Object.keys(COPY).sort()).toEqual([...VM_OPERATIONS].sort())
    for (const operation of VM_OPERATIONS) {
      for (const source of ["local", "external"] as const) {
        const host = render(
          <OperationOverlay operation={{ operation, source }} />,
        )
        expect(host.textContent).toBe(COPY[operation])
        act(() => root?.unmount())
        host.remove()
      }
    }
  })

  it("is one polite status, and nothing when there is no operation", () => {
    const host = render(
      <OperationOverlay
        operation={{ operation: "stow", source: "external" }}
      />,
    )
    const statuses = host.querySelectorAll('[role="status"]')
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.getAttribute("aria-live")).toBe("polite")
    act(() => root?.render(<OperationOverlay operation={null} />))
    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(host.textContent).toBe("")
  })

  it("takes the pointer: no pass-through rule, and it sits over the display", () => {
    const css = readFileSync(
      resolve(import.meta.dir, "../ui/src/styles/styles.css"),
      "utf8",
    )
    const rule = /\.display__operation\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(rule).toContain("position: absolute")
    expect(rule).toContain("inset: 0")
    expect(rule).toContain("var(--scrim-paused)")
    expect(rule).toContain("pointer-events: auto")
    expect(rule).not.toContain("pointer-events: none")
  })
})

interface World {
  state: "running" | "paused" | "asleep" | "stopped"
  operation: string | null
  systemKeys?: "allowed" | "needsPermission"
}

const statusOf = (w: World): Record<string, unknown> => ({
  name: "demo",
  title: null,
  operation:
    w.operation === null
      ? null
      : {
          operation: w.operation,
          pid: 777,
          startedAt: "2026-11-12T10:00:00.000Z",
        },
  state: w.state,
  vmStatus:
    w.state === "running" ? "running" : w.state === "stopped" ? null : "paused",
  image: "win11-arm64",
  pid: w.state === "stopped" ? null : 4242,
  uptimeSeconds: 60,
  cpus: 4,
  memoryMiB: 4096,
  screen: "virtio-gpu 1280x800",
  overlayBytes: 1,
  guest:
    w.state === "running"
      ? { agent: "ok", agentVersion: "9", os: "Windows 11" }
      : null,
  saves: { count: 0, bytes: 0 },
  notes: [],
})

function fakeApp(world: World): {
  capture: boolean[]
  renewals: () => number
  settingsOpened: () => number
  pending: { args: readonly string[]; finish(): void }[]
} {
  const capture: boolean[] = []
  let renewals = 0
  let opened = 0
  const pending: { args: readonly string[]; finish(): void }[] = []
  const ok = (
    stdout: unknown,
  ): { code: number; stdout: string; stderr: string } => ({
    code: 0,
    stdout: JSON.stringify(stdout),
    stderr: "",
  })
  const invoke = (
    cmd: string,
    a?: { args?: string[]; armed?: boolean },
  ): Promise<unknown> => {
    if (cmd === "system_keys") {
      const armed = a?.armed === true
      if (armed) renewals += 1
      if (armed !== (capture.at(-1) ?? false)) capture.push(armed)
      return Promise.resolve(world.systemKeys ?? "allowed")
    }
    if (cmd === "system_keys_status")
      return Promise.resolve(world.systemKeys ?? "allowed")
    if (cmd === "open_accessibility_settings") {
      opened += 1
      return Promise.resolve(null)
    }
    if (cmd !== "winvm") return Promise.resolve(null)
    const args = a?.args ?? []
    if (args[0] === "status")
      return Promise.resolve(
        ok(
          args.includes("-i")
            ? statusOf(world)
            : { instances: [statusOf(world)] },
        ),
      )
    if (args[0] === "open")
      return Promise.resolve(
        ok({ display: 1, vncPort: 5901, websocketPort: 5701, password: null }),
      )
    if (args[0] === "pause")
      return new Promise((resolve) =>
        pending.push({
          args,
          finish: () => {
            resolve({ code: 0, stdout: "", stderr: "" })
          },
        }),
      )
    return Promise.resolve({ code: 1, stdout: "", stderr: "" })
  }
  Object.assign(window, { __TAURI__: { core: { invoke } } })
  return {
    capture,
    renewals: () => renewals,
    settingsOpened: () => opened,
    pending,
  }
}

const display = (host: HTMLElement): HTMLElement => {
  const el = host.querySelector<HTMLElement>(".display")
  if (el === null) throw new Error("no display")
  return el
}
const overlay = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>(".display > .display__operation")
const button = (host: HTMLElement, label: string): HTMLButtonElement => {
  const el = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )
  if (el === null) throw new Error(`no ${label} button`)
  return el
}
const tick = async (ms: number): Promise<void> => {
  act(() => {
    jest.advanceTimersByTime(ms)
  })
  await flush()
}

const dialogButton = (label: string): HTMLButtonElement => {
  const el = [
    ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].find((b) => b.textContent === label)
  if (el === undefined) throw new Error(`no ${label} in a dialog`)
  return el
}

async function mount(
  world: World,
): Promise<{ host: HTMLElement; app: ReturnType<typeof fakeApp> }> {
  jest.useFakeTimers()
  const app = fakeApp(world)
  const host = render(<App />)
  await flush()
  await tick(0)
  return { host, app }
}

describe("the display while an operation runs", () => {
  it("covers the Overview of a machine another process is starting, as the last thing in the display, and goes when it ends", async () => {
    const world: World = { state: "stopped", operation: "start" }
    const { host } = await mount(world)
    const shown = overlay(host)
    expect(shown?.textContent).toBe("Starting Windows")
    expect(shown?.getAttribute("role")).toBe("status")
    expect(shown?.getAttribute("aria-live")).toBe("polite")
    expect(display(host).lastElementChild).toBe(shown)
    expect(display(host).querySelector(".overview")).not.toBeNull()
    expect(host.querySelectorAll('.display [role="status"]')).toHaveLength(1)

    world.operation = null
    await tick(1500)
    expect(overlay(host)).toBeNull()
  })

  it("covers a live screen for an external stow, blocks the controls and releases the keyboard", async () => {
    const world: World = { state: "running", operation: null }
    const { host, app } = await mount(world)
    expect(display(host).querySelector(".screen")).not.toBeNull()
    expect(overlay(host)).toBeNull()
    expect(button(host, "Shut down").disabled).toBe(false)
    expect(button(host, "Pause").disabled).toBe(false)
    expect(button(host, "Terminal").disabled).toBe(false)

    act(() => {
      button(host, "Capture Keyboard (Control-Option)").click()
    })
    await flush()
    expect(
      button(host, "Release Keyboard (Control-Option)").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true")
    expect(app.capture.at(-1)).toBe(true)

    world.operation = "stow"
    await tick(4000)
    const shown = overlay(host)
    expect(shown?.textContent).toBe("Stowing Windows")
    expect(display(host).lastElementChild).toBe(shown)
    expect(display(host).querySelector(".screen")).not.toBeNull()
    expect(host.querySelector(".viewer")?.getAttribute("data-busy")).toBe(
      "true",
    )
    for (const label of [
      "Shut down",
      "Restart",
      "Pause",
      "Terminal",
      "Files in Windows",
      "Capture Keyboard (Control-Option)",
    ]) {
      expect(button(host, label).disabled).toBe(true)
    }
    expect(app.capture).toEqual([true, false])

    world.operation = null
    await tick(1500)
    expect(overlay(host)).toBeNull()
    expect(button(host, "Shut down").disabled).toBe(false)
  })

  it("covers it for a command this viewer runs, named by that command", async () => {
    const world: World = { state: "running", operation: null }
    const { host, app } = await mount(world)
    act(() => {
      button(host, "Pause").click()
    })
    await flush()
    expect(overlay(host)?.textContent).toBe("Pausing Windows")
    expect(display(host).lastElementChild).toBe(overlay(host))
    world.operation = "stop"
    await tick(1500)
    expect(overlay(host)?.textContent).toBe("Pausing Windows")
    world.operation = null
    world.state = "paused"
    app.pending[0]?.finish()
    await flush()
    await tick(1500)
    expect(overlay(host)).toBeNull()
  })

  it("leaves the paused and asleep overlays as they were when nothing is running", async () => {
    const world: World = { state: "paused", operation: null }
    const { host } = await mount(world)
    expect(overlay(host)).toBeNull()
    expect(display(host).querySelector(".screen__held--on")).not.toBeNull()
    expect(host.querySelector(".display > .display__operation")).toBeNull()

    world.operation = "resume"
    await tick(4000)
    expect(overlay(host)?.textContent).toBe("Resuming Windows")
    expect(display(host).querySelector(".screen__held--on")).not.toBeNull()
    expect(display(host).lastElementChild).toBe(overlay(host))
  })
})

describe("Mac system shortcuts while the keyboard is captured", () => {
  const capture = (host: HTMLElement): void => {
    act(() => {
      button(host, "Capture Keyboard (Control-Option)").click()
    })
  }
  const release = (host: HTMLElement): void => {
    act(() => {
      button(host, "Release Keyboard (Control-Option)").click()
    })
  }

  it("captures straight away once Accessibility allows it", async () => {
    const { host, app } = await mount({ state: "running", operation: null })
    capture(host)
    await flush()
    expect(document.querySelector("dialog")).toBeNull()
    expect(app.capture).toEqual([true])
    expect(host.querySelector(".toolbar__capture-status")?.textContent).toBe(
      "Keyboard captured — ⌃⌥ to release",
    )
    const armed = app.renewals()
    await tick(SYSTEM_KEYS_RENEW_MS * 2)
    expect(app.renewals()).toBe(armed + 2)
    release(host)
    await flush()
    await tick(SYSTEM_KEYS_RENEW_MS * 2)
    expect(app.renewals()).toBe(armed + 2)
    expect(app.capture).toEqual([true, false])
  })

  it("explains the permission first and can capture without it", async () => {
    const { host, app } = await mount({
      state: "running",
      operation: null,
      systemKeys: "needsPermission",
    })
    capture(host)
    await flush()
    expect(document.querySelector("dialog h2")?.textContent).toBe(
      "Send Mac system shortcuts to Windows?",
    )
    expect(app.capture).toEqual([])
    act(() => {
      dialogButton("Capture Without Them").click()
    })
    await flush()
    expect(app.capture).toEqual([true])
    expect(host.querySelector(".toolbar__capture-status")?.textContent).toBe(
      "Keyboard captured, but macOS keeps ⌘Tab — ⌃⌥ to release",
    )
    release(host)
    capture(host)
    await flush()
    expect(document.querySelector("dialog")).toBeNull()
    expect(app.capture).toEqual([true, false, true])
  })

  it("opens Accessibility settings and leaves the keyboard released", async () => {
    const { host, app } = await mount({
      state: "running",
      operation: null,
      systemKeys: "needsPermission",
    })
    capture(host)
    await flush()
    act(() => {
      dialogButton("Open System Settings").click()
    })
    await flush()
    expect(app.settingsOpened()).toBe(1)
    expect(app.capture).toEqual([])
    expect(
      button(host, "Capture Keyboard (Control-Option)").getAttribute(
        "aria-pressed",
      ),
    ).toBe("false")
  })

  it("asks again after a cancel", async () => {
    const { host } = await mount({
      state: "running",
      operation: null,
      systemKeys: "needsPermission",
    })
    capture(host)
    await flush()
    act(() => {
      dialogButton("Cancel").click()
    })
    await flush()
    expect(document.querySelector("dialog")).toBeNull()
    capture(host)
    await flush()
    expect(document.querySelector("dialog h2")?.textContent).toBe(
      "Send Mac system shortcuts to Windows?",
    )
  })
})
