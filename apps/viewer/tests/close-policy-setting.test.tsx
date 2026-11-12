/**
 * The per-machine close-policy setting in Details: a labelled select that shows the
 * CLI's effective policy, writes it with `winvm config -i <stable-name> viewer.closePolicy=…`,
 * and keeps the old value when the write fails. Rendered in happy-dom with the app's
 * Tauri bridge faked; no real machine is touched.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { App } = await import("../ui/src/App")
const { useWinvm } = await import("../ui/src/features/winvm/useWinvm")

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

/** A VNC socket that never connects: the real Screen mounts, and nothing reaches a network. */
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
  /** What `winvm status` reports as the effective policy. */
  closePolicy: string
  operation: string | null
  /** What a config write answers. */
  config: Answer
  /** Hold config writes until the test finishes them. */
  hold: boolean
  configs: string[][]
  pending: (() => void)[]
  statusReads: number
}

const newWorld = (): World => ({
  closePolicy: "ask",
  operation: null,
  config: { code: 0, stdout: "", stderr: "" },
  hold: false,
  configs: [],
  pending: [],
  statusReads: 0,
})

const statusOf = (w: World): Record<string, unknown> => ({
  name: "demo",
  // A display title unlike the stable name: the setting must never be keyed by it.
  title: "Build box",
  closePolicy: w.closePolicy,
  operation: w.operation === null ? null : { operation: w.operation, pid: 777, startedAt: "2026-11-12T10:00:00.000Z" },
  state: "running",
  vmStatus: "running",
  image: "win11-arm64",
  pid: 4242,
  uptimeSeconds: 60,
  cpus: 4,
  memoryMiB: 4096,
  screen: "virtio-gpu 1280x800",
  overlayBytes: 1,
  guest: { agent: "ok", agentVersion: "9", os: "Windows 11" },
  saves: { count: 0, bytes: 0 },
  notes: [],
})

function fakeApp(world: World): void {
  const ok = (stdout: unknown): Answer => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "" })
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
    if (cmd !== "winvm") return Promise.resolve(null)
    const args = a?.args ?? []
    if (args[0] === "status") {
      world.statusReads += 1
      return Promise.resolve(ok(args.includes("-i") ? statusOf(world) : { instances: [statusOf(world)] }))
    }
    if (args[0] === "open") return Promise.resolve(ok({ display: 1, vncPort: 5901, websocketPort: 5701, password: null }))
    if (args[0] === "config") {
      world.configs.push(args)
      const answer = world.config
      const apply = (): Answer => {
        // The CLI validates and stores; status then reports what it stored.
        if (answer.code === 0) world.closePolicy = (args.find((x) => x.startsWith("viewer.closePolicy=")) ?? "").split("=")[1] ?? world.closePolicy
        return answer
      }
      if (!world.hold) return Promise.resolve(apply())
      return new Promise((resolve) => world.pending.push(() => resolve(apply())))
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
  const details = host.querySelector<HTMLButtonElement>('button[aria-label="Details"]')
  if (details === null) throw new Error("no Details button")
  act(() => details.click())
  await flush()
}

const policySelect = (host: HTMLElement): HTMLSelectElement => {
  const el = host.querySelector<HTMLSelectElement>("select[name=closePolicy]")
  if (el === null) throw new Error("no close policy select")
  return el
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  // React tracks the value: set it through the native setter, then fire the change it listens for.
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
  act(() => {
    set?.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await flush()
}

describe("the close-policy setting in Details", () => {
  it("is a labelled select with the four policies in order, showing the effective one", async () => {
    const world = newWorld()
    world.closePolicy = "stow"
    const host = await mount(world)
    await openDetails(host)
    const select = policySelect(host)
    expect(select.labels?.[0]?.textContent).toContain("When closing WinVM")
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["ask", "Ask every time"],
      ["leave", "Leave running"],
      ["stow", "Stow Windows"],
      ["shutdown", "Shut down Windows"],
    ])
    expect(select.value).toBe("stow")
    expect(select.disabled).toBe(false)
  })
})

describe("changing the policy", () => {
  it("runs winvm config for the stable instance name, never the title, then shows the value the CLI reports", async () => {
    const world = newWorld()
    const host = await mount(world)
    await openDetails(host)
    await choose(policySelect(host), "leave")
    await flush()
    expect(world.configs).toEqual([["config", "-i", "demo", "viewer.closePolicy=leave"]])
    expect(policySelect(host).value).toBe("leave")
  })

  it("keeps the old value and shows the CLI's words when the write fails, without reading the machine again", async () => {
    const world = newWorld()
    world.closePolicy = "stow"
    world.config = { code: 1, stdout: "", stderr: "winvm config: viewer.closePolicy is read-only on this machine" }
    const host = await mount(world)
    await openDetails(host)
    const reads = world.statusReads
    await choose(policySelect(host), "shutdown")
    expect(world.configs).toEqual([["config", "-i", "demo", "viewer.closePolicy=shutdown"]])
    const select = policySelect(host)
    // Not mirrored: the select still shows what status reported.
    expect(select.value).toBe("stow")
    expect(world.statusReads).toBe(reads)
    const described = select.getAttribute("aria-describedby")
    const message = described === null ? null : host.querySelector(`#${described}`)
    expect(message?.textContent).toContain("viewer.closePolicy is read-only on this machine")
    expect(message?.getAttribute("role")).toBe("alert")

    // A later success clears it.
    world.config = { code: 0, stdout: "", stderr: "" }
    await choose(policySelect(host), "leave")
    expect(policySelect(host).value).toBe("leave")
    expect(policySelect(host).getAttribute("aria-describedby")).toBeNull()
  })

  it("is disabled while the write is in flight, and a second change cannot start", async () => {
    const world = newWorld()
    world.hold = true
    const host = await mount(world)
    await openDetails(host)
    await choose(policySelect(host), "leave")
    expect(policySelect(host).disabled).toBe(true)
    await choose(policySelect(host), "stow")
    expect(world.configs).toHaveLength(1)
    world.pending.shift()?.()
    await flush()
    expect(policySelect(host).disabled).toBe(false)
    expect(policySelect(host).value).toBe("leave")
  })

  it("is disabled while any operation is active on the machine", async () => {
    const world = newWorld()
    const host = await mount(world)
    await openDetails(host)
    expect(policySelect(host).disabled).toBe(false)
    world.operation = "stow"
    await tick(4000)
    expect(policySelect(host).disabled).toBe(true)
    world.operation = null
    await tick(1500)
    expect(policySelect(host).disabled).toBe(false)
  })
})

describe("useWinvm.setClosePolicy", () => {
  const machine = (name: string, closePolicy: string): Record<string, unknown> => ({ ...statusOf(newWorld()), name, title: null, closePolicy, state: "stopped", vmStatus: null, pid: null, guest: null })

  /** Two machines, `a` first; config writes and `a`'s status reads can be held. */
  function twoMachines(): {
    policies: Record<string, string>
    configs: string[][]
    held: (() => void)[]
    holdReadsOf: { name: string | null }
    reads: string[]
  } {
    const policies: Record<string, string> = { a: "ask", b: "stow" }
    const configs: string[][] = []
    const held: (() => void)[] = []
    const holdReadsOf: { name: string | null } = { name: null }
    const reads: string[] = []
    const ok = (stdout: unknown): Answer => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "" })
    const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
      if (cmd !== "winvm") return Promise.resolve(null)
      const args = a?.args ?? []
      if (args[0] === "status") {
        const target = args[args.indexOf("-i") + 1]
        if (args.includes("-i") && target !== undefined) {
          reads.push(target)
          const answer = ok(machine(target, policies[target] ?? "ask"))
          if (holdReadsOf.name === target) return new Promise((resolve) => held.push(() => resolve(answer)))
          return Promise.resolve(answer)
        }
        return Promise.resolve(ok({ instances: [machine("a", policies.a ?? "ask"), machine("b", policies.b ?? "ask")] }))
      }
      if (args[0] === "config") {
        configs.push(args)
        const target = args[args.indexOf("-i") + 1] ?? ""
        return new Promise((resolve) =>
          held.push(() => {
            policies[target] = (args[args.length - 1] ?? "").split("=")[1] ?? "ask"
            resolve({ code: 0, stdout: "", stderr: "" })
          }),
        )
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "" })
    }
    Object.assign(window, { __TAURI__: { core: { invoke } } })
    return { policies, configs, held, holdReadsOf, reads }
  }

  type Seen = ReturnType<typeof useWinvm>
  function harness(): { latest: () => Seen } {
    let seen: Seen | null = null
    const Probe = (): null => {
      seen = useWinvm()
      return null
    }
    render(<Probe />)
    return {
      latest: () => {
        if (seen === null) throw new Error("not rendered")
        return seen
      },
    }
  }

  it("never lets an old machine's response replace the machine selected since", async () => {
    jest.useFakeTimers()
    const world = twoMachines()
    const app = harness()
    await flush()
    await tick(0)
    expect(app.latest().name).toBe("a")
    expect(app.latest().status?.closePolicy).toBe("ask")

    const writing = app.latest().setClosePolicy("leave")
    await flush()
    expect(world.configs).toEqual([["config", "-i", "a", "viewer.closePolicy=leave"]])

    // The person moves to machine b while a's write is out; a's refresh read is held too.
    act(() => app.latest().select("b"))
    await flush()
    await tick(0)
    expect(app.latest().status?.name).toBe("b")
    world.holdReadsOf.name = "a"
    world.held.shift()?.()
    await flush()
    // The write finished and a's read is out; b is still what is shown.
    expect(world.reads).toContain("a")
    for (const release of world.held.splice(0)) release()
    expect(await writing).toBeNull()
    await flush()
    expect(app.latest().status?.name).toBe("b")
    expect(app.latest().status?.closePolicy).toBe("stow")
    // a's own value did change, and the picker knows that machine's state without showing its status.
    expect(world.policies.a).toBe("leave")
  })

  it("does nothing, and never falls back to default, when no machine is selected", async () => {
    // No machine answers: the list read never lands.
    const calls: string[][] = []
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
            if (cmd === "winvm") calls.push(a?.args ?? [])
            return Promise.resolve({ code: 1, stdout: "", stderr: "no" })
          },
        },
      },
    })
    const app = harness()
    await flush()
    expect(app.latest().name).toBeNull()
    expect(await app.latest().setClosePolicy("leave")).toBeNull()
    expect(calls.some((c) => c[0] === "config")).toBe(false)
  })
})
