import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { useWinvm } = await import("../ui/src/features/winvm/useWinvm")

type Winvm = ReturnType<typeof useWinvm>

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  delete (window as { __TAURI__?: unknown }).__TAURI__
  jest.useRealTimers()
})
afterAll(() => GlobalRegistrator.unregister())

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  })
}

const tick = async (ms: number): Promise<void> => {
  for (let left = ms; left > 0; left -= 100) {
    act(() => {
      jest.advanceTimersByTime(Math.min(100, left))
    })
    await flush()
  }
}

interface Machine {
  state: "running" | "paused" | "stopped" | "stowed"
  operation: string | null
  agent: "ok" | "silent"
  management?: string
}

function statusOf(name: string, m: Machine): Record<string, unknown> {
  const live = m.state === "running" || m.state === "paused"
  return {
    name,
    title: null,
    operation:
      m.operation === null
        ? null
        : {
            operation: m.operation,
            pid: 777,
            startedAt: "2026-11-16T10:00:00.000Z",
          },
    state: m.state,
    vmStatus: live ? m.state : null,
    image: "win11-arm64",
    pid: live ? 4242 : null,
    uptimeSeconds: 60,
    cpus: 4,
    memoryMiB: 4096,
    screen: null,
    overlayBytes: 1,
    guest:
      m.state === "running"
        ? { agent: m.agent, agentVersion: "9", os: "Windows 11" }
        : null,
    saves: { count: 0, bytes: 0 },
    notes: [],
    ...(m.management === undefined ? {} : { management: m.management }),
  }
}

function fakeApp(machines: Record<string, Machine>, up = true) {
  const calls: string[][] = []
  const listeners: ((e: { payload: unknown }) => void)[] = []
  const app = {
    machines,
    up,
    calls,
    reads: (name?: string): number =>
      calls.filter(
        (c) =>
          c[0] === "status" &&
          (name === undefined ? c.includes("-i") : c.includes(name)),
      ).length,
    lists: (): number =>
      calls.filter((c) => c[0] === "status" && !c.includes("-i")).length,
    ran: (verb: string): string[][] => calls.filter((c) => c[0] === verb),
    openFails: 0,
    reconcile: (): Promise<unknown> =>
      Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    emit(payload: unknown): void {
      for (const cb of listeners) cb({ payload })
    },
    entry(instance: string, e: Record<string, unknown>): void {
      app.emit({
        type: "entry",
        instance,
        entry: { t: "2026-11-16T10:00:00.000Z", instance, ...e },
        cursor: "c",
      })
    },
  }
  const ok = (o: unknown): unknown => ({
    code: 0,
    stdout: JSON.stringify(o),
    stderr: "",
  })
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
    if (cmd === "events_state")
      return Promise.resolve({ up: app.up, restarts: 0 })
    if (cmd !== "winvm") return Promise.resolve(null)
    const args = a?.args ?? []
    calls.push(args)
    if (args[0] === "status") {
      const i = args.indexOf("-i")
      if (i < 0)
        return Promise.resolve(
          ok({
            instances: Object.entries(app.machines).map(([n, m]) =>
              statusOf(n, m),
            ),
          }),
        )
      const n = args[i + 1] ?? ""
      const m = app.machines[n]
      return Promise.resolve(
        m === undefined
          ? { code: 1, stdout: "", stderr: "" }
          : ok(statusOf(n, m)),
      )
    }
    if (args[0] === "open") {
      if (app.openFails > 0) {
        app.openFails -= 1
        return Promise.resolve({ code: 1, stdout: "", stderr: "no screen" })
      }
      return Promise.resolve(
        ok({ display: 1, vncPort: 5901, websocketPort: 5701, password: null }),
      )
    }
    if (args[0] === "reconcile") return app.reconcile()
    return Promise.resolve({ code: 0, stdout: "", stderr: "" })
  }
  const listen = (
    name: string,
    cb: (e: { payload: unknown }) => void,
  ): Promise<() => void> => {
    if (name === "winvm-event") listeners.push(cb)
    return Promise.resolve(() => undefined)
  }
  Object.assign(window, {
    __TAURI__: {
      core: { invoke },
      event: { listen, emit: () => Promise.resolve() },
    },
  })
  return app
}

function Probe({ slot }: { readonly slot: { current: Winvm | null } }): null {
  slot.current = useWinvm()
  return null
}

async function mount(): Promise<() => Winvm> {
  jest.useFakeTimers()
  const slot: { current: Winvm | null } = { current: null }
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(<Probe slot={slot} />))
  await flush()
  await tick(200)
  return () => {
    if (slot.current === null) throw new Error("not rendered")
    return slot.current
  }
}

const idle = (): Machine => ({ state: "running", operation: null, agent: "ok" })

describe("useWinvm following the event stream", () => {
  it("reads the status when it starts, then not again until an event says the view changed", async () => {
    const app = fakeApp({ demo: idle() })
    const w = await mount()
    expect(w().phase).toBe("running")
    const after = app.calls.length
    await tick(50_000)
    expect(app.calls.length).toBe(after)

    app.entry("demo", { kind: "qmp", event: "RTC_CHANGE", data: {} })
    app.entry("demo", { kind: "service", what: "started" })
    await tick(1000)
    expect(app.calls.length).toBe(after)

    app.machines.demo = { ...idle(), operation: "stow" }
    app.entry("demo", { kind: "op", phase: "begin", operation: "stow" })
    await tick(300)
    expect(app.reads("demo")).toBe(2)
    expect(w().operation).toEqual({ operation: "stow", source: "external" })

    app.machines.demo = { state: "stowed", operation: null, agent: "ok" }
    app.entry("demo", { kind: "qmp", event: "SHUTDOWN", data: {} })
    app.entry("demo", { kind: "disconnected", reason: "qemu-closed" })
    app.entry("demo", { kind: "op", phase: "end", operation: "stow", ok: true })
    await tick(300)
    expect(app.reads("demo")).toBe(3)
    expect(w().operation).toBeNull()
    expect(w().phase).toBe("stowed")
  })

  it("keeps a safety read about once a minute while nothing happens", async () => {
    const app = fakeApp({
      demo: { state: "stopped", operation: null, agent: "ok" },
    })
    await mount()
    const after = app.calls.length
    await tick(60_000)
    expect(app.calls.length - after).toBe(1)
    await tick(60_000)
    expect(app.calls.length - after).toBe(2)
  })

  it("reads a machine it is not showing when that one changes, for the list", async () => {
    const app = fakeApp({ demo: idle(), other: idle() })
    const w = await mount()
    expect(w().name).toBe("demo")
    app.machines.other = { state: "paused", operation: null, agent: "ok" }
    app.entry("other", { kind: "qmp", event: "STOP", data: null })
    await tick(300)
    expect(app.reads("other")).toBe(1)
    expect(w().phases.other).toBe("paused")
    expect(w().status?.name).toBe("demo")
  })

  it("re-reads the list and the machine when the stream (re)connects, the instances change, or entries were lost", async () => {
    const app = fakeApp({ demo: idle() })
    await mount()
    const lists = app.lists()
    const reads = app.reads("demo")
    app.emit({ type: "hello", instances: ["demo"], cursor: "c" })
    await tick(300)
    expect(app.lists()).toBe(lists + 1)
    expect(app.reads("demo")).toBe(reads + 1)
    app.emit({ type: "instances", instances: ["demo", "new"], cursor: "c" })
    await tick(300)
    expect(app.lists()).toBe(lists + 2)
    app.emit({ type: "gap", instance: "demo", cursor: "c" })
    await tick(300)
    expect(app.reads("demo")).toBe(reads + 3)
  })

  it("checks again, backing off, while what it read is still mid-operation or starting, and stops once it settles", async () => {
    const app = fakeApp({ demo: idle() })
    const w = await mount()
    app.machines.demo = { ...idle(), operation: "stop" }
    app.entry("demo", { kind: "op", phase: "end", operation: "stop", ok: true })
    await tick(300)
    const first = app.reads("demo")
    expect(w().operation?.operation).toBe("stop")
    await tick(1000)
    expect(app.reads("demo")).toBe(first + 1)
    await tick(2000)
    expect(app.reads("demo")).toBe(first + 2)
    app.machines.demo = { state: "stopped", operation: null, agent: "ok" }
    await tick(4000)
    expect(app.reads("demo")).toBe(first + 3)
    expect(w().operation).toBeNull()
    await tick(30_000)
    expect(app.reads("demo")).toBe(first + 3)
  })

  it("polls as it used to while the stream is down, and stops polling when it is back", async () => {
    const app = fakeApp({ demo: idle() })
    await mount()
    app.emit({ type: "down", code: 1, restartInMs: 1000 })
    await flush()
    const reads = app.reads("demo")
    await tick(8000)
    expect(app.reads("demo")).toBe(reads + 2)
    app.emit({ type: "hello", instances: ["demo"], cursor: "c" })
    await tick(300)
    const back = app.reads("demo")
    await tick(30_000)
    expect(app.reads("demo")).toBe(back)
  })

  it("polls as it used to when the app has no stream", async () => {
    const app = fakeApp({ demo: idle() }, false)
    await mount()
    const reads = app.reads("demo")
    await tick(8000)
    expect(app.reads("demo")).toBe(reads + 2)
  })

  it("asks for a repair when a status says one is due, then waits a minute before asking again", async () => {
    const app = fakeApp({ demo: { ...idle(), management: "repair" } })
    await mount()
    expect(app.ran("reconcile")).toEqual([["reconcile", "-i", "demo"]])
    app.entry("demo", { kind: "sync", status: "running", running: true })
    await tick(300)
    expect(app.ran("reconcile")).toHaveLength(1)
    await tick(60_000)
    expect(app.ran("reconcile")).toHaveLength(2)
    app.machines.demo = idle()
    app.entry("demo", {
      kind: "op",
      phase: "end",
      operation: "reconcile",
      ok: true,
    })
    await tick(300)
    await tick(120_000)
    expect(app.ran("reconcile")).toHaveLength(2)
  })

  it("asks for no repair while an operation runs, nor when none is due", async () => {
    const app = fakeApp({
      demo: { ...idle(), operation: "save", management: "repair" },
      other: { ...idle(), management: "current" },
    })
    await mount()
    expect(app.ran("reconcile")).toEqual([])
  })

  it("asks again soon for a screen it could not reach, backing off, without reading the status", async () => {
    const app = fakeApp({ demo: idle() })
    app.openFails = 1
    const w = await mount()
    expect(w().connection).toBeNull()
    const reads = app.reads("demo")
    await tick(2000)
    expect(w().connection?.websocketPort).toBe(5701)
    expect(app.reads("demo")).toBe(reads)
  })

  it("keeps asking for an unreachable screen at a bounded pace", async () => {
    const app = fakeApp({ demo: idle() })
    app.openFails = 1000
    await mount()
    await tick(59_000)
    const opens = app.ran("open").length
    expect(opens).toBeGreaterThanOrEqual(5)
    expect(opens).toBeLessThanOrEqual(8)
  })

  it("does not start a second repair while one is still running", async () => {
    const app = fakeApp({ demo: { ...idle(), management: "repair" } })
    app.reconcile = () => new Promise(() => undefined)
    await mount()
    await tick(180_000)
    expect(app.ran("reconcile")).toHaveLength(1)
  })

  it("asks again a minute after a repair that was only put off, and backs off only after one that failed", async () => {
    const deferred = fakeApp({ demo: { ...idle(), management: "repair" } })
    deferred.reconcile = () =>
      Promise.resolve({
        code: 0,
        stdout: "",
        stderr:
          'note: "demo" is autosaving, so its control service and watcher were left as they are',
      })
    await mount()
    await tick(181_000)
    expect(deferred.ran("reconcile")).toHaveLength(4)
    act(() => root?.unmount())
    root = null

    const failing = fakeApp({ demo: { ...idle(), management: "repair" } })
    failing.reconcile = () =>
      Promise.resolve({ code: 1, stdout: "", stderr: "::error::no" })
    await mount()
    await tick(181_000)
    expect(failing.ran("reconcile")).toHaveLength(3)
  })
})
