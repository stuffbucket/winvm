import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

import { rejectLikeTauri } from "./reject-like-tauri"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act, StrictMode } = await import("react")
const { createRoot } = await import("react-dom/client")
const { orderCloseQueue } = await import("../ui/src/features/close/closeQueue")
const { useCloseFlow } = await import("../ui/src/features/close/useCloseFlow")
const { useWinvm } = await import("../ui/src/features/winvm/useWinvm")
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
  readonly opId?: string
}

const statusOf = (m: Machine) => ({
  name: m.name,
  title: m.title ?? null,
  closePolicy: m.closePolicy ?? "ask",
  operation:
    m.operation == null
      ? null
      : {
          operation: m.operation,
          pid: 777,
          startedAt: "2026-11-12T10:00:00.000Z",
          ...(m.opId === undefined ? {} : { id: m.opId }),
        },
  state: m.state,
  vmStatus: null,
  image: "win11-arm64",
  pid:
    m.state === "running" || m.state === "paused" || m.state === "asleep"
      ? 4242
      : null,
  uptimeSeconds: null,
  cpus: 4,
  memoryMiB: 4096,
  screen: null,
  overlayBytes: null,
  guest:
    m.state === "running"
      ? { agent: m.agent ?? "ok", agentVersion: "9", os: "Windows 11" }
      : null,
  saves: { count: 0, bytes: 0 },
  keeper: null,
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

interface Command {
  machine: string
  verb: string
  op?: string | null
}

interface Snapshot {
  state: "idle" | "requested" | "running" | "authorized"
  machine: string | null
  command: Command | null
  last: (Command & { code: number; output: string }) | null
  resolved: string[]
  session: { kind: "waiting"; deadline: number } | { kind: "missed" } | null
  orphan?: Command | null
}

interface Recorded {
  ended: boolean
  ok: boolean | null
  exitCode: number | null
  output: string
}

const snapshotOf = (change: Partial<Snapshot>): Snapshot => ({
  state: "idle",
  machine: null,
  command: null,
  last: null,
  resolved: [],
  session: null,
  ...change,
})

function fakeBridge() {
  const log: string[] = []
  const listeners = new Map<string, ((e: { payload: unknown }) => void)[]>()
  const bridge = {
    log,
    pending: false as boolean | Deferred<boolean>,
    snapshot: null as Snapshot | null,
    stateFailures: 0,
    waitFailures: 0,
    wait: null as Deferred<Snapshot> | null,
    records: new Map<string, Recorded>(),
    start: "ok" as "ok" | "out-of-order",
    config: { code: 0, stdout: "", stderr: "" },
    fire(name = "viewer-close-requested", payload: unknown = null): void {
      for (const cb of listeners.get(name) ?? []) cb({ payload })
    },
    listening(name = "viewer-close-requested"): number {
      return listeners.get(name)?.length ?? 0
    },
    count(entry: string): number {
      return log.filter((l) => l === entry).length
    },
  }
  const invoke = (
    cmd: string,
    a?: { args?: string[]; machine?: string },
  ): Promise<unknown> => {
    if (cmd === "winvm") {
      const args = a?.args ?? []
      log.push(`winvm ${args.join(" ")}`)
      if (args[0] === "events") {
        const id = args[args.indexOf("--op") + 1] ?? ""
        const r = bridge.records.get(id)
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            id,
            operation: null,
            error: null,
            ...(r ?? { ended: false, ok: null, exitCode: null, output: "" }),
          }),
          stderr: "",
        })
      }
      return Promise.resolve(bridge.config)
    }
    if (cmd === "close_wait") {
      log.push(cmd)
      if (bridge.waitFailures > 0) {
        bridge.waitFailures -= 1
        return rejectLikeTauri("the window is reloading")
      }
      return bridge.wait === null
        ? Promise.resolve(bridge.snapshot)
        : bridge.wait.promise
    }
    if (cmd === "close_forget") {
      log.push(`close_forget ${String((a as { op?: string } | undefined)?.op)}`)
      return Promise.resolve(null)
    }
    log.push(a?.machine === undefined ? cmd : `${cmd} ${a.machine}`)
    if (cmd === "close_state") {
      if (bridge.stateFailures > 0) {
        bridge.stateFailures -= 1
        return rejectLikeTauri("the window is reloading")
      }
      if (bridge.snapshot !== null) return Promise.resolve(bridge.snapshot)
      const of = (pending: boolean): Snapshot =>
        snapshotOf({ state: pending ? "requested" : "idle" })
      return typeof bridge.pending === "boolean"
        ? Promise.resolve(of(bridge.pending))
        : bridge.pending.promise.then(of)
    }
    if (cmd === "close_start")
      return bridge.start === "ok"
        ? Promise.resolve(null)
        : rejectLikeTauri("close start arrived while the close was Idle")
    return Promise.resolve(null)
  }
  const listen = (
    name: string,
    cb: (e: { payload: unknown }) => void,
  ): Promise<() => void> => {
    log.push(`listen ${name}`)
    listeners.set(name, [...(listeners.get(name) ?? []), cb])
    return Promise.resolve(() => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((c) => c !== cb),
      )
    })
  }
  Object.assign(window, {
    __TAURI__: {
      core: { invoke },
      event: { listen, emit: () => Promise.resolve() },
    },
  })
  return bridge
}

const parsed = (m: Machine): Status => {
  const s = parseStatus(JSON.stringify(statusOf(m)))?.[0]
  if (s === undefined) throw new Error(`unparseable ${m.name}`)
  return s
}

function fakeWinvm(machines: Machine[], selected: string | null) {
  const log: string[] = []
  const runs: {
    name: string
    verb: Verb
    through: unknown
    done: Deferred<Ran | null>
  }[] = []
  const waiting = new Map<string, ((s: Status | null) => void)[]>()
  const world = {
    machines,
    name: selected,
    streaming: false,
    busy: null as Verb | null,
    all: "ok" as "ok" | "fail",
    log,
    runs,
    rerender: (): void => undefined,
    find(name: string): Machine | undefined {
      return world.machines.find((m) => m.name === name)
    },
    announce(name: string): void {
      const m = world.find(name)
      for (const wake of waiting.get(name) ?? [])
        wake(m === undefined ? null : parsed(m))
      waiting.delete(name)
    },
    set(name: string, change: Partial<Machine>): void {
      world.machines = world.machines.map((m) =>
        m.name === name ? { ...m, ...change } : m,
      )
    },
    settle(code: number, output = ""): void {
      const run = runs.find((r) => !settled.has(r))
      if (run === undefined) throw new Error("no action is running")
      settled.add(run)
      run.done.resolve({ verb: run.verb, code, output })
    },
    ranLocal(name: string, verb: Verb, code: number, output = ""): void {
      seq += 1
      outcomes.set(name, { verb, code, output, id: `local-op-${String(seq)}` })
    },
    finishLocal(name: string, code: number, output = ""): void {
      const verb = world.busy
      if (verb === null) throw new Error("no command of this window is running")
      seq += 1
      outcomes.set(name, { verb, code, output, id: `local-op-${String(seq)}` })
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
        operation:
          world.busy === null
            ? null
            : { operation: world.busy, source: "local" },
        failure: null,
        last: null,
        cliPath: null,
        streaming: world.streaming,
        nextStatus: (name: string, ms: number) => {
          log.push(`nextStatus ${name} ${String(ms)}`)
          return new Promise<Status | null>((resolve) => {
            const timer = setTimeout(() => {
              resolve(null)
            }, ms)
            waiting.set(name, [
              ...(waiting.get(name) ?? []),
              (s) => {
                clearTimeout(timer)
                resolve(s)
              },
            ])
          })
        },
        select: (name: string) => {
          log.push(`select ${name}`)
          world.name = name
          world.rerender()
        },
        act: () => Promise.resolve(null),
        runOn: (name: string, verb: Verb, _arg?: string, through?: unknown) => {
          log.push(`runOn ${name} ${verb}`)
          const done = deferred<Ran | null>()
          runs.push({ name, verb, through, done })
          return done.promise
        },
        lastOn: (name: string) => outcomes.get(name) ?? null,
        openScreenSharing: () => Promise.resolve(),
        installCommand: () => Promise.resolve(),
        dismissFailure: () => undefined,
        rename: () => Promise.resolve(null),
        setClosePolicy: (policy) => {
          if (world.name === null) return Promise.resolve(null)
          log.push(`setClosePolicy ${world.name} ${policy}`)
          world.set(world.name, { closePolicy: policy })
          return Promise.resolve(null)
        },
        refresh: () => Promise.resolve(),
        refreshAll: () => {
          log.push("refreshAll")
          return Promise.resolve(
            world.all === "ok" ? world.machines.map(parsed) : null,
          )
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
  const outcomes = new Map<string, Ran>()
  let seq = 0
  return world
}

type FakeWinvm = ReturnType<typeof fakeWinvm>

function WinvmHost({
  slot,
}: {
  readonly slot: { current: Winvm | null }
}): null {
  slot.current = useWinvm()
  return null
}

let root: ReturnType<typeof createRoot> | null = null
let flow: CloseFlow | null = null

function Probe({ w }: { readonly w: Winvm }): null {
  flow = useCloseFlow(w)
  return null
}

async function mount(world: FakeWinvm): Promise<void> {
  jest.useFakeTimers()
  const host = document.createElement("div")
  document.body.append(host)
  const r = createRoot(host)
  root = r
  world.rerender = () => {
    r.render(<Probe w={world.snapshot()} />)
  }
  act(() => {
    world.rerender()
  })
  await flush()
}

const current = (): CloseFlow => {
  if (flow === null) throw new Error("the flow is not mounted")
  return flow
}

describe("orderCloseQueue", () => {
  it("puts the selected live machine first, then the other live ones in list order", () => {
    const list = [
      statusOf({ name: "a", state: "running" }),
      statusOf({ name: "b", state: "running" }),
      statusOf({ name: "c", state: "running" }),
    ]
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
    expect(orderCloseQueue(list, null, new Set())).toEqual([
      "booting",
      "held",
      "sleepy",
      "up",
    ])
    expect(orderCloseQueue(list, "off", new Set())).toEqual([
      "booting",
      "held",
      "sleepy",
      "up",
    ])
    expect(orderCloseQueue(list, "booting", new Set())).toEqual([
      "booting",
      "held",
      "sleepy",
      "up",
    ])
  })

  it("leaves out machines already resolved, and a later recheck finds one that has since started", () => {
    const first = [
      statusOf({ name: "a", state: "running" }),
      statusOf({ name: "b", state: "stopped" }),
      statusOf({ name: "c", state: "running" }),
    ]
    expect(orderCloseQueue(first, "a", new Set(["a"]))).toEqual(["c"])
    const later = [
      statusOf({ name: "a", state: "running" }),
      statusOf({ name: "b", state: "running", agent: "silent" }),
      statusOf({ name: "c", state: "running" }),
    ]
    expect(orderCloseQueue(later, "c", new Set(["a", "c"]))).toEqual(["b"])
    expect(orderCloseQueue(later, "c", new Set(["a", "b", "c"]))).toEqual([])
  })
})

describe("useCloseFlow", () => {
  it("acknowledges a close request once, and a repeated request starts no second flow", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running" },
      ],
      "a",
    )
    await mount(world)
    expect(current().state).toEqual({ kind: "idle" })

    act(() => {
      bridge.fire()
    })
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
    expect(
      quiet.log.indexOf("listen viewer-close-requested"),
    ).toBeGreaterThanOrEqual(0)
    expect(quiet.log.indexOf("close_state")).toBeGreaterThan(
      quiet.log.indexOf("listen viewer-close-requested"),
    )
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
    const bridge = fakeBridge()
    const answer = deferred<boolean>()
    bridge.pending = answer
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    answer.resolve(true)
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    expect(world.log.filter((l) => l === "refreshAll")).toHaveLength(1)
    expect(current().state.kind).toBe("asking")
    act(() => root?.unmount())

    const late = fakeBridge()
    late.pending = true
    late.start = "out-of-order"
    const quiet = fakeWinvm([{ name: "a", state: "running" }], "a")
    await mount(quiet)
    expect(late.count("close_start")).toBe(1)
    expect(late.count("close_cancel")).toBe(0)
    expect(quiet.log).toEqual([])
    expect(current().state).toEqual({ kind: "idle" })
    late.start = "ok"
    act(() => {
      late.fire()
    })
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
    world.rerender = () => {
      r.render(
        <StrictMode>
          <Probe w={world.snapshot()} />
        </StrictMode>,
      )
    }
    act(() => {
      world.rerender()
    })
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    expect(bridge.listening()).toBe(1)
    act(() => {
      bridge.fire()
    })
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
    act(() => {
      bridge.fire()
    })
    await flush()

    const first = current().state
    expect(first.kind).toBe("asking")
    if (first.kind !== "asking") return
    expect(first.machine.name).toBe("c")
    expect(first.machine.title).toBe("Work PC")
    expect([first.index, first.total, first.remember]).toEqual([1, 2, false])
    expect(world.log).toEqual(["refreshAll", "refreshOne c"])

    act(() => {
      current().choose("leave")
    })
    await flush()
    const second = current().state
    expect(second.kind).toBe("asking")
    if (second.kind !== "asking") return
    expect(second.machine.name).toBe("a")
    expect([second.index, second.total, second.remember]).toEqual([2, 2, false])
    expect(world.log.slice(2)).toEqual(["select a", "refreshOne a"])
    expect(bridge.count("close_complete")).toBe(0)

    act(() => {
      current().choose("leave")
    })
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
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(bridge.count("close_complete")).toBe(0)
    expect(bridge.count("close_cancel")).toBe(1)
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.message).toBe(copy("close.statusFailed"))
    expect(failed.machine?.name).toBe("a")

    act(() => {
      current().cancel()
    })
    world.all = "ok"
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("asking")
    world.all = "fail"
    act(() => {
      current().choose("leave")
    })
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
    act(() => {
      bridge.fire()
    })
    await flush()

    const stowing = current().state
    expect(stowing.kind).toBe("acting")
    if (stowing.kind !== "acting") return
    expect([
      stowing.machine.name,
      stowing.policy,
      stowing.index,
      stowing.total,
    ]).toEqual(["b", "stow", 2, 3])
    expect(world.log).toEqual([
      "refreshAll",
      "refreshOne a",
      "select b",
      "refreshOne b",
      "runOn b stow",
    ])

    world.set("b", { state: "stowed" })
    world.settle(0)
    await flush()
    const stopping = current().state
    expect(stopping.kind).toBe("acting")
    if (stopping.kind !== "acting") return
    expect([
      stopping.machine.name,
      stopping.policy,
      stopping.index,
      stopping.total,
    ]).toEqual(["c", "shutdown", 3, 3])
    expect(world.log.slice(5)).toEqual([
      "select c",
      "refreshOne c",
      "runOn c stop",
    ])

    world.set("c", { state: "stopped" })
    world.settle(0)
    await flush()
    expect(world.log.slice(8)).toEqual(["refreshAll"])
    expect(bridge.count("close_complete")).toBe(1)
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
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("asking")
    act(() => {
      current().choose("stow")
    })
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow"])
    world.set("a", { state: "stowed" })
    world.settle(0)
    await flush()
    act(() => {
      current().choose("shutdown")
    })
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual([
      "a stow",
      "b stop",
    ])
    world.set("b", { state: "stopped" })
    world.settle(0)
    await flush()
    const last = current().state
    expect(last.kind === "asking" ? last.machine.name : null).toBe("c")
    act(() => {
      current().choose("leave")
    })
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
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("acting")
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
    act(() => {
      bridge.fire()
    })
    await flush()
    act(() => {
      current().choose("leave")
    })
    await flush()
    act(() => {
      current().choose("stow")
    })
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow"])
    act(() => {
      world.snapshot().select("b")
    })
    world.settle(1, "winvm stow: the disk is full")
    await flush()

    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("a")
    expect(failed.message).toBe("winvm stow: the disk is full")
    expect(world.name).toBe("a")
    expect(world.log.at(-1)).toBe("select a")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    expect(world.runs).toHaveLength(1)
    expect(world.log.filter((l) => l.includes(" c"))).toEqual([])

    act(() => {
      current().cancel()
    })
    act(() => {
      bridge.fire()
    })
    await flush()
    act(() => {
      current().choose("shutdown")
    })
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual([
      "a stow",
      "a stop",
    ])
    world.runs[1]?.done.resolve(null)
    await flush()
    const nothing = current().state
    expect(nothing.kind === "failed" ? nothing.message : null).toBe(
      copy("close.actionFailed", { title: "a" }),
    )
    expect(bridge.count("close_cancel")).toBe(2)
  })

  it("stays open with winvm's words when a remembered stow is refused because no recall could take it, and runs nothing else", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", closePolicy: "stow" },
        { name: "b", state: "running", closePolicy: "shutdown" },
      ],
      "a",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow"])
    const refusal =
      'Windows on "a" runs QEMU 11.0.0, and this winvm runs QEMU 11.1.2, so a stow of it could not be brought back; nothing was saved and Windows keeps running. Shut it down (`winvm stop -i a`) and start it again (`winvm start -i a`) to move it to this winvm\'s QEMU'
    world.settle(4, refusal)
    await flush()
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("a")
    expect(failed.message).toBe(refusal)
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    expect(world.runs).toHaveLength(1)
  })

  it("fails the same way when the machine it is about to resolve can't be read", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running", title: "Lab" },
      ],
      "a",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    world.machines = world.machines.filter((m) => m.name !== "b")
    act(() => {
      current().choose("leave")
    })
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
    const writes = (): string[] =>
      bridge.log.filter((l) => l.startsWith("winvm"))
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()

    act(() => {
      current().setRemember(true)
    })
    const checked = current().state
    expect(checked.kind === "asking" ? checked.remember : null).toBe(true)
    act(() => {
      current().choose("leave")
    })
    await flush()
    expect(writes()).toEqual(["winvm config -i a viewer.closePolicy=leave"])

    const second = current().state
    expect(
      second.kind === "asking" ? [second.machine.name, second.remember] : null,
    ).toEqual(["b", false])
    act(() => {
      current().setRemember(true)
    })
    act(() => {
      current().choose("stow")
    })
    await flush()
    expect(writes()).toHaveLength(1)
    world.set("b", { state: "stowed" })
    world.settle(0)
    await flush()
    expect(writes()).toEqual([
      "winvm config -i a viewer.closePolicy=leave",
      "winvm config -i b viewer.closePolicy=stow",
    ])

    const third = current().state
    expect(
      third.kind === "asking" ? [third.machine.name, third.remember] : null,
    ).toEqual(["c", false])
    act(() => {
      current().setRemember(true)
    })
    act(() => {
      current().choose("shutdown")
    })
    await flush()
    world.set("c", { state: "stopped" })
    world.settle(0)
    await flush()
    expect(writes().at(-1)).toBe(
      "winvm config -i c viewer.closePolicy=shutdown",
    )

    act(() => {
      current().setRemember(true)
    })
    act(() => {
      current().choose("stow")
    })
    await flush()
    world.settle(1, "no")
    await flush()
    expect(writes()).toHaveLength(3)
    expect(current().state.kind).toBe("failed")
  })

  it("stays open on the machine whose choice could not be remembered, with what winvm config said", async () => {
    const bridge = fakeBridge()
    bridge.config = {
      code: 2,
      stdout: "",
      stderr: "winvm config: settings folder is read-only",
    }
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running" },
      ],
      "b",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    act(() => {
      current().setRemember(true)
    })
    act(() => {
      current().choose("leave")
    })
    await flush()
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("b")
    expect(failed.message).toBe("winvm config: settings folder is read-only")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
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
    act(() => {
      bridge.fire()
    })
    await flush()
    world.set("a", { state: "stowed" })
    world.settle(0)
    await flush()
    expect(current().state.kind).toBe("asking")

    act(() => {
      current().setRemember(true)
    })
    act(() => {
      current().cancel()
    })
    await flush()
    expect(current().state).toEqual({ kind: "idle" })
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    expect(world.runs.map((r) => `${r.name} ${r.verb}`)).toEqual(["a stow"])
    expect(world.log.filter((l) => l.endsWith(" c"))).toEqual([])
    expect(bridge.log.filter((l) => l.startsWith("winvm"))).toEqual([])
    expect(world.name).toBe("b")

    act(() => {
      current().choose("stow")
    })
    await flush()
    expect(world.runs).toHaveLength(1)

    act(() => {
      bridge.fire()
    })
    await flush()
    expect(bridge.count("close_start")).toBe(2)
    const again = current().state
    expect(
      again.kind === "asking"
        ? [again.machine.name, again.index, again.total, again.remember]
        : null,
    ).toEqual(["b", 1, 2, false])
  })

  it("can't be cancelled while its own stow or shutdown runs", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    act(() => {
      current().choose("shutdown")
    })
    await flush()
    act(() => {
      current().cancel()
    })
    await flush()
    expect(current().state.kind).toBe("acting")
    expect(bridge.count("close_cancel")).toBe(0)
    act(() => {
      bridge.fire()
    })
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
    act(() => {
      bridge.fire()
    })
    await flush()
    const waiting = current().state
    expect(waiting.kind).toBe("waiting")
    if (waiting.kind !== "waiting") return
    expect([
      waiting.machine.name,
      waiting.operation,
      waiting.index,
      waiting.total,
    ]).toEqual(["a", { operation: "save", source: "external" }, 1, 2])

    await tick(1500)
    expect(current().state.kind).toBe("waiting")
    expect(world.log.filter((l) => l === "refreshOne a")).toHaveLength(2)

    world.set("a", { operation: null })
    await tick(1500)
    expect(current().state.kind).toBe("asking")
    act(() => {
      current().choose("leave")
    })
    await flush()

    expect(current().state.kind).toBe("waiting")
    world.set("b", { operation: null, state: "stowed" })
    await tick(1500)
    expect(bridge.count("close_complete")).toBe(1)
    expect(world.runs).toHaveLength(0)
  })

  it("with the event stream up, waits for an operation it did not start without reading it again until a read after an event shows it ended", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [{ name: "a", state: "running", operation: "stow" }],
      "a",
    )
    world.streaming = true
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("waiting")
    await tick(15_000)
    expect(current().state.kind).toBe("waiting")
    expect(world.log.filter((l) => l === "refreshOne a")).toHaveLength(1)
    expect(world.log).toContain("nextStatus a 20000")

    world.set("a", { operation: null, state: "stowed" })
    world.announce("a")
    await flush()
    expect(world.log.filter((l) => l === "refreshOne a")).toHaveLength(1)
    expect(bridge.count("close_complete")).toBe(1)
  })

  it("with the event stream up, reads the machine itself when no event has come for a while", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [{ name: "a", state: "running", operation: "save" }],
      "a",
    )
    world.streaming = true
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    world.set("a", { operation: null })
    await tick(15_000)
    expect(current().state.kind).toBe("waiting")
    expect(world.log.filter((l) => l === "refreshOne a")).toHaveLength(1)
    await tick(5000)
    expect(world.log.filter((l) => l === "refreshOne a")).toHaveLength(2)
    expect(current().state.kind).toBe("asking")
  })

  it("waits for this window's own command on the machine too", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    world.busy = "pause"
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    const waiting = current().state
    expect(waiting.kind === "waiting" ? waiting.operation : null).toEqual({
      operation: "pause",
      source: "local",
    })
    world.busy = null
    world.set("a", { state: "paused" })
    act(() => {
      world.rerender()
    })
    await tick(1500)
    const asking = current().state
    expect(asking.kind === "asking" ? phaseOf(asking.machine) : null).toBe(
      "paused",
    )
  })

  it("calls the close off when this window's own command it waited for fails, leaving that command's error to read", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", closePolicy: "leave" },
        { name: "b", state: "running", closePolicy: "stow" },
      ],
      "a",
    )
    world.busy = "stop"
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("waiting")

    act(() => {
      world.finishLocal(
        "a",
        1,
        "winvm stop: Windows didn't shut down in 180 seconds",
      )
    })
    await tick(1500)
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("a")
    expect(failed.message).toBe(
      "winvm stop: Windows didn't shut down in 180 seconds",
    )
    expect(world.name).toBe("a")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    expect(world.runs).toHaveLength(0)
    expect(world.log.filter((l) => l.endsWith(" b"))).toEqual([])
  })

  it("calls the close off when the record says another process's command it waited for failed", async () => {
    const bridge = fakeBridge()
    bridge.records.set("ext-stow-1", {
      ended: true,
      ok: false,
      exitCode: 1,
      output: "",
    })
    const world = fakeWinvm(
      [
        {
          name: "a",
          state: "running",
          closePolicy: "stow",
          operation: "stow",
          opId: "ext-stow-1",
          title: "Work PC",
        },
        { name: "b", state: "running", closePolicy: "leave" },
      ],
      "a",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("waiting")
    world.set("a", { operation: null })
    await tick(1500)
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("a")
    expect(failed.message).toBe(
      copy("close.externalFailed", { operation: "stow", title: "Work PC" }),
    )
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    expect(world.runs).toHaveLength(0)
    expect(world.log.filter((l) => l.endsWith(" b"))).toEqual([])
    act(() => root?.unmount())

    const again = fakeBridge()
    again.records.set("ext-resume-1", {
      ended: true,
      ok: false,
      exitCode: 1,
      output: "::error::guest did not answer after resuming",
    })
    const held = fakeWinvm(
      [
        {
          name: "c",
          state: "paused",
          closePolicy: "leave",
          operation: "resume",
          opId: "ext-resume-1",
        },
      ],
      "c",
    )
    await mount(held)
    act(() => {
      again.fire()
    })
    await flush()
    expect(current().state.kind).toBe("waiting")
    held.set("c", { operation: null })
    await tick(1500)
    const stillHeld = current().state
    expect(stillHeld.kind === "failed" ? stillHeld.message : null).toBe(
      "::error::guest did not answer after resuming",
    )
    expect(again.count("close_cancel")).toBe(1)
    expect(again.count("close_complete")).toBe(0)
  })

  it("asks, instead of applying a remembered choice, after another process's command whose end the record does not hold", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        {
          name: "a",
          state: "running",
          closePolicy: "leave",
          operation: "save",
        },
      ],
      "a",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    world.set("a", { operation: null })
    await tick(1500)
    const asked = current().state
    expect(
      asked.kind === "asking" ? [asked.machine.name, asked.remember] : null,
    ).toEqual(["a", false])
    expect(bridge.count("close_complete")).toBe(0)
    act(() => {
      current().choose("leave")
    })
    await flush()
    expect(bridge.count("close_complete")).toBe(1)
    act(() => root?.unmount())

    const again = fakeBridge()
    again.records.set("ext-pause-1", {
      ended: true,
      ok: true,
      exitCode: 0,
      output: "",
    })
    const paused = fakeWinvm(
      [
        {
          name: "b",
          state: "running",
          closePolicy: "leave",
          operation: "pause",
          opId: "ext-pause-1",
        },
      ],
      "b",
    )
    await mount(paused)
    act(() => {
      again.fire()
    })
    await flush()
    paused.set("b", { operation: null, state: "paused" })
    await tick(1500)
    expect(again.count("close_complete")).toBe(1)
  })

  it("calls the close off when the record says another process's command failed though the machine looks as it would after it", async () => {
    const bridge = fakeBridge()
    bridge.records.set("ext-start-1", {
      ended: true,
      ok: false,
      exitCode: 1,
      output: "::error::guest never became ready",
    })
    const world = fakeWinvm(
      [
        {
          name: "a",
          state: "running",
          closePolicy: "leave",
          operation: "start",
          opId: "ext-start-1",
        },
      ],
      "a",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    world.set("a", { operation: null })
    await tick(1500)
    const failed = current().state
    expect(failed.kind === "failed" ? failed.message : null).toBe(
      "::error::guest never became ready",
    )
    expect(bridge.log).toContain("winvm events -i a --op ext-start-1 --json")
    expect(bridge.count("close_complete")).toBe(0)
  })

  it("goes on after another process's start that restored Windows, which is still busy", async () => {
    const bridge = fakeBridge()
    bridge.records.set("ext-start-2", {
      ended: true,
      ok: false,
      exitCode: 6,
      output: "warning: Windows is still busy; it was restored",
    })
    const world = fakeWinvm(
      [
        {
          name: "a",
          state: "running",
          closePolicy: "leave",
          operation: "start",
          opId: "ext-start-2",
        },
      ],
      "a",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    world.set("a", { operation: null })
    await tick(1500)
    expect(bridge.count("close_complete")).toBe(1)
    expect(bridge.count("close_cancel")).toBe(0)
  })

  it("calls the close off when this window's command on a machine not yet reached fails while another is asked about", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running", closePolicy: "stow" },
      ],
      "a",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("asking")
    world.ranLocal(
      "b",
      "stop",
      1,
      "winvm stop: Windows didn't shut down in 180 seconds",
    )
    act(() => {
      current().choose("leave")
    })
    await flush()
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("b")
    expect(failed.message).toBe(
      "winvm stop: Windows didn't shut down in 180 seconds",
    )
    expect(world.name).toBe("b")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    expect(world.runs).toHaveLength(0)
  })

  it("does not take a failure from before the close as this close's", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running", closePolicy: "leave" },
        { name: "b", state: "running", closePolicy: "leave" },
      ],
      "a",
    )
    world.ranLocal("b", "stop", 1, "an old failure on b")
    world.busy = "save"
    world.finishLocal("a", 1, "an old failure")
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(bridge.count("close_complete")).toBe(1)
    expect(bridge.count("close_cancel")).toBe(0)
  })

  it("lets the person cancel the close while it waits, without touching the operation it waited for", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [{ name: "a", state: "running", operation: "stop" }],
      "a",
    )
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("waiting")
    act(() => {
      current().cancel()
    })
    await flush()
    expect(current().state).toEqual({ kind: "idle" })
    expect(bridge.count("close_cancel")).toBe(1)
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
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(asked()).toEqual(["a", 1, 1])

    world.set("b", { state: "running", agent: "silent" })
    act(() => {
      current().choose("leave")
    })
    await flush()
    expect(asked()).toEqual(["b", 2, 2])

    world.set("c", { state: "running" })
    act(() => {
      current().choose("leave")
    })
    await flush()
    expect(asked()).toEqual(["c", 3, 3])
    expect(bridge.count("close_complete")).toBe(0)

    act(() => {
      current().choose("leave")
    })
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
    const later = fakeWinvm(
      [{ name: "a", state: "running", closePolicy: "stow" }],
      "a",
    )
    later.rerender = () => root?.render(<Probe w={later.snapshot()} />)
    act(() => {
      later.rerender()
    })
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(first.log).toEqual([])
    expect(later.log).toEqual(["refreshAll", "refreshOne a", "runOn a stow"])
  })

  it("does not wedge on a rejection it did not expect: the close is called off and the next one can start", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [{ name: "a", state: "running", closePolicy: "leave" }],
      "a",
    )
    await mount(world)
    const invoke = (
      window as unknown as {
        __TAURI__: {
          core: { invoke: (cmd: string, a?: unknown) => Promise<unknown> }
        }
      }
    ).__TAURI__.core
    const answer = invoke.invoke
    invoke.invoke = (cmd, a) =>
      cmd === "close_complete"
        ? rejectLikeTauri("close complete arrived while the close was Idle")
        : answer(cmd, a)
    act(() => {
      bridge.fire()
    })
    await flush()
    const failed = current().state
    expect(failed.kind === "failed" ? failed.message : null).toBe(
      "close complete arrived while the close was Idle",
    )
    expect(bridge.count("close_cancel")).toBe(1)

    invoke.invoke = answer
    act(() => {
      current().cancel()
    })
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(bridge.count("close_start")).toBe(2)
    expect(bridge.count("close_complete")).toBe(1)
  })
})

describe("useCloseFlow after the window reloads", () => {
  it("runs the close's own stow and stop through the close, records where it is, and what it resolved", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running", closePolicy: "stow" },
      ],
      "a",
    )
    const { closeRun } = await import("../ui/src/backend")
    await mount(world)
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(bridge.log).toContain("close_at a")
    act(() => {
      current().choose("leave")
    })
    await flush()
    expect(bridge.log).toContain("close_resolved a")
    expect(bridge.log).toContain("close_at b")
    expect(world.runs.map((r) => [r.name, r.verb, r.through])).toEqual([
      ["b", "stow", closeRun],
    ])
    world.set("b", { state: "stowed" })
    world.settle(0)
    await flush()
    expect(bridge.log).toContain("close_resolved b")
    expect(bridge.count("close_complete")).toBe(1)
  })

  it("picks up a close Rust is still running: shows the stow the old page started, waits for it without starting another, then goes on past what was resolved", async () => {
    const bridge = fakeBridge()
    bridge.snapshot = snapshotOf({
      state: "running",
      machine: "b",
      command: { machine: "b", verb: "stow" },
      resolved: ["a"],
    })
    const wait = deferred<Snapshot>()
    bridge.wait = wait
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running", operation: "stow" },
        { name: "c", state: "running", title: "Lab" },
      ],
      "a",
    )
    await mount(world)
    expect(bridge.count("close_start")).toBe(0)
    const acting = current().state
    expect(acting.kind).toBe("acting")
    if (acting.kind !== "acting") return
    expect([acting.machine.name, acting.policy]).toEqual(["b", "stow"])
    expect(world.name).toBe("b")

    await tick(1500)
    await tick(1500)
    expect(current().state.kind).toBe("acting")
    expect(world.runs).toHaveLength(0)
    expect(bridge.count("close_complete")).toBe(0)
    expect(bridge.count("close_cancel")).toBe(0)
    expect(bridge.count("close_wait")).toBe(1)
    expect(bridge.count("close_state")).toBe(1)

    world.set("b", { state: "stowed", operation: null })
    wait.resolve(
      snapshotOf({
        state: "running",
        last: { machine: "b", verb: "stow", code: 0, output: "" },
        resolved: ["a"],
      }),
    )
    await flush()
    const next = current().state
    expect(next.kind === "asking" ? next.machine.name : null).toBe("c")
    expect(world.runs).toHaveLength(0)
    expect(world.log.filter((l) => l === "refreshOne a")).toEqual([])
    act(() => {
      current().choose("leave")
    })
    await flush()
    expect(bridge.count("close_complete")).toBe(1)
  })

  it("keeps waiting for the stow the old page started when a read of the close fails, instead of dropping a close Rust still runs", async () => {
    const bridge = fakeBridge()
    bridge.snapshot = snapshotOf({
      state: "running",
      machine: "a",
      command: { machine: "a", verb: "stow" },
    })
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    bridge.waitFailures = 2
    const wait = deferred<Snapshot>()
    await mount(world)
    expect(current().state.kind).toBe("acting")
    bridge.wait = wait
    await tick(1500)
    await tick(1500)
    expect(current().state.kind).toBe("acting")
    expect(bridge.count("close_cancel")).toBe(0)
    world.set("a", { state: "stowed" })
    wait.resolve(
      snapshotOf({
        state: "running",
        last: { machine: "a", verb: "stow", code: 0, output: "" },
      }),
    )
    await flush()
    expect(bridge.count("close_complete")).toBe(1)
    expect(bridge.count("close_cancel")).toBe(0)
  })

  it("stays open with what the command said when the stow the old page started failed, and calls the close off", async () => {
    const bridge = fakeBridge()
    bridge.snapshot = snapshotOf({
      state: "running",
      machine: "b",
      last: {
        machine: "b",
        verb: "stow",
        code: 1,
        output: "winvm stow: the disk is full",
      },
    })
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running" },
      ],
      "a",
    )
    await mount(world)
    const failed = current().state
    expect(failed.kind).toBe("failed")
    if (failed.kind !== "failed") return
    expect(failed.machine?.name).toBe("b")
    expect(failed.message).toBe("winvm stow: the disk is full")
    expect(world.name).toBe("b")
    expect(bridge.count("close_cancel")).toBe(1)
    expect(bridge.count("close_complete")).toBe(0)
    expect(world.runs).toHaveLength(0)
  })

  it("takes how the old page's stow ended from the record by its op id, not from a command cut off with the page", async () => {
    const bridge = fakeBridge()
    bridge.records.set("close-op-1", {
      ended: true,
      ok: true,
      exitCode: 0,
      output: 'stowed "b"',
    })
    bridge.snapshot = snapshotOf({
      state: "running",
      machine: "b",
      last: {
        machine: "b",
        verb: "stow",
        op: "close-op-1",
        code: -1,
        output: "winvm stow on b stopped without saying how it ended",
      },
    })
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "stowed" },
      ],
      "a",
    )
    await mount(world)
    const next = current().state
    expect(next.kind === "asking" ? next.machine.name : null).toBe("a")
    expect(bridge.count("close_cancel")).toBe(0)
    expect(bridge.log).toContain("winvm events -i b --op close-op-1 --json")
  })

  it("starts again at the machine the close had reached when nothing was running", async () => {
    const bridge = fakeBridge()
    bridge.snapshot = snapshotOf({ state: "running", machine: "c" })
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running" },
        { name: "c", state: "running" },
      ],
      "a",
    )
    await mount(world)
    expect(bridge.count("close_start")).toBe(0)
    const asked = current().state
    expect(
      asked.kind === "asking"
        ? [asked.machine.name, asked.index, asked.total]
        : null,
    ).toEqual(["c", 1, 3])
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(world.log.filter((l) => l === "refreshAll")).toHaveLength(1)
  })

  it("lets a close it picked up be cancelled, which frees the next close to start", async () => {
    const bridge = fakeBridge()
    bridge.snapshot = snapshotOf({ state: "running" })
    await mount(fakeWinvm([{ name: "a", state: "running" }], "a"))
    expect(current().state.kind).toBe("asking")
    act(() => {
      current().cancel()
    })
    await flush()
    expect(bridge.count("close_cancel")).toBe(1)
    bridge.snapshot = null
    act(() => {
      bridge.fire()
    })
    await flush()
    expect(bridge.count("close_start")).toBe(1)
    expect(current().state.kind).toBe("asking")
  })
})

describe("useCloseFlow after the app was quit during a close", () => {
  it("follows the close's last stow by its op id and says it did not finish, then lets it go", async () => {
    const bridge = fakeBridge()
    bridge.records.set("orphan-op-1", {
      ended: true,
      ok: false,
      exitCode: 1,
      output: "::error::the disk is full",
    })
    bridge.snapshot = snapshotOf({
      orphan: { machine: "b", verb: "stow", op: "orphan-op-1" },
    })
    const world = fakeWinvm(
      [
        { name: "a", state: "running" },
        { name: "b", state: "running" },
      ],
      "a",
    )
    await mount(world)
    const failed = current().state
    expect(failed.kind === "failed" ? failed.message : null).toBe(
      "::error::the disk is full",
    )
    expect(world.name).toBe("b")
    expect(bridge.log).toContain(
      "winvm events -i b --op orphan-op-1 --json --follow",
    )
    expect(bridge.log).toContain("close_forget orphan-op-1")
  })

  it("says nothing of a stow that finished, and lets it go", async () => {
    const bridge = fakeBridge()
    bridge.records.set("orphan-op-2", {
      ended: true,
      ok: true,
      exitCode: 0,
      output: "",
    })
    bridge.snapshot = snapshotOf({
      orphan: { machine: "a", verb: "stow", op: "orphan-op-2" },
    })
    await mount(fakeWinvm([{ name: "a", state: "stowed" }], "a"))
    expect(current().state.kind).toBe("idle")
    expect(bridge.log).toContain("close_forget orphan-op-2")
  })
})

describe("useCloseFlow at logout, restart and shutdown", () => {
  const deadline = 1_800_000_040_000

  it("shows how long macOS waits while it closes for a logout, and drops it when the close is called off", async () => {
    const bridge = fakeBridge()
    await mount(fakeWinvm([{ name: "a", state: "running" }], "a"))
    expect(current().session).toBeNull()
    act(() => {
      bridge.fire("viewer-close-session", { kind: "waiting", deadline })
      bridge.fire()
    })
    await flush()
    expect(current().session).toEqual({ kind: "waiting", deadline })
    expect(current().state.kind).toBe("asking")
    act(() => {
      current().cancel()
    })
    await flush()
    expect(current().session).toBeNull()
    expect(bridge.count("close_cancel")).toBe(1)
  })

  it("keeps closing after macOS stops waiting, and says the logout was called off", async () => {
    const bridge = fakeBridge()
    await mount(fakeWinvm([{ name: "a", state: "running" }], "a"))
    act(() => {
      bridge.fire("viewer-close-session", { kind: "waiting", deadline })
      bridge.fire()
    })
    await flush()
    act(() => {
      bridge.fire("viewer-close-session", { kind: "missed" })
    })
    await flush()
    expect(current().session).toEqual({ kind: "missed" })
    expect(current().state.kind).toBe("asking")
    expect(bridge.count("close_cancel")).toBe(0)
    act(() => {
      current().choose("leave")
    })
    await flush()
    expect(bridge.count("close_complete")).toBe(1)
  })

  it("drops the deadline when the close fails", async () => {
    const bridge = fakeBridge()
    const world = fakeWinvm([{ name: "a", state: "running" }], "a")
    world.all = "fail"
    await mount(world)
    act(() => {
      bridge.fire("viewer-close-session", { kind: "waiting", deadline })
      bridge.fire()
    })
    await flush()
    expect(current().state.kind).toBe("failed")
    expect(current().session).toBeNull()
  })

  it("ignores a deadline it cannot read", async () => {
    const bridge = fakeBridge()
    await mount(fakeWinvm([{ name: "a", state: "running" }], "a"))
    act(() => {
      bridge.fire("viewer-close-session", { kind: "waiting" })
    })
    await flush()
    expect(current().session).toBeNull()
    act(() => {
      bridge.fire("viewer-close-session", { kind: "waiting", deadline })
      bridge.fire("viewer-close-session", { kind: "later", deadline: "soon" })
    })
    await flush()
    expect(current().session).toEqual({ kind: "waiting", deadline })
  })

  it("picks the deadline up again after a reload", async () => {
    const bridge = fakeBridge()
    bridge.snapshot = snapshotOf({
      state: "requested",
      session: { kind: "waiting", deadline },
    })
    await mount(fakeWinvm([{ name: "a", state: "running" }], "a"))
    expect(current().session).toEqual({ kind: "waiting", deadline })
    expect(bridge.count("close_start")).toBe(1)
  })
})

describe("useWinvm's lastOn", () => {
  it("tells how this window's last command on each machine ended, read now and kept per machine", async () => {
    jest.useFakeTimers()
    const answers: Record<
      string,
      { code: number; stdout: string; stderr: string }
    > = {
      "stow -i b": {
        code: 1,
        stdout: "",
        stderr: "winvm stow: the disk is full",
      },
      "stop -i a": { code: 0, stdout: "", stderr: "" },
      setup: { code: 3, stdout: "", stderr: "winvm setup: no network" },
    }
    const list = JSON.stringify({
      instances: [
        statusOf({ name: "a", state: "running" }),
        statusOf({ name: "b", state: "running" }),
      ],
    })
    const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
      const args = a?.args ?? []
      if (cmd !== "winvm") return Promise.resolve(null)
      if (args[0] === "status") {
        const one = args.indexOf("-i")
        return Promise.resolve({
          code: 0,
          stdout:
            one < 0
              ? list
              : JSON.stringify(
                  statusOf({ name: args[one + 1] ?? "a", state: "running" }),
                ),
          stderr: "",
        })
      }
      const named = args.indexOf("--op-id")
      const asked = named < 0 ? args : args.slice(0, named)
      return Promise.resolve(
        answers[asked.join(" ")] ?? { code: 1, stdout: "", stderr: "" },
      )
    }
    Object.assign(window, { __TAURI__: { core: { invoke } } })
    const slot: { current: Winvm | null } = { current: null }
    const host = document.createElement("div")
    document.body.append(host)
    const r = createRoot(host)
    root = r
    act(() => {
      r.render(<WinvmHost slot={slot} />)
    })
    await flush()
    const first = slot.current
    if (first === null) throw new Error("not mounted")
    expect(first.name).toBe("a")
    expect(first.lastOn("a")).toBeNull()
    expect(first.lastOn("b")).toBeNull()

    await act(async () => {
      await first.runOn("b", "stow")
    })
    const b = first.lastOn("b")
    expect(
      b === null ? null : { verb: b.verb, code: b.code, output: b.output },
    ).toEqual({ verb: "stow", code: 1, output: "winvm stow: the disk is full" })
    expect(first.lastOn("a")).toBeNull()

    await act(async () => {
      await first.runOn("a", "stop")
    })
    const a = first.lastOn("a")
    expect(a?.code).toBe(0)
    expect(typeof a?.id).toBe("string")
    expect(a?.id).not.toBe(b?.id)
    expect(first.lastOn("b")?.code).toBe(1)

    await act(async () => {
      await first.act("setup")
    })
    expect(first.lastOn("a")?.output).toBe("winvm setup: no network")
  })

  it("runs a command through the runner it is given instead of winvm, and records it the same way", async () => {
    jest.useFakeTimers()
    const asked: string[] = []
    const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
      const args = a?.args ?? []
      asked.push(`${cmd} ${args.join(" ")}`)
      if (cmd === "winvm" && args[0] === "status")
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            instances: [statusOf({ name: "a", state: "running" })],
          }),
          stderr: "",
        })
      return Promise.resolve({ code: 0, stdout: "", stderr: "" })
    }
    Object.assign(window, { __TAURI__: { core: { invoke } } })
    const slot: { current: Winvm | null } = { current: null }
    const host = document.createElement("div")
    document.body.append(host)
    const r = createRoot(host)
    root = r
    act(() => {
      r.render(<WinvmHost slot={slot} />)
    })
    await flush()
    const w = slot.current
    if (w === null) throw new Error("not mounted")
    const through: string[][] = []
    await act(async () => {
      await w.runOn("a", "stow", undefined, (...args) => {
        through.push(args)
        return Promise.resolve({ code: 3, stdout: "", stderr: "no room" })
      })
    })
    expect(through).toEqual([
      ["stow", "-i", "a", "--op-id", w.lastOn("a")?.id ?? "?"],
    ])
    expect(asked.filter((l) => l.startsWith("winvm stow"))).toEqual([])
    expect(w.lastOn("a")?.code).toBe(3)
    expect(w.lastOn("a")?.output).toBe("no room")
  })
})
