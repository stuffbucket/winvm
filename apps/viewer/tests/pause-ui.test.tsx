/**
 * Pausing, in the window: the status answers that race a Pause, the meters
 * while held, and the Resources panel. Rendered in happy-dom, with the app's
 * Tauri bridge faked (window.__TAURI__) and winvm's answers handed out by hand.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { useWinvm } = await import("../ui/src/features/winvm/useWinvm")
const { useUsage } = await import("../ui/src/features/usage/useUsage")
const { Resources } = await import("../ui/src/features/usage/Resources")
const en = (await import("../ui/src/i18n/en.json")).default as Record<string, string>

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

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

interface Output {
  code: number
  stdout: string
  stderr: string
}

interface Call {
  readonly args: readonly string[]
  readonly resolve: (o: Output) => void
  done: boolean
}

/** The app's bridge, with `status` and the power verbs answered by the test; the rest answered at once. */
function fakeTauri(): { calls: Call[]; reads(): Call[]; verb(v: string): Call } {
  const calls: Call[] = []
  const held = new Set(["status", "pause", "resume", "sleep", "wake"])
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
    const args = a?.args ?? []
    if (cmd !== "winvm") return Promise.resolve(null)
    if (!held.has(args[0] ?? "")) return Promise.resolve({ code: 1, stdout: "", stderr: "" })
    return new Promise<Output>((resolve) => {
      const call: Call = {
        args,
        done: false,
        resolve: (o) => {
          call.done = true
          resolve(o)
        },
      }
      calls.push(call)
    })
  }
  Object.assign(window, { __TAURI__: { core: { invoke } } })
  return {
    calls,
    reads: () => calls.filter((c) => c.args[0] === "status" && c.args.includes("-i")),
    verb: (v) => {
      const c = calls.find((x) => x.args[0] === v && !x.done)
      if (c === undefined) throw new Error(`no ${v} pending`)
      return c
    },
  }
}

const status = (state: string, agent: "ok" | "silent" | null = "ok"): Output => ({
  code: 0,
  stderr: "",
  stdout: JSON.stringify({
    name: "demo",
    title: null,
    state,
    vmStatus: state === "running" ? "running" : "paused",
    image: "win11-arm64",
    pid: 4242,
    uptimeSeconds: 60,
    cpus: 4,
    memoryMiB: 4096,
    screen: "virtio-gpu 1280x800",
    overlayBytes: 1,
    guest: agent === null ? null : { agent, agentVersion: "9", os: "Windows 11" },
    saves: { count: 0, bytes: 0 },
    notes: [],
  }),
})

describe("pausing in the window", () => {
  it("shows paused the moment Pause returns, and a status read that raced it never puts running back", async () => {
    const tauri = fakeTauri()
    let w: ReturnType<typeof useWinvm> | null = null
    function Probe(): null {
      w = useWinvm()
      return null
    }
    render(<Probe />)
    await flush()
    // The list of machines, then this one's first read.
    const list = tauri.calls.find((c) => c.args[0] === "status" && !c.args.includes("-i"))
    list?.resolve({ ...status("running"), stdout: JSON.stringify({ instances: [JSON.parse(status("running").stdout)] }) })
    await flush()
    tauri.reads()[0]?.resolve(status("running"))
    await flush()
    expect(w!.phase).toBe("running")

    // Pause: while it runs, the poll (now fast) reads again; QEMU still says running to it.
    let acted: Promise<void> | null = null
    act(() => {
      acted = w!.act("pause")
    })
    await flush()
    expect(w!.busy).toBe("pause")
    const raced = tauri.reads().filter((c) => !c.done)
    expect(raced.length).toBeGreaterThan(0)

    tauri.verb("pause").resolve({ code: 0, stdout: 'paused "demo"\n', stderr: "" })
    await flush()
    // At once, without waiting for a read.
    expect(w!.busy).toBeNull()
    expect(w!.phase).toBe("paused")

    // The reads that were out when Pause ended answer "running": stale, dropped.
    for (const c of raced) c.resolve(status("running"))
    await flush()
    expect(w!.phase).toBe("paused")

    // Reads started after it: the newest lands first; the older one, answering later, is dropped.
    const after = tauri.reads().filter((c) => !c.done)
    expect(after.length).toBeGreaterThanOrEqual(2)
    after.at(-1)?.resolve(status("paused", null))
    await flush()
    expect(w!.phase).toBe("paused")
    after[0]?.resolve(status("running"))
    await flush()
    expect(w!.phase).toBe("paused")
    await act(async () => {
      await acted
    })
  })

  it("shows running the moment Wake returns, and asleep until then", async () => {
    const tauri = fakeTauri()
    let w: ReturnType<typeof useWinvm> | null = null
    function Probe(): null {
      w = useWinvm()
      return null
    }
    render(<Probe />)
    await flush()
    tauri.calls.find((c) => c.args[0] === "status" && !c.args.includes("-i"))?.resolve({
      ...status("asleep", null),
      stdout: JSON.stringify({ instances: [JSON.parse(status("asleep", null).stdout)] }),
    })
    await flush()
    tauri.reads()[0]?.resolve(status("asleep", null))
    await flush()
    expect(w!.phase).toBe("asleep")

    act(() => {
      void w!.act("wake")
    })
    await flush()
    const raced = tauri.reads().filter((c) => !c.done)
    tauri.verb("wake").resolve({ code: 0, stdout: "", stderr: "" })
    await flush()
    expect(w!.phase).toBe("running")
    for (const c of raced) c.resolve(status("asleep", null))
    await flush()
    expect(w!.phase).toBe("running")
  })

  it("keeps the old phase when Pause fails", async () => {
    const tauri = fakeTauri()
    let w: ReturnType<typeof useWinvm> | null = null
    function Probe(): null {
      w = useWinvm()
      return null
    }
    render(<Probe />)
    await flush()
    tauri.calls.find((c) => c.args[0] === "status" && !c.args.includes("-i"))?.resolve({
      ...status("running"),
      stdout: JSON.stringify({ instances: [JSON.parse(status("running").stdout)] }),
    })
    await flush()
    tauri.reads()[0]?.resolve(status("running"))
    await flush()
    act(() => {
      void w!.act("pause")
    })
    await flush()
    tauri.verb("pause").resolve({ code: 1, stdout: "", stderr: "::error::no" })
    await flush()
    expect(w!.phase).toBe("running")
    expect(w!.failure?.verb).toBe("pause")
  })
})

describe("the meters while held", () => {
  it("read only ps while the machine is paused, and Windows' figures again once it runs", async () => {
    jest.useFakeTimers()
    const asked: (string | null)[] = []
    const read = async (_pid: number, instance: string | null): Promise<unknown> => {
      asked.push(instance)
      return { atMs: Date.now(), host: { cpuSeconds: 1, rssBytes: 1024 }, guest: null, guestError: null }
    }
    function Probe({ instance }: { readonly instance: string | null }): null {
      useUsage(4242, instance, 4, 4096, read)
      return null
    }
    // Paused: App passes no instance (the agent can't answer).
    render(<Probe instance={null} />)
    await flush()
    act(() => {
      jest.advanceTimersByTime(2500)
    })
    await flush()
    act(() => {
      jest.advanceTimersByTime(2500)
    })
    await flush()
    expect(asked.length).toBeGreaterThanOrEqual(3)
    expect(asked.every((i) => i === null)).toBe(true)

    // Running again.
    act(() => root?.render(<Probe instance="demo" />))
    await flush()
    expect(asked.at(-1)).toBe("demo")
  })

  it("say Paused or Asleep instead of Windows' figures", () => {
    const usage = { now: { cpu: 3, memory: { used: 1, total: 4, source: "windows" as const }, disk: null }, cpuHistory: [], memoryHistory: [] }
    const ctx = { cpus: 4, overlayBytes: null }
    const paused = render(<Resources usage={usage} context={ctx} held="paused" />)
    expect(paused.textContent).toBe(en["usage.paused"] ?? "?")
    act(() => root?.unmount())
    const asleep = render(<Resources usage={usage} context={ctx} held="asleep" />)
    expect(asleep.textContent).toBe(en["usage.asleep"] ?? "?")
    act(() => root?.unmount())
    const running = render(<Resources usage={usage} context={ctx} />)
    expect(running.textContent).toContain(en["usage.cpu"] ?? "?")
  })
})
