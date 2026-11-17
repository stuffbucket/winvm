import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { JSX } from "react"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { App } = await import("../ui/src/App")

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
const tick = async (ms: number): Promise<void> => {
  act(() => {
    jest.advanceTimersByTime(ms)
  })
  await flush()
}

interface Answer {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface World {
  protection: string | null
  fallback: string | null
  state: string
  verbs: string[][]
  stow: Answer
}

const newWorld = (protection: string | null): World => ({
  protection,
  fallback: null,
  state: "running",
  verbs: [],
  stow: { code: 0, stdout: "", stderr: "" },
})

const statusOf = (w: World): Record<string, unknown> => ({
  name: "demo",
  title: null,
  closePolicy: "ask",
  operation: null,
  state: w.state,
  vmStatus: w.state === "running" ? "running" : null,
  image: "win11-arm64",
  pid: w.state === "running" ? 4242 : null,
  uptimeSeconds: 60,
  cpus: 4,
  memoryMiB: 4096,
  screen: "virtio-gpu 1280x800",
  overlayBytes: 1,
  guest: { agent: "ok", agentVersion: "9", os: "Windows 11" },
  saves: { count: 0, bytes: 0 },
  keeper:
    w.protection === null
      ? null
      : {
          protection: w.protection,
          version: "0.1.0",
          pid: 77,
          fallback: w.fallback,
        },
  notes: [],
})

function fakeApp(world: World): void {
  const ok = (stdout: unknown): Answer => ({
    code: 0,
    stdout: JSON.stringify(stdout),
    stderr: "",
  })
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
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
    if (args[0] === "stow" || args[0] === "start") {
      world.verbs.push(args)
      if (args[0] === "stow") {
        if (world.stow.code === 0) world.state = "stowed"
        return Promise.resolve(world.stow)
      }
      world.state = "running"
      world.protection = "kept"
      return Promise.resolve({ code: 0, stdout: "", stderr: "" })
    }
    return Promise.resolve({ code: 1, stdout: "", stderr: "" })
  }
  Object.assign(window, { __TAURI__: { core: { invoke } } })
}

async function mount(world: World): Promise<HTMLElement> {
  jest.useFakeTimers()
  fakeApp(world)
  const host = render(<App />)
  await flush()
  await tick(0)
  return host
}

async function openDetails(host: HTMLElement): Promise<void> {
  const details = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Details"]',
  )
  if (details === null) throw new Error("no Details button")
  act(() => {
    details.click()
  })
  await flush()
}

const protectButton = (host: HTMLElement): HTMLButtonElement | null =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Protect now",
  ) ?? null

const unmount = (): void => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
}

const press = async (button: HTMLButtonElement | null): Promise<void> => {
  await act(async () => {
    button?.click()
    for (let i = 0; i < 40; i++) await Promise.resolve()
  })
  await flush()
}

describe("Protect now", () => {
  it("is offered for a running VM an older winvm started, and stows it, then starts it", async () => {
    for (const protection of ["legacy", "adopted"]) {
      const world = newWorld(protection)
      const host = await mount(world)
      await openDetails(host)
      const button = protectButton(host)
      expect(button?.disabled).toBe(false)
      expect(host.textContent).toContain("not shielded if the Mac shuts down")
      await press(button)
      expect(world.verbs.map((v) => v[0])).toEqual(["stow", "start"])
      expect(world.verbs.every((v) => v.includes("demo"))).toBe(true)
      unmount()
    }
  })

  it("says why the VM is unprotected when the keeper could not start, without blaming an older winvm", async () => {
    const world = newWorld("legacy")
    world.fallback = "launchctl bootstrap: 5: EIO"
    const host = await mount(world)
    await openDetails(host)
    expect(protectButton(host)).not.toBeNull()
    expect(host.textContent).toContain("could not start")
    expect(host.textContent).toContain("launchctl bootstrap: 5: EIO")
    expect(host.textContent).not.toContain("older winvm")
  })

  it("does not start the VM again when the stow fails", async () => {
    const world = newWorld("adopted")
    world.stow = { code: 1, stdout: "", stderr: "guest is not ready" }
    const host = await mount(world)
    await openDetails(host)
    await press(protectButton(host))
    expect(world.verbs.map((v) => v[0])).toEqual(["stow"])
  })

  it("is not offered for a protected VM, or one with no keeper to protect it", async () => {
    for (const protection of ["kept", "off", "missing", null]) {
      const world = newWorld(protection)
      const host = await mount(world)
      await openDetails(host)
      expect(protectButton(host)).toBeNull()
      unmount()
    }
  })
})
