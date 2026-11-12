/**
 * Closing the viewer: which machines it asks about, in what order, and the one
 * flow that resolves each of them before the app may exit. The flow is driven
 * through a fake Winvm (fresh status reads, explicit-instance actions) and the
 * app's Tauri bridge faked (the close request, its answers, config writes).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act, StrictMode } = await import("react")
const { createRoot } = await import("react-dom/client")
const { orderCloseQueue } = await import("../ui/src/features/close/closeQueue")
const { useCloseFlow } = await import("../ui/src/features/close/useCloseFlow")
const { parseStatus, phase: phaseOf } = await import("../ui/src/model")
const { copy } = await import("./copy")

type Winvm = import("../ui/src/features/winvm/useWinvm").Winvm
type Ran = import("../ui/src/features/winvm/useWinvm").Ran
type Verb = import("../ui/src/features/winvm/useWinvm").Verb
type Status = import("../ui/src/model").Status
type CloseFlow = ReturnType<typeof useCloseFlow>

type State = "running" | "paused" | "asleep" | "stopped" | "stowed" | "missing"

interface Machine {
  readonly name: string
  readonly state: State
  readonly agent?: "ok" | "silent"
  readonly closePolicy?: "ask" | "leave" | "stow" | "shutdown"
  readonly title?: string | null
  readonly operation?: import("../ui/src/model").VmOperation | null
}

const statusOf = (m: Machine) => ({
  name: m.name,
  title: m.title ?? null,
  closePolicy: m.closePolicy ?? "ask",
  operation: m.operation == null ? null : { operation: m.operation, pid: 777, startedAt: "2026-11-12T10:00:00.000Z" },
  state: m.state,
  vmStatus: null,
  image: "win11-arm64",
  pid: m.state === "running" || m.state === "paused" || m.state === "asleep" ? 4242 : null,
  uptimeSeconds: null,
  cpus: 4,
  memoryMiB: 4096,
  screen: null,
  overlayBytes: null,
  guest: m.state === "running" ? { agent: m.agent ?? "ok", agentVersion: "9", os: "Windows 11" } : null,
  saves: { count: 0, bytes: 0 },
  notes: [],
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
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
  act(() => {
    jest.advanceTimersByTime(ms)
  })
  await flush()
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * The app's bridge: the close request (an event the test fires), the four close commands, and
 * `winvm config` writes. Everything is recorded in `log`, in the order it was asked.
 */
function fakeBridge() {
  const log: string[] = []
  const listeners = new Map<string, ((e: { payload: unknown }) => void)[]>()
  const bridge = {
    log,
    /** What `close_pending` answers; a Deferred lets the test answer it later. */
    pending: false as boolean | Deferred<boolean>,
    /** What `close_start` does: resolve, or reject as Rust does when the close is not Requested. */
    start: "ok" as "ok" | "out-of-order",
    /** What `winvm config` answers. */
    config: { code: 0, stdout: "", stderr: "" } as { code: number; stdout: string; stderr: string },
    fire(name = "viewer-close-requested"): void {
      for (const cb of listeners.get(name) ?? []) cb({ payload: null })
    },
    listening(name = "viewer-close-requested"): number {
      return listeners.get(name)?.length ?? 0
    },
    count(entry: string): number {
      return log.filter((l) => l === entry).length
    },
  }
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
    if (cmd === "winvm") {
      const args = a?.args ?? []
      log.push(`winvm ${args.join(" ")}`)
      return Promise.resolve(bridge.config)
    }
    log.push(cmd)
    if (cmd === "close_pending") return typeof bridge.pending === "boolean" ? Promise.resolve(bridge.pending) : bridge.pending.promise
    if (cmd === "close_start") return bridge.start === "ok" ? Promise.resolve(null) : Promise.reject("close start arrived while the close was Idle")
    return Promise.resolve(null)
  }
  const listen = (name: string, cb: (e: { payload: unknown }) => void): Promise<() => void> => {
    log.push(`listen ${name}`)
    listeners.set(name, [...(listeners.get(name) ?? []), cb])
    return Promise.resolve(() => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((c) => c !== cb),
      )
    })
  }
  Object.assign(window, { __TAURI__: { core: { invoke }, event: { listen, emit: () => Promise.resolve() } } })
  return bridge
}

const parsed = (m: Machine): Status => {
  const s = parseStatus(JSON.stringify(statusOf(m)))?.[0]
  if (s === undefined) throw new Error(`unparseable ${m.name}`)
  return s
}

/**
 * A Winvm whose reads answer from `machines` (fresh each time) and whose actions wait for the
 * test: `runs` holds each one asked for until the test settles it.
 */
function fakeWinvm(machines: Machine[], selected: string | null) {
  const log: string[] = []
  const runs: { name: string; verb: Verb; done: Deferred<Ran | null> }[] = []
  const world = {
    machines,
    name: selected,
    /** This viewer's own command on the selected machine. */
    busy: null as Verb | null,
    /** What refreshAll answers: the list, or null as when it can't be read. */
    all: "ok" as "ok" | "fail",
    log,
    runs,
    rerender: (): void => undefined,
    find(name: string): Machine | undefined {
      return world.machines.find((m) => m.name === name)
    },
    set(name: string, change: Partial<Machine>): void {
      world.machines = world.machines.map((m) => (m.name === name ? { ...m, ...change } : m))
    },
    /** Settles the oldest action still running. */
    settle(code: number, output = ""): void {
      const run = runs.find((r) => !settled.has(r))
      if (run === undefined) throw new Error("no action is running")
      settled.add(run)
      run.done.resolve({ verb: run.verb, code, output })
    },
    /** This window's own command on `name` (not the close flow's) ends: its outcome is recorded for that machine. */
    finishLocal(name: string, code: number, output = ""): void {
      const verb = world.busy
      if (verb === null) throw new Error("no command of this window is running")
      seq += 1
      outcomes.set(name, { verb, code, output, seq })
      world.busy = null
      world.rerender()
    },
    snapshot(): Winvm {
      const current = world.name === null ? undefined : world.find(world.name)
      return {
        names: world.machines.map((m) => m.name),
        name: world.name,
        titles: {},
        phases: {},
        status: current === undefined ? null : parsed(current),
        phase: null,
        statusError: null,
        checks: null,
        checksError: null,
        connection: null,
        busy: world.busy,
        operation: world.busy === null ? null : { operation: world.busy, source: "local" },
        failure: null,
        last: null,
        cliPath: null,
        select: (name: string) => {
          log.push(`select ${name}`)
          world.name = name
          world.rerender()
        },
        act: () => Promise.resolve(null),
        runOn: (name: string, verb: Verb) => {
          log.push(`runOn ${name} ${verb}`)
          const done = deferred<Ran | null>()
          runs.push({ name, verb, done })
          return done.promise
        },
        lastOn: (name: string) => outcomes.get(name) ?? null,
        openScreenSharing: () => Promise.resolve(),
        installCommand: () => Promise.resolve(),
        dismissFailure: () => undefined,
        rename: () => Promise.resolve(null),
        refresh: () => Promise.resolve(),
        refreshAll: () => {
          log.push("refreshAll")
          return Promise.resolve(world.all === "ok" ? world.machines.map(parsed) : null)
        },
        refreshOne: (name: string) => {
          log.push(`refreshOne ${name}`)
          const m = world.find(name)
          return Promise.resolve(m === undefined ? null : parsed(m))
        },
      }
    },
  }
  const settled = new Set<(typeof runs)[number]>()
  const outcomes = new Map<string, Ran & { readonly seq: number }>()
  let seq = 0
  return world
}

type FakeWinvm = ReturnType<typeof fakeWinvm>

let root: ReturnType<typeof createRoot> | null = null
let flow: CloseFlow | null = null

function Probe({ w }: { readonly w: Winvm }): null {
  flow = useCloseFlow(w)
  return null
}

/** Mounts the flow on `world`, re-rendering with a fresh Winvm whenever the selection moves. */
async function mount(world: FakeWinvm): Promise<void> {
  jest.useFakeTimers()
  const host = document.createElement("div")
  document.body.append(host)
  const r = createRoot(host)
  root = r
  world.rerender = () => r.render(<Probe w={world.snapshot()} />)
  act(() => world.rerender())
  await flush()
}

const current = (): CloseFlow => {
  if (flow === null) throw new Error("the flow is not mounted")
  return flow
}

describe("orderCloseQueue", () => {
  it("puts the selected live machine first, then the other live ones in list order", () => {
    const list = [statusOf({ name: "a", state: "running" }), statusOf({ name: "b", state: "running" }), statusOf({ name: "c", state: "running" })]
    expect(orderCloseQueue(list, "b", new Set())).toEqual(["b", "a", "c"])
    expect(orderCloseQueue(list, null, new Set())).toEqual(["a", "b", "c"])
  })

  it("asks about every machine whose QEMU is up, a starting one too, and skips the rest", () => {
    const list = [
      statusOf({ name: "off", state: "stopped" }),
      statusOf({ name: "booting", state: "running", agent: "silent" }),
      statusOf({ name: "stowed", state: "stowed" }),
      statusOf({ name: "held", state: "paused" }),
      statusOf({ name: "gone", state: "missing" }),
      statusOf({ name: "sleepy", state: "asleep" }),
      statusOf({ name: "up", state: "running" }),
    ]
    expect(orderCloseQueue(list, null, new Set())).toEqual(["booting", "held", "sleepy", "up"])
    // A selected machine that is not live is not asked about first, or at all.
    expect(orderCloseQueue(list, "off", new Set())).toEqual(["booting", "held", "sleepy", "up"])
    expect(orderCloseQueue(list, "booting", new Set())).toEqual(["booting", "held", "sleepy", "up"])
  })

  it("leaves out machines already resolved, and a later recheck finds one that has since started", () => {
    const first = [statusOf({ name: "a", state: "running" }), statusOf({ name: "b", state: "stopped" }), statusOf({ name: "c", state: "running" })]
    expect(orderCloseQueue(first, "a", new Set(["a"]))).toEqual(["c"])
    // Left running, both still are; `b` started meanwhile.
    const later = [statusOf({ name: "a", state: "running" }), statusOf({ name: "b", state: "running", agent: "silent" }), statusOf({ name: "c", state: "running" })]
    expect(orderCloseQueue(later, "c", new Set(["a", "c"]))).toEqual(["b"])
    expect(orderCloseQueue(later, "c", new Set(["a", "b", "c"]))).toEqual([])
  })
})

describe("useCloseFlow", () => {
  it("acknowledges a close request once, and a repeated request starts no second flow", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running" }, { name: "b", state: "running" }], "a")
    await mount(world)
    expect(current().state).toEqual({ kind: "idle" })

    act(() => bridge.fire())
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    expect(current().state.kind).toBe("asking")

    act(() => {
      bridge.fire()
      bridge.fire()
    })
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    expect(world.log.filter((l) => l === "refreshAll")).toHaveLength(1)
    expect(current().state.kind).toBe("asking")
  })

  it("recovers a request made before it listened: it listens first, then asks whether one is pending", async () => {
    const quiet = fakeBridge()
    await mount(fakeWinvm([{ name: "a", state: "running" }], "a"))
    expect(quiet.log.indexOf("listen viewer-close-requested")).toBeGreaterThanOrEqual(0)
    expect(quiet.log.indexOf("close_pending")).toBeGreaterThan(quiet.log.indexOf("listen viewer-close-requested"))
    expect(quiet.count("close_start")).toBe(0)
    expect(current().state).toEqual({ kind: "idle" })
    act(() => root?.unmount())

    const bridge = fakeBridge()
    bridge.pending = true
    await mount(fakeWinvm([{ name: "a", state: "running" }], "a"))
    expect(bridge.count("close_start")).toBe(1)
    expect(current().state.kind).toBe("asking")
  })

  it("lets the event and the pending query race: one claim starts the flow, and a claim Rust refuses is dropped quietly", async () => {
    // The event arrives while the pending query is still out, then the query answers true.
    const bridge = fakeBridge()
    const answer = deferred<boolean>()
    bridge.pending = answer
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    await mount(world)
    act(() => bridge.fire())
    await flush()
    answer.resolve(true)
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    expect(world.log.filter((l) => l === "refreshAll")).toHaveLength(1)
    expect(current().state.kind).toBe("asking")
    act(() => root?.unmount())

    // A path whose close_start Rust refuses (the close is no longer Requested) neither cancels nor fails.
    const late = fakeBridge()
    late.pending = true
    late.start = "out-of-order"
    const quiet = fakeWinvm([{ name: "a", state: "running" }], "a")
    await mount(quiet)
    expect(late.count("close_start")).toBe(1)
    expect(late.count("close_cancel")).toBe(0)
    expect(quiet.log).toEqual([])
    expect(current().state).toEqual({ kind: "idle" })
    // …and leaves the window free to take the next request.
    late.start = "ok"
    act(() => late.fire())
    await flush()
    expect(late.count("close_start")).toBe(2)
    expect(current().state.kind).toBe("asking")
  })

  it("starts one flow under StrictMode's doubled effects, and only for a listener still mounted", async () => {
    const bridge = fakeBridge()
    bridge.pending = true
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    jest.useFakeTimers()
    const host = document.createElement("div")
    document.body.append(host)
    const r = createRoot(host)
    root = r
    world.rerender = () =>
      r.render(
        <StrictMode>
          <Probe w={world.snapshot()} />
        </StrictMode>,
      )
    act(() => world.rerender())
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    expect(bridge.listening()).toBe(1)
    act(() => bridge.fire())
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    expect(world.log.filter((l) => l === "refreshAll")).toHaveLength(1)
  })

  it("does not claim a pending close for a window that has gone", async () => {
    const bridge = fakeBridge()
    const answer = deferred<boolean>()
    bridge.pending = answer
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    await mount(world)
    act(() => root?.unmount())
    answer.resolve(true)
    await flush()
    expect(bridge.count("close_start")).toBe(0)
    expect(world.log).toEqual([])
  })

  it("asks about the selected machine first, then each other live one in turn, and completes once every one is left running", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "stopped" },
        { name: "c", state: "paused", title: "Work PC" },
      ],
      "c",
    )
    await mount(world)
    act(() => bridge.fire())
    await flush()

    const first = current().state
    expect(first.kind).toBe("asking")
    if (first.kind !== "asking") return
    expect(first.machine.name).toBe("c")
    expect(first.machine.title).toBe("Work PC")
    expect([first.index, first.total, first.remember]).toEqual([1, 2, false])
    // Already selected: read afresh, not selected again.
    expect(world.log).toEqual(["refreshAll", "refreshOne c"])

    act(() => current().choose("leave"))
    await flush()
    const second = current().state
    expect(second.kind).toBe("asking")
    if (second.kind !== "asking") return
    expect(second.machine.name).toBe("a")
    expect([second.index, second.total, second.remember]).toEqual([2, 2, false])
    // Selected before it is read.
    expect(world.log.slice(2)).toEqual(["select a", "refreshOne a"])
    expect(bridge.count("close_complete")).toBe(0)

    act(() => current().choose("leave"))
    await flush()
    expect(world.log.slice(4)).toEqual(["refreshAll"])
    expect(bridge.count("close_complete")).toBe(1)
    expect(bridge.count("close_cancel")).toBe(0)
    expect(world.runs).toHaveLength(0)
    expect(bridge.log.filter((l) => l.startsWith("winvm"))).toEqual([])
  })

  it("treats a status list it can't read as a failure, never as no machines: it stays open and cancels the close", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    world.all = "fail"
    await mount(world)
    act(() => bridge.fire())
    await flush()
    expect(bridge.count("close_complete")).toBe(0)
    expect(bridge.count("close_cancel")).toBe(1)
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.message).toBe(copy("close.statusFailed"))
    expect(failed.machine?.name).toBe("a")

    // The final recheck too: the one machine left running, then the list can't be read.
    act(() => current().cancel())
    world.all = "ok"
    act(() => bridge.fire())
    await flush()
    expect(current().state.kind).toBe("asking")
    world.all = "fail"
    act(() => current().choose("leave"))
    await flush()
    expect(bridge.count("close_complete")).toBe(0)
    expect(bridge.count("close_cancel")).toBe(2)
    expect(current().state.kind).toBe("failed")
  })

  it("applies a remembered choice without asking: leave runs nothing, stow runs stow, shut down runs stop, each on its own machine", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", closePolicy: "leave" },
        { name: "b", state: "running", closePolicy: "stow" },
        { name: "c", state: "asleep", closePolicy: "shutdown" },
      ],
      "a",
    )
    await mount(world)
    act(() => bridge.fire())
    await flush()

    const stowing = current().state
    expect(stowing.kind).toBe("acting")
    if (stowing.kind !== "acting") return
    expect([stowing.machine.name, stowing.policy, stowing.index, stowing.total]).toEqual(["b", "stow", 2, 3])
    expect(world.log).toEqual(["refreshAll", "refreshOne a", "select b", "refreshOne b", "runOn b stow"])

    world.set("b", { state: "stowed" })
    world.settle(0)
    await flush()
    const stopping = current().state
    expect(stopping.kind).toBe("acting")
    if (stopping.kind !== "acting") return
    expect([stopping.machine.name, stopping.policy, stopping.index, stopping.total]).toEqual(["c", "shutdown", 3, 3])
    expect(world.log.slice(5)).toEqual(["select c", "refreshOne c", "runOn c stop"])

    world.set("c", { state: "stopped" })
    world.settle(0)
    await flush()
    expect(world.log.slice(8)).toEqual(["refreshAll"])
    expect(bridge.count("close_complete")).toBe(1)
    // Remembered already: nothing is written again.
    expect(bridge.log.filter((l) => l.startsWith("winvm"))).toEqual([])
  })

  it("offers a starting machine the same choices: stowed, shut down or left, as asked", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", agent: "silent" },
        { name: "b", state: "running", agent: "silent" },
        { name: "c", state: "running", agent: "silent" },
      ],
      "a",
    )
    await mount(world)
    act(() => bridge.fire())
    await flush()
    expect(current().state.kind).toBe("asking")
    act(() => current().choose("stow"))
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow"])
    world.set("a", { state: "stowed" })
    world.settle(0)
    await flush()
    act(() => current().choose("shutdown"))
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow", "b stop"])
    world.set("b", { state: "stopped" })
    world.settle(0)
    await flush()
    const last = current().state
    expect(last.kind === "asking" ? last.machine.name : null).toBe("c")
    act(() => current().choose("leave"))
    await flush()
    expect(world.runs).toHaveLength(2)
    expect(bridge.count("close_complete")).toBe(1)
  })

  it("waits as long as a stow takes: no deadline, no next machine and no exit until it returns", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", closePolicy: "stow" },
        { name: "b", state: "running" },
      ],
      "a",
    )
    await mount(world)
    act(() => bridge.fire())
    await flush()
    expect(current().state.kind).toBe("acting")
    // An hour: still stowing, nothing else asked about, nothing closed.
    for (let i = 0; i < 60; i++) await tick(60_000)
    expect(current().state.kind).toBe("acting")
    expect(world.log).toEqual(["refreshAll", "refreshOne a", "runOn a stow"])
    expect(bridge.count("close_complete")).toBe(0)
    expect(bridge.count("close_cancel")).toBe(0)

    world.set("a", { state: "stowed" })
    world.settle(0)
    await flush()
    const next = current().state
    expect(next.kind === "asking" ? next.machine.name : null).toBe("b")
  })

  it("stays open on the machine whose stow failed, with what the command said, and cancels the close", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running" },
        { name: "c", state: "running" },
      ],
      "b",
    )
    await mount(world)
    act(() => bridge.fire())
    await flush()
    act(() => current().choose("leave"))
    await flush()
    act(() => current().choose("stow"))
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow"])
    // The person looks at another machine meanwhile.
    act(() => world.snapshot().select("b"))
    world.settle(1, "winvm stow: the disk is full")
    await flush()

    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("a")
    expect(failed.message).toBe("winvm stow: the disk is full")
    // Back on the machine it failed on.
    expect(world.name).toBe("a")
    expect(world.log.at(-1)).toBe("select a")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    // Nothing more is asked about or run: `c` stays as it is.
    expect(world.runs).toHaveLength(1)
    expect(world.log.filter((l) => l.includes(" c"))).toEqual([])

    // An action that ran nothing fails the same way.
    act(() => current().cancel())
    act(() => bridge.fire())
    await flush()
    act(() => current().choose("shutdown"))
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow", "a stop"])
    world.runs[1]?.done.resolve(null)
    await flush()
    const nothing = current().state
    expect(nothing.kind === "failed" ? nothing.message : null).toBe(copy("close.actionFailed", { title: "a" }))
    expect(bridge.count("close_cancel")).toBe(2)
  })

  it("fails the same way when the machine it is about to resolve can't be read", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running" }, { name: "b", state: "running", title: "Lab" }], "a")
    await mount(world)
    act(() => bridge.fire())
    await flush()
    // `b` vanishes between the list and its own read.
    world.machines = world.machines.filter((m) => m.name !== "b")
    act(() => current().choose("leave"))
    await flush()
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("b")
    expect(failed.message).toBe(copy("close.statusFailed"))
    expect(world.name).toBe("b")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
  })

  it("remembers a choice for its own machine only once that choice has succeeded, and starts every ask unchecked", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running" },
        { name: "c", state: "paused" },
        { name: "d", state: "running" },
      ],
      "a",
    )
    const writes = (): string[] => bridge.log.filter((l) => l.startsWith("winvm"))
    await mount(world)
    act(() => bridge.fire())
    await flush()

    act(() => current().setRemember(true))
    const checked = current().state
    expect(checked.kind === "asking" ? checked.remember : null).toBe(true)
    act(() => current().choose("leave"))
    await flush()
    // Leave Running succeeds at once.
    expect(writes()).toEqual(["winvm config -i a viewer.closePolicy=leave"])

    const second = current().state
    expect(second.kind === "asking" ? [second.machine.name, second.remember] : null).toEqual(["b", false])
    act(() => current().setRemember(true))
    act(() => current().choose("stow"))
    await flush()
    // Not while it runs…
    expect(writes()).toHaveLength(1)
    world.set("b", { state: "stowed" })
    world.settle(0)
    await flush()
    // …only once it has worked.
    expect(writes()).toEqual(["winvm config -i a viewer.closePolicy=leave", "winvm config -i b viewer.closePolicy=stow"])

    const third = current().state
    expect(third.kind === "asking" ? [third.machine.name, third.remember] : null).toEqual(["c", false])
    act(() => current().setRemember(true))
    act(() => current().choose("shutdown"))
    await flush()
    world.set("c", { state: "stopped" })
    world.settle(0)
    await flush()
    // The policy is Shut Down, though the command was stop.
    expect(writes().at(-1)).toBe("winvm config -i c viewer.closePolicy=shutdown")

    act(() => current().setRemember(true))
    act(() => current().choose("stow"))
    await flush()
    world.settle(1, "no")
    await flush()
    // A failed choice is never remembered.
    expect(writes()).toHaveLength(3)
    expect(current().state.kind).toBe("failed")
  })

  it("stays open on the machine whose choice could not be remembered, with what winvm config said", async () => {
    const bridge = fakeBridge()
    bridge.config = { code: 2, stdout: "", stderr: "winvm config: settings folder is read-only" }
    const world = fakeWinvm([{ name: "a", state: "running" }, { name: "b", state: "running" }], "b")
    await mount(world)
    act(() => bridge.fire())
    await flush()
    act(() => current().setRemember(true))
    act(() => current().choose("leave"))
    await flush()
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("b")
    expect(failed.message).toBe("winvm config: settings folder is read-only")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    // `a` is not asked about.
    expect(world.log.filter((l) => l.endsWith(" a"))).toEqual([])
  })

  it("cancels the whole close from an ask: nothing more runs or is remembered, and what was done stays done", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", closePolicy: "stow" },
        { name: "b", state: "running" },
        { name: "c", state: "running" },
      ],
      "a",
    )
    await mount(world)
    act(() => bridge.fire())
    await flush()
    world.set("a", { state: "stowed" })
    world.settle(0)
    await flush()
    expect(current().state.kind).toBe("asking")

    act(() => current().setRemember(true))
    act(() => current().cancel())
    await flush()
    expect(current().state).toEqual({ kind: "idle" })
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    // `a` stays stowed (nothing starts it), `b` is left as it is, `c` is never asked about.
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow"])
    expect(world.log.filter((l) => l.endsWith(" c"))).toEqual([])
    expect(bridge.log.filter((l) => l.startsWith("winvm"))).toEqual([])
    // The window stays on the machine it asked about.
    expect(world.name).toBe("b")

    // A choice made after cancelling does nothing.
    act(() => current().choose("stow"))
    await flush()
    expect(world.runs).toHaveLength(1)

    // The next close starts afresh from a fresh list, its ask unchecked again.
    act(() => bridge.fire())
    await flush()
    expect(bridge.count("close_start")).toBe(2)
    const again = current().state
    expect(again.kind === "asking" ? [again.machine.name, again.index, again.total, again.remember] : null).toEqual(["b", 1, 2, false])
  })

  it("can't be cancelled while its own stow or shutdown runs", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    await mount(world)
    act(() => bridge.fire())
    await flush()
    act(() => current().choose("shutdown"))
    await flush()
    act(() => current().cancel())
    await flush()
    expect(current().state.kind).toBe("acting")
    expect(bridge.count("close_cancel")).toBe(0)
    // A repeated close request meanwhile is the same close.
    act(() => bridge.fire())
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    world.set("a", { state: "stopped" })
    world.settle(0)
    await flush()
    expect(bridge.count("close_complete")).toBe(1)
    expect(bridge.count("close_cancel")).toBe(0)
  })

  it("waits for an operation it did not start, reading afresh until it clears, then resolves the machine as it is", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", operation: "save" },
        { name: "b", state: "running", operation: "stow" },
      ],
      "a",
    )
    await mount(world)
    act(() => bridge.fire())
    await flush()
    const waiting = current().state
    expect(waiting.kind).toBe("waiting")
    if (waiting.kind !== "waiting") return
    expect([waiting.machine.name, waiting.operation, waiting.index, waiting.total]).toEqual(["a", { operation: "save", source: "external" }, 1, 2])

    await tick(1500)
    expect(current().state.kind).toBe("waiting")
    expect(world.log.filter((l) => l === "refreshOne a")).toHaveLength(2)

    // The save ends: `a` is asked about as it now is.
    world.set("a", { operation: null })
    await tick(1500)
    expect(current().state.kind).toBe("asking")
    act(() => current().choose("leave"))
    await flush()

    // `b` is being stowed elsewhere, and is stowed when that ends: nothing to ask.
    expect(current().state.kind).toBe("waiting")
    world.set("b", { operation: null, state: "stowed" })
    await tick(1500)
    expect(bridge.count("close_complete")).toBe(1)
    expect(world.runs).toHaveLength(0)
  })

  it("waits for this window's own command on the machine too", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    world.busy = "pause"
    await mount(world)
    act(() => bridge.fire())
    await flush()
    const waiting = current().state
    expect(waiting.kind === "waiting" ? waiting.operation : null).toEqual({ operation: "pause", source: "local" })
    world.busy = null
    world.set("a", { state: "paused" })
    act(() => world.rerender())
    await tick(1500)
    const asking = current().state
    expect(asking.kind === "asking" ? phaseOf(asking.machine) : null).toBe("paused")
  })

  it("calls the close off when this window's own command it waited for fails, leaving that command's error to read", async () => {
    const bridge = fakeBridge()
    // Remembered Leave Running: were the failure missed, the close would go straight on to exit.
    const world = fakeWinvm([{ name: "a", state: "running", closePolicy: "leave" }, { name: "b", state: "running", closePolicy: "stow" }], "a")
    world.busy = "stop"
    await mount(world)
    act(() => bridge.fire())
    await flush()
    expect(current().state.kind).toBe("waiting")

    // The person's Shut Down, started before the close, fails; Windows is still running.
    act(() => world.finishLocal("a", 1, "winvm stop: Windows didn't shut down in 180 seconds"))
    await tick(1500)
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("a")
    expect(failed.message).toBe("winvm stop: Windows didn't shut down in 180 seconds")
    expect(world.name).toBe("a")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    // Nothing more is run: not `b`'s remembered stow either.
    expect(world.runs).toHaveLength(0)
    expect(world.log.filter((l) => l.endsWith(" b"))).toEqual([])
  })

  it("calls the close off when another process's command it waited for ends without doing what it does", async () => {
    // A stow elsewhere ends, and the machine is still running: it failed.
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", closePolicy: "stow", operation: "stow", title: "Work PC" },
        { name: "b", state: "running", closePolicy: "leave" },
      ],
      "a",
    )
    await mount(world)
    act(() => bridge.fire())
    await flush()
    expect(current().state.kind).toBe("waiting")
    world.set("a", { operation: null })
    await tick(1500)
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("a")
    expect(failed.message).toBe(copy("close.externalFailed", { operation: "stow", title: "Work PC" }))
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    // Not stowed again here, and `b` is never reached.
    expect(world.runs).toHaveLength(0)
    expect(world.log.filter((l) => l.endsWith(" b"))).toEqual([])
    act(() => root?.unmount())

    // A resume elsewhere ends, and the machine is still paused: it failed too.
    const again = fakeBridge()
    const held = fakeWinvm([{ name: "c", state: "paused", closePolicy: "leave", operation: "resume" }], "c")
    await mount(held)
    act(() => again.fire())
    await flush()
    expect(current().state.kind).toBe("waiting")
    held.set("c", { operation: null })
    await tick(1500)
    const stillHeld = current().state
    expect(stillHeld.kind === "failed" ? stillHeld.message : null).toBe(copy("close.externalFailed", { operation: "resume", title: "c" }))
    expect(again.count("close_cancel")).toBe(1)
    expect(again.count("close_complete")).toBe(0)
  })

  it("asks, instead of applying a remembered choice, after another process's command whose outcome its state can't show", async () => {
    // A save elsewhere leaves the machine running whether or not it worked: the person decides.
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running", closePolicy: "leave", operation: "save" }], "a")
    await mount(world)
    act(() => bridge.fire())
    await flush()
    world.set("a", { operation: null })
    await tick(1500)
    const asked = current().state
    expect(asked.kind === "asking" ? [asked.machine.name, asked.remember] : null).toEqual(["a", false])
    expect(bridge.count("close_complete")).toBe(0)
    act(() => current().choose("leave"))
    await flush()
    expect(bridge.count("close_complete")).toBe(1)
    act(() => root?.unmount())

    // A pause elsewhere that left it paused did what it does: the remembered choice applies.
    const again = fakeBridge()
    const paused = fakeWinvm([{ name: "b", state: "running", closePolicy: "leave", operation: "pause" }], "b")
    await mount(paused)
    act(() => again.fire())
    await flush()
    paused.set("b", { operation: null, state: "paused" })
    await tick(1500)
    expect(again.count("close_complete")).toBe(1)
  })

  it("does not take a failure from before the close as this close's", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running", closePolicy: "leave" }], "a")
    // `a`'s Save failed before the close began, and its error is still on screen: not this close's failure.
    world.busy = "save"
    world.finishLocal("a", 1, "an old failure")
    await mount(world)
    act(() => bridge.fire())
    await flush()
    expect(bridge.count("close_complete")).toBe(1)
    expect(bridge.count("close_cancel")).toBe(0)
  })

  it("lets the person cancel the close while it waits, without touching the operation it waited for", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running", operation: "stop" }], "a")
    await mount(world)
    act(() => bridge.fire())
    await flush()
    expect(current().state.kind).toBe("waiting")
    act(() => current().cancel())
    await flush()
    expect(current().state).toEqual({ kind: "idle" })
    expect(bridge.count("close_cancel")).toBe(1)
    // Nothing was run against it, and it is no longer polled.
    const reads = world.log.length
    await tick(6000)
    expect(world.log).toHaveLength(reads)
    expect(world.runs).toHaveLength(0)
    expect(bridge.log.filter((l) => l.startsWith("winvm"))).toEqual([])
    expect(bridge.count("close_complete")).toBe(0)
  })

  it("reads every machine again before exiting, as long as each read finds one newly live, then completes exactly once", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "stopped" },
        { name: "c", state: "stowed" },
      ],
      "a",
    )
    const asked = (): [string, number, number] | null => {
      const s = current().state
      return s.kind === "asking" ? [s.machine.name, s.index, s.total] : null
    }
    await mount(world)
    act(() => bridge.fire())
    await flush()
    expect(asked()).toEqual(["a", 1, 1])

    // `b` starts while `a` is asked about.
    world.set("b", { state: "running", agent: "silent" })
    act(() => current().choose("leave"))
    await flush()
    expect(asked()).toEqual(["b", 2, 2])

    // …and `c` while `b` is.
    world.set("c", { state: "running" })
    act(() => current().choose("leave"))
    await flush()
    expect(asked()).toEqual(["c", 3, 3])
    expect(bridge.count("close_complete")).toBe(0)

    act(() => current().choose("leave"))
    await flush()
    expect(world.log.filter((l) => l === "refreshAll")).toHaveLength(4)
    expect(bridge.count("close_complete")).toBe(1)
    await tick(10_000)
    expect(bridge.count("close_complete")).toBe(1)
    expect(world.log.filter((l) => l === "refreshAll")).toHaveLength(4)
  })

  it("acts through the latest Winvm the window rendered, never the one it first listened with", async () => {
    const bridge = fakeBridge()
    const first = fakeWinvm([{ name: "a", state: "running" }], "a")
    await mount(first)
    const later = fakeWinvm([{ name: "a", state: "running", closePolicy: "stow" }], "a")
    later.rerender = () => root?.render(<Probe w={later.snapshot()} />)
    act(() => later.rerender())
    act(() => bridge.fire())
    await flush()
    expect(first.log).toEqual([])
    expect(later.log).toEqual(["refreshAll", "refreshOne a", "runOn a stow"])
  })

  it("does not wedge on a rejection it did not expect: the close is called off and the next one can start", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running", closePolicy: "leave" }], "a")
    await mount(world)
    const invoke = (window as unknown as { __TAURI__: { core: { invoke(cmd: string, a?: unknown): Promise<unknown> } } }).__TAURI__.core
    const answer = invoke.invoke
    invoke.invoke = (cmd, a) => (cmd === "close_complete" ? Promise.reject("close complete arrived while the close was Idle") : answer(cmd, a))
    act(() => bridge.fire())
    await flush()
    const failed = current().state
    expect(failed.kind === "failed" ? failed.message : null).toBe("close complete arrived while the close was Idle")
    expect(bridge.count("close_cancel")).toBe(1)

    invoke.invoke = answer
    act(() => current().cancel())
    act(() => bridge.fire())
    await flush()
    expect(bridge.count("close_start")).toBe(2)
    expect(bridge.count("close_complete")).toBe(1)
  })
})

describe("useWinvm's lastOn", () => {
  it("tells how this window's last command on each machine ended, read now and kept per machine", async () => {
    jest.useFakeTimers()
    const answers: Record<string, { code: number; stdout: string; stderr: string }> = {
      "stow -i b": { code: 1, stdout: "", stderr: "winvm stow: the disk is full" },
      "stop -i a": { code: 0, stdout: "", stderr: "" },
      setup: { code: 3, stdout: "", stderr: "winvm setup: no network" },
    }
    const list = JSON.stringify({ instances: [statusOf({ name: "a", state: "running" }), statusOf({ name: "b", state: "running" })] })
    const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
      const args = a?.args ?? []
      if (cmd !== "winvm") return Promise.resolve(null)
      if (args[0] === "status") {
        const one = args.indexOf("-i")
        return Promise.resolve({ code: 0, stdout: one < 0 ? list : JSON.stringify(statusOf({ name: args[one + 1] ?? "a", state: "running" })), stderr: "" })
      }
      return Promise.resolve(answers[args.join(" ")] ?? { code: 1, stdout: "", stderr: "" })
    }
    Object.assign(window, { __TAURI__: { core: { invoke } } })
    const { useWinvm } = await import("../ui/src/features/winvm/useWinvm")
    let latest: Winvm | null = null
    function Host(): null {
      latest = useWinvm()
      return null
    }
    const host = document.createElement("div")
    document.body.append(host)
    const r = createRoot(host)
    root = r
    act(() => r.render(<Host />))
    await flush()
    const first = latest as Winvm | null
    if (first === null) throw new Error("not mounted")
    expect(first.name).toBe("a")
    expect(first.lastOn("a")).toBeNull()
    expect(first.lastOn("b")).toBeNull()

    await act(async () => {
      await first.runOn("b", "stow")
    })
    // Read now: even the first render's Winvm answers with what has happened since.
    const b = first.lastOn("b")
    expect(b === null ? null : { verb: b.verb, code: b.code, output: b.output }).toEqual({ verb: "stow", code: 1, output: "winvm stow: the disk is full" })
    expect(first.lastOn("a")).toBeNull()

    await act(async () => {
      await first.runOn("a", "stop")
    })
    const a = first.lastOn("a")
    expect(a?.code).toBe(0)
    expect((a?.seq ?? 0) > (b?.seq ?? 0)).toBe(true)
    // `b`'s failure stays `b`'s.
    expect(first.lastOn("b")?.code).toBe(1)

    // Setup names no machine: it is kept against the machine shown, whose commands wait for it.
    await act(async () => {
      await first.act("setup")
    })
    expect(first.lastOn("a")?.output).toBe("winvm setup: no network")
  })
})
