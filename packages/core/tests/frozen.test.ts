import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer, type Server } from "node:net"
import { resolve } from "node:path"
import * as agent from "../src/agent"
import { parseArgs } from "../src/args"
import {
  type RunningStartSeams,
  type StopCommandSeams,
  startRunning,
  stopWith,
} from "../src/commands"
import { configPath, parseAssignment, writeAssignments } from "../src/config"
import {
  appendEntry,
  type Cursor,
  readSince,
  START,
  waitForEvent,
} from "../src/eventlog"
import { filesCmd } from "../src/finder"
import {
  clearAsleep,
  frozenFrom,
  frozenState,
  GuestFrozen,
  isFrozenRunState,
  markAsleep,
  markedAsleep,
  refuseFrozen,
} from "../src/frozen"
import { QmpError, QmpNotDelivered } from "../src/monitor"
import {
  markSavingRunning,
  STOP_UNFINISHED,
  savingRunning,
  withOperation,
} from "../src/operation"
import { pathsFor } from "../src/paths"
import { processStart } from "../src/proc"
import { deriveState, gather } from "../src/status"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"
import { FakeQmp } from "./fakes/qmp"

const NAME = "frozen-test"
let home: string
let savedHome: string | undefined
let fake: FakeQmp
let runState = "running"
let qemuPid = 0

beforeAll(async () => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync("/tmp/wvfz-")
  process.env.WINVM_HOME = home
  const p = pathsFor(NAME)
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(
    p.meta,
    JSON.stringify({
      image: "win11-arm64",
      vnc: 9,
      created: new Date().toISOString(),
    }),
  )
  qemuPid = (await lockPidfile(p.pid, "qemu-system-aarch64")).pid
  fake = new FakeQmp(p.qmp)
  fake.handler = (cmd) =>
    cmd.execute === "query-status"
      ? { return: { status: runState, running: runState === "running" } }
      : { return: {} }
  await fake.listen()
})

afterAll(async () => {
  await fake.close()
  await releasePidfiles()
  rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
})

afterEach(() => {
  runState = "running"
  clearAsleep(pathsFor(NAME))
  fake.commands.length = 0
})

describe("run states", () => {
  it("counts paused, suspended and postmigrate as frozen, nothing else", () => {
    for (const s of ["paused", "suspended", "postmigrate"])
      expect(isFrozenRunState(s)).toBe(true)
    for (const s of [
      "running",
      "finish-migrate",
      "inmigrate",
      "prelaunch",
      "unknown",
    ])
      expect(isFrozenRunState(s)).toBe(false)
    expect(isFrozenRunState(null)).toBe(false)
  })

  it("tells asleep from paused by the mark", () => {
    expect(frozenFrom("paused", false)).toBe("paused")
    expect(frozenFrom("paused", true)).toBe("asleep")
    expect(frozenFrom("running", true)).toBeNull()
  })

  it("reports a save of a paused guest (postmigrate) as paused, not running", () => {
    expect(deriveState(true, "postmigrate", [])).toBe("paused")
    expect(deriveState(true, "paused", [], true)).toBe("asleep")
    expect(deriveState(true, "running", [], true)).toBe("running")
    expect(deriveState(true, null, [])).toBe("running")
    expect(deriveState(false, "paused", [], true)).toBe("stopped")
  })
})

describe("a save of a running guest", () => {
  it("is running, not paused, through its stop and postmigrate", () => {
    expect(deriveState(true, "paused", [], false, true)).toBe("running")
    expect(deriveState(true, "postmigrate", [], false, true)).toBe("running")
    expect(deriveState(true, "postmigrate", [], false, false)).toBe("paused")
    expect(deriveState(false, null, [], false, true)).toBe("stopped")
  })

  it("is marked on the saving command's lease, and the mark of a process gone counts for nothing", async () => {
    expect(savingRunning(NAME)).toBe(false)
    await withOperation(NAME, "save", () => {
      markSavingRunning(NAME)
      expect(savingRunning(NAME)).toBe(true)
    })
    expect(savingRunning(NAME)).toBe(false)
    const lease = {
      operation: "save",
      id: "dead",
      pid: 2 ** 22 + 12_345,
      pidStart: null,
      startedAt: "2026-03-03T00:00:00.000Z",
      instance: NAME,
      automatic: false,
      savingRunning: true,
    }
    writeFileSync(pathsFor(NAME).lease, JSON.stringify(lease))
    expect(savingRunning(NAME)).toBe(false)
    rmSync(pathsFor(NAME).lease, { force: true })
  })

  it("status says running while the save holds it stopped, and does not wait on its guest agent", async () => {
    runState = "postmigrate"
    await withOperation(NAME, "save", async () => {
      markSavingRunning(NAME)
      const t0 = Date.now()
      const s = await gather(NAME, true)
      expect(s.state).toBe("running")
      expect(s.vmStatus).toBe("postmigrate")
      expect(s.guest).toBeNull()
      expect(Date.now() - t0).toBeLessThan(1500)
    })
    expect((await gather(NAME, false)).state).toBe("paused")
  })
})

describe("the asleep mark", () => {
  it("applies only to the QEMU process it names", () => {
    const p = pathsFor(NAME)
    expect(markedAsleep(p, process.pid)).toBe(false)
    markAsleep(p, process.pid)
    expect(markedAsleep(p, process.pid)).toBe(true)
    expect(markedAsleep(p, process.pid + 1)).toBe(false)
    expect(markedAsleep(p, null)).toBe(false)
    clearAsleep(p)
    expect(markedAsleep(p, process.pid)).toBe(false)
  })

  it("reads paused or asleep from QEMU and the mark", async () => {
    const p = pathsFor(NAME)
    expect(await frozenState(p)).toBeNull()
    runState = "paused"
    expect(await frozenState(p)).toBe("paused")
    markAsleep(p, qemuPid)
    expect(await frozenState(p)).toBe("asleep")
  })
})

describe("nothing calls into a frozen guest", () => {
  it("refuses with GuestFrozen, saying how to resume or wake", async () => {
    await refuseFrozen(NAME)
    runState = "paused"
    const paused = await refuseFrozen(NAME).catch((e: unknown) => e)
    expect(paused).toBeInstanceOf(GuestFrozen)
    expect((paused as GuestFrozen).state).toBe("paused")
    expect((paused as Error).message).toContain("winvm resume -i frozen-test")
    markAsleep(pathsFor(NAME), qemuPid)
    const asleep = await refuseFrozen(NAME).catch((e: unknown) => e)
    expect((asleep as GuestFrozen).state).toBe("asleep")
    expect((asleep as Error).message).toContain("winvm wake -i frozen-test")
  })

  it("agent.ensure refuses at once: no waiting on the agent, no qemu-ga, no reinstall, never cont", async () => {
    runState = "paused"
    const t0 = Date.now()
    const got = await agent
      .ensure(NAME, { waitMs: 15_000 })
      .catch((e: unknown) => e)
    expect(got).toBeInstanceOf(GuestFrozen)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(fake.commands.filter((c) => c !== "qmp_capabilities")).toEqual([
      "query-status",
    ])
  })

  it("winvm files open and mount refuse at once, before any mount or setup", async () => {
    runState = "paused"
    for (const sub of ["open", "mount"]) {
      const t0 = Date.now()
      expect(await filesCmd(parseArgs([sub, "-i", NAME]))).toBe(1)
      expect(Date.now() - t0).toBeLessThan(2000)
    }
    expect(
      fake.commands.filter(
        (c) => c !== "qmp_capabilities" && c !== "query-status",
      ),
    ).toEqual([])
    expect(existsSync(resolve(pathsFor(NAME).dir, "smb.json"))).toBe(false)
  })

  it("agent.requireAgent refuses too", async () => {
    runState = "postmigrate"
    expect(
      await agent.requireAgent(NAME).catch((e: unknown) => e),
    ).toBeInstanceOf(GuestFrozen)
  })
})

describe("status of a frozen guest", () => {
  let qga: Server
  let probes = 0
  beforeAll(async () => {
    qga = createServer((s) => {
      probes += 1
      s.on("error", () => undefined)
    })
    const path = pathsFor(NAME).qga
    rmSync(path, { force: true })
    await new Promise<void>((r) => qga.listen(path, r))
  })
  afterAll(() => {
    qga.close()
  })

  it("does not probe the guest agent of a paused guest, so it answers at once", async () => {
    runState = "paused"
    probes = 0
    const t0 = Date.now()
    const s = await gather(NAME, true)
    expect(s.state).toBe("paused")
    expect(s.guest).toBeNull()
    expect(probes).toBe(0)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it("says asleep when marked, and never sends cont", async () => {
    runState = "paused"
    markAsleep(pathsFor(NAME), qemuPid)
    const s = await gather(NAME, true)
    expect(s.state).toBe("asleep")
    expect(fake.commands).not.toContain("cont")
  })

  it("still probes a running guest", async () => {
    probes = 0
    const s = await gather(NAME, true)
    expect(s.state).toBe("running")
    expect(probes).toBeGreaterThan(0)
  }, 15_000)
})

describe("status exposes the operation in flight", () => {
  let dir: string
  const children: Array<{ kill: () => void }> = []

  beforeAll(() => {
    dir = mkdtempSync("/tmp/wvfzop-")
    writeFileSync(
      resolve(dir, "winvm.ts"),
      "setInterval(() => undefined, 1000)\n",
    )
  })
  afterAll(() => {
    for (const c of children) c.kill()
    rmSync(dir, { recursive: true, force: true })
    rmSync(pathsFor(NAME).lease, { force: true })
    rmSync(pathsFor("frozen-gone").dir, { recursive: true, force: true })
  })

  const publish = (
    instance: string,
    pid: number,
    operation: string,
    automatic = false,
  ): void => {
    mkdirSync(pathsFor(instance).dir, { recursive: true })
    writeFileSync(
      pathsFor(instance).lease,
      JSON.stringify({
        operation,
        id: "t",
        pid,
        pidStart: processStart(pid),
        startedAt: "2026-03-03T00:00:00.000Z",
        instance,
        automatic,
      }),
    )
  }
  const launch = (
    ...argv: string[]
  ): { pid: number; exited: Promise<number>; kill: () => void } => {
    const c = Bun.spawn(["bun", resolve(dir, "winvm.ts"), ...argv], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    children.push(c)
    return c
  }

  it("is null when nothing is running, and the live operation while one is", async () => {
    expect((await gather(NAME, false)).operation).toBeNull()
    const c = launch("start", "-i", NAME)
    publish(NAME, c.pid, "start")
    const s = await gather(NAME, false)
    expect(s.state).toBe("running")
    expect(s.operation).toEqual({
      operation: "start",
      pid: c.pid,
      startedAt: "2026-03-03T00:00:00.000Z",
    })
    c.kill()
    await c.exited
  })

  it("includes the work winvm does by itself: the watcher's autosave is a save", async () => {
    const c = launch("watch", "-i", NAME)
    publish(NAME, c.pid, "save", true)
    expect((await gather(NAME, false)).operation).toEqual({
      operation: "save",
      pid: c.pid,
      startedAt: "2026-03-03T00:00:00.000Z",
    })
    c.kill()
    await c.exited
  })

  it("is null for the record of a crashed owner, rather than a permanent busy state", async () => {
    const c = launch("start", "-i", NAME)
    publish(NAME, c.pid, "start")
    c.kill()
    await c.exited
    expect((await gather(NAME, false)).operation).toBeNull()
  })

  it("reaches an instance that does not exist yet, which `start` is about to create", async () => {
    const c = launch("start", "-i", "frozen-gone")
    publish("frozen-gone", c.pid, "start")
    const s = await gather("frozen-gone", false)
    expect(s.state).toBe("missing")
    expect(s.operation?.operation).toBe("start")
    c.kill()
  })
})

describe("status reports the effective close policy", () => {
  afterAll(() => {
    rmSync(configPath(NAME), { force: true })
    rmSync(pathsFor("frozen-nopolicy").dir, { recursive: true, force: true })
  })

  it("is ask until the instance chooses otherwise", async () => {
    expect((await gather(NAME, false)).closePolicy).toBe("ask")
  })

  it("follows the instance's override", async () => {
    writeAssignments(NAME, [parseAssignment("viewer.closePolicy=stow")])
    expect((await gather(NAME, false)).closePolicy).toBe("stow")
    writeAssignments(NAME, [parseAssignment("viewer.closePolicy=ask")])
    expect((await gather(NAME, false)).closePolicy).toBe("ask")
  })

  it("reaches an instance that does not exist, so the viewer always has a policy", async () => {
    const s = await gather("frozen-nopolicy", false)
    expect(s.state).toBe("missing")
    expect(s.closePolicy).toBe("ask")
  })
})

describe("graceful stop", () => {
  const OWN_PID = 4242
  const DEADLINE = 180_000
  const FORCE_AFTER = 60_000
  const SLICE = 3000
  const T0 = 1_000_000

  interface Rig {
    readonly events: string[]
    readonly at: Record<string, number>
    readonly waitForMs: number[]
    readonly sinces: Cursor[]
    readonly asleepAtRequest: boolean[]
    readonly marks: { readonly after: string[]; readonly lines: string[] }[]
    readonly disarmed: number[]
    readonly released: number[]
    readonly abort: (signal: string) => void
    readonly seams: StopCommandSeams
    readonly clock: { t: number }
  }

  function rig(o: {
    frozen: "paused" | "asleep" | null
    watcher?: boolean
    acpiExitAfterMs?: number
    forcedExitAfterMs?: number
    agent?: boolean
    agentReadyAt?: number
    refuse?: string
    request?: "refused" | "unanswered"
    resumeFails?: boolean
    serviceFails?: boolean
    pidAfterResume?: number
    record?: "full" | "shutdown" | "closed" | "none"
    lingers?: boolean
    replaceRecord?: boolean
  }): Rig {
    const p = pathsFor(NAME)
    const events: string[] = []
    const at: Record<string, number> = {}
    const waitForMs: number[] = []
    const sinces: Cursor[] = []
    const asleepAtRequest: boolean[] = []
    const marks: { after: string[]; lines: string[] }[] = []
    const disarmed: number[] = []
    const released: number[] = []
    const interruption = new AbortController()
    const clock = { t: T0 }
    let exitAt: number | null = null
    let recorded = false
    let resumed = false
    const note = (e: string): void => {
      events.push(e)
      at[e] ??= clock.t
    }
    const exitIn = (ms: number | undefined): void => {
      if (ms !== undefined && exitAt === null) exitAt = clock.t + ms
    }
    const alive = (): boolean =>
      (o.lingers === true && recorded) || exitAt === null || clock.t < exitAt
    if (o.frozen === "asleep") markAsleep(p, OWN_PID)
    const seams: StopCommandSeams = {
      now: () => clock.t,
      sleep: (ms) => {
        clock.t += ms
        return Promise.resolve()
      },
      pidOf: () =>
        !alive()
          ? null
          : resumed && o.pidAfterResume !== undefined
            ? o.pidAfterResume
            : OWN_PID,
      isRunning: alive,
      frozenState: () => Promise.resolve(o.frozen),
      ensureService: () => {
        note("ensureService")
        return o.serviceFails === true
          ? Promise.reject(new Error("the control service did not start"))
          : Promise.resolve()
      },
      resume: () => {
        note("resume")
        if (o.resumeFails === true)
          return Promise.reject(new Error("qmp refused cont"))
        resumed = true
        return Promise.resolve()
      },
      hold: () => {
        note("hold")
        return Promise.resolve()
      },
      powerdown: () => {
        note("powerdown")
        asleepAtRequest.push(markedAsleep(p, OWN_PID))
        if (o.request === "refused")
          return Promise.reject(
            new QmpNotDelivered("qmp system_powerdown: not now"),
          )
        if (o.replaceRecord === true) rmSync(p.events, { force: true })
        appendEntry(NAME, {
          kind: "qmp",
          event: "POWERDOWN",
          data: null,
          timestamp: null,
        })
        exitIn(o.acpiExitAfterMs)
        return o.request === "unanswered"
          ? Promise.reject(
              new QmpError("qmp system_powerdown: no answer in 10000 ms"),
            )
          : Promise.resolve()
      },
      untilEvent: async (_name, matches, since, until) => {
        sinces.push(since)
        for (;;) {
          const found = await waitForEvent(NAME, matches, 0, { since })
          if (found !== null) return found
          const record = o.record ?? "full"
          if (
            exitAt !== null &&
            exitAt <= until &&
            !recorded &&
            record !== "none"
          ) {
            clock.t = Math.max(clock.t, exitAt)
            recorded = true
            if (record !== "closed")
              appendEntry(NAME, {
                kind: "qmp",
                event: "SHUTDOWN",
                data: { guest: true, reason: "guest-shutdown" },
                timestamp: null,
              })
            if (record !== "shutdown")
              appendEntry(NAME, { kind: "disconnected", reason: "qemu-closed" })
            continue
          }
          clock.t = Math.max(clock.t, until)
          return null
        }
      },
      waitFor: (_sock, ms) => {
        note("waitFor")
        waitForMs.push(ms)
        if (o.agentReadyAt !== undefined)
          clock.t = Math.max(clock.t, T0 + o.agentReadyAt)
        return Promise.resolve(o.agent !== false)
      },
      shutdown: () => {
        note("shutdown")
        if (o.refuse !== undefined) return Promise.reject(new Error(o.refuse))
        exitIn(o.forcedExitAfterMs)
        return Promise.resolve()
      },
      watcherPid: () => (o.watcher === true ? 7 : null),
      stopWatcher: () => {
        note("stopWatcher")
        return Promise.resolve(o.watcher === true)
      },
      ensureWatcher: () => {
        note("ensureWatcher")
        return null
      },
      beforeDown: () => {
        note("beforeDown")
      },
      afterUp: () => {
        note("afterUp")
        return Promise.resolve()
      },
      stopSidecars: () => {
        note("stopSidecars")
      },
      irreversible: (_name, lines) => {
        marks.push({ after: [...events], lines: [...lines] })
        return () => {
          disarmed.push(marks.length)
        }
      },
      interrupts: () => ({
        signal: interruption.signal,
        release: () => {
          released.push(1)
        },
      }),
    }
    return {
      events,
      at,
      waitForMs,
      sinces,
      asleepAtRequest,
      marks,
      disarmed,
      released,
      abort: (signal) => {
        interruption.abort(signal)
      },
      seams,
      clock,
    }
  }

  interface Outcome {
    readonly code: number
    readonly out: string
    readonly err: string
  }

  const stopped = async (seams: StopCommandSeams): Promise<Outcome> => {
    const out: string[] = []
    const err: string[] = []
    const saved = { log: console.log, error: console.error, warn: console.warn }
    console.log = (...a: unknown[]) => {
      out.push(a.map(String).join(" "))
    }
    console.error = (...a: unknown[]) => {
      err.push(a.map(String).join(" "))
    }
    console.warn = console.error
    try {
      const code = await stopWith(parseArgs(["stop", "-i", NAME]), seams)
      return { code, out: out.join("\n"), err: err.join("\n") }
    } finally {
      console.log = saved.log
      console.error = saved.error
      console.warn = saved.warn
    }
  }

  beforeEach(() => {
    const p = pathsFor(NAME)
    rmSync(p.events, { force: true })
    rmSync(p.eventsPrev, { force: true })
  })

  it("presses the ACPI power button of a running guest without needing its agent, and restores nothing on success", async () => {
    const r = rig({
      frozen: null,
      watcher: true,
      agent: false,
      acpiExitAfterMs: 20_000,
    })
    const o = await stopped(r.seams)
    expect(o.code).toBe(0)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "powerdown",
      "stopSidecars",
    ])
    expect(o.out).toContain('instance "frozen-test" stopped')
  })

  it("takes its place in the record before the request, so a SHUTDOWN that comes at once is not missed", async () => {
    const r = rig({ frozen: null, acpiExitAfterMs: 1000 })
    expect((await stopped(r.seams)).code).toBe(0)
    const since = r.sinces[0]
    expect(since).toBeDefined()
    if (since === undefined) return
    expect(
      readSince(NAME, since).entries.some(
        (e) => e.kind === "qmp" && e.event === "POWERDOWN",
      ),
    ).toBe(true)
  })

  it("does not count a SHUTDOWN recorded before the request", async () => {
    appendEntry(NAME, {
      kind: "qmp",
      event: "SHUTDOWN",
      data: { guest: true, reason: "guest-shutdown" },
      timestamp: null,
    })
    const r = rig({ frozen: null, forcedExitAfterMs: 5000 })
    expect((await stopped(r.seams)).code).toBe(0)
    expect(r.events).toContain("shutdown")
  })

  it("does not take a monitor drain timeout for QEMU exiting", async () => {
    const r = rig({ frozen: null, forcedExitAfterMs: 5000 })
    const seams: StopCommandSeams = {
      ...r.seams,
      powerdown: async (p) => {
        await r.seams.powerdown?.(p)
        appendEntry(NAME, { kind: "disconnected", reason: "drain-timeout" })
      },
    }
    expect((await stopped(seams)).code).toBe(0)
    expect(r.events).toContain("shutdown")
  })

  it("starts the shutdown deadline only after a busy watcher has drained", async () => {
    const r = rig({ frozen: null, watcher: true, acpiExitAfterMs: 10_000 })
    const seams: StopCommandSeams = {
      ...r.seams,
      stopWatcher: () => {
        r.events.push("stopWatcher")
        r.clock.t += DEADLINE + 20_000
        return Promise.resolve(true)
      },
    }
    expect((await stopped(seams)).code).toBe(0)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "powerdown",
      "stopSidecars",
    ])
  })

  it("marks the point of no return right after the request, with what to say if it is interrupted", async () => {
    const r = rig({ frozen: "paused", acpiExitAfterMs: 3000 })
    expect((await stopped(r.seams)).code).toBe(0)
    expect(r.marks).toHaveLength(1)
    expect(r.marks[0]?.after.at(-1)).toBe("powerdown")
    const lines = r.marks[0]?.lines.join("\n") ?? ""
    expect(lines).toContain("Nothing was undone after the request.")
    expect(lines).toContain("QEMU is still running (pid 4242)")
    expect(lines).toContain("winvm start -i frozen-test")
    expect(lines).toContain("winvm pause -i frozen-test")
  })

  it("marks it too when QEMU never confirmed a request that may have been delivered", async () => {
    const r = rig({ frozen: null, request: "unanswered" })
    await stopped(r.seams)
    expect(r.marks).toHaveLength(1)
    expect(r.marks[0]?.after.at(-1)).toBe("powerdown")
  })

  it("never marks it for a stop that fails before the request, which rolls back", async () => {
    for (const o of [
      { request: "refused" as const },
      { serviceFails: true },
      { resumeFails: true },
    ]) {
      const r = rig({ frozen: "paused", watcher: true, ...o })
      expect((await stopped(r.seams)).code).toBe(1)
      expect(r.marks).toEqual([])
      expect(r.events).toContain("ensureWatcher")
    }
  })

  it("disarms the mark and lets go of the signals when the stop finishes, and when it is left unfinished", async () => {
    const ok = rig({ frozen: null, acpiExitAfterMs: 3000 })
    expect((await stopped(ok.seams)).code).toBe(0)
    expect(ok.disarmed).toEqual([1])
    expect(ok.released).toEqual([1])
    const late = rig({ frozen: null, lingers: true, acpiExitAfterMs: 1000 })
    expect((await stopped(late.seams)).code).toBe(STOP_UNFINISHED)
    expect(late.disarmed).toEqual([1])
    expect(late.released).toEqual([1])
  })

  it("lets go of the signals when the stop fails before the request, with nothing to disarm", async () => {
    const r = rig({ frozen: null, request: "refused" })
    expect((await stopped(r.seams)).code).toBe(1)
    expect(r.disarmed).toEqual([])
    expect(r.released).toEqual([1])
  })

  const interruptedIn = async (
    step: "stopWatcher" | "ensureService" | "resume",
    o: Parameters<typeof rig>[0],
  ): Promise<{ r: Rig; o: Outcome }> => {
    const r = rig(o)
    const inner = r.seams[step] as (...a: never[]) => Promise<unknown>
    const seams: StopCommandSeams = {
      ...r.seams,
      [step]: async (...a: never[]) => {
        r.abort("SIGINT")
        return await inner(...a)
      },
    }
    return { r, o: await stopped(seams) }
  }

  it("puts everything back and exits 130 when interrupted while the watcher is being stopped", async () => {
    const { r, o } = await interruptedIn("stopWatcher", {
      frozen: null,
      watcher: true,
    })
    expect(o.code).toBe(130)
    expect(r.events).toEqual(["stopWatcher", "afterUp", "ensureWatcher"])
    expect(r.marks).toEqual([])
    expect(o.err).toContain(
      "interrupted by SIGINT before it asked Windows to shut down",
    )
    expect(o.err).not.toContain("::error::guest did not shut down")
  })

  it("puts everything back when interrupted while the control service is brought up", async () => {
    const { r, o } = await interruptedIn("ensureService", {
      frozen: null,
      watcher: true,
    })
    expect(o.code).toBe(130)
    expect(r.events).not.toContain("powerdown")
    expect(r.events).toContain("afterUp")
    expect(r.events).toContain("ensureWatcher")
    expect(r.marks).toEqual([])
  })

  it("parks a paused guest again when interrupted after it was resumed", async () => {
    const { r, o } = await interruptedIn("resume", {
      frozen: "paused",
      watcher: true,
    })
    expect(o.code).toBe(130)
    expect(r.events).not.toContain("powerdown")
    expect(r.events.slice(-3)).toEqual(["afterUp", "hold", "ensureWatcher"])
    expect(r.marks).toEqual([])
  })

  it("leaves an asleep guest asleep when interrupted after it was resumed", async () => {
    const { r } = await interruptedIn("resume", { frozen: "asleep" })
    expect(r.events).toContain("hold")
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(true)
  })

  it("waits for a request in flight, then reports it as sent when it was delivered", async () => {
    const r = rig({ frozen: null, watcher: true, acpiExitAfterMs: 3000 })
    const seams: StopCommandSeams = {
      ...r.seams,
      powerdown: async (p) => {
        r.abort("SIGTERM")
        await r.seams.powerdown?.(p)
      },
    }
    const o = await stopped(seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(r.marks).toHaveLength(1)
    expect(o.err).toContain(
      "interrupted by SIGTERM after it asked Windows to shut down",
    )
    expect(o.err).toContain("Nothing was undone after the request.")
    expect(r.events).not.toContain("ensureWatcher")
    expect(r.events).not.toContain("stopSidecars")
  })

  it("does the same when the request may have been delivered but QEMU never answered", async () => {
    const r = rig({ frozen: null, request: "unanswered" })
    const seams: StopCommandSeams = {
      ...r.seams,
      powerdown: async (p) => {
        r.abort("SIGINT")
        await r.seams.powerdown?.(p)
      },
    }
    const o = await stopped(seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(r.marks).toHaveLength(1)
  })

  it("rolls back when it is interrupted during a request that QEMU did not take", async () => {
    const r = rig({ frozen: "paused", watcher: true, request: "refused" })
    const seams: StopCommandSeams = {
      ...r.seams,
      powerdown: async (p) => {
        r.abort("SIGINT")
        await r.seams.powerdown?.(p)
      },
    }
    const o = await stopped(seams)
    expect(o.code).toBe(1)
    expect(r.marks).toEqual([])
    expect(r.events.slice(-3)).toEqual(["afterUp", "hold", "ensureWatcher"])
  })

  it("resumes a paused guest right before the request, and restores nothing on success", async () => {
    const r = rig({ frozen: "paused", watcher: true, acpiExitAfterMs: 3000 })
    expect((await stopped(r.seams)).code).toBe(0)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "resume",
      "powerdown",
      "stopSidecars",
    ])
  })

  it("clears the asleep mark before the request of an asleep guest, and leaves it cleared on success", async () => {
    const r = rig({ frozen: "asleep", acpiExitAfterMs: 3000 })
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(true)
    expect((await stopped(r.seams)).code).toBe(0)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "resume",
      "powerdown",
      "stopSidecars",
    ])
    expect(r.asleepAtRequest).toEqual([false])
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(false)
  })

  it("escalates to the agent's forced shutdown only after 60 s without SHUTDOWN, and says it closes apps", async () => {
    const r = rig({ frozen: null, forcedExitAfterMs: 5000 })
    const o = await stopped(r.seams)
    expect(o.code).toBe(0)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "powerdown",
      "waitFor",
      "shutdown",
      "stopSidecars",
    ])
    const waited = (r.at.waitFor ?? 0) - (r.at.powerdown ?? 0)
    expect(waited).toBeGreaterThanOrEqual(FORCE_AFTER)
    expect(waited).toBeLessThanOrEqual(FORCE_AFTER + SLICE)
    expect(r.waitForMs[0]).toBeLessThanOrEqual(DEADLINE - FORCE_AFTER)
    expect(o.out).toContain("closes open apps without saving")
  })

  it("when Windows does not shut down in time, undoes nothing after the request and says what was sent and seen", async () => {
    const r = rig({ frozen: "paused", watcher: true })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "resume",
      "powerdown",
      "waitFor",
      "shutdown",
    ])
    expect(r.clock.t - T0).toBe(DEADLINE)
    expect(o.err).toContain("system_powerdown")
    expect(o.err).toContain("guest-shutdown")
    expect(o.err).toContain("POWERDOWN")
    expect(o.err).toContain("Nothing was undone")
    expect(o.err).toContain("winvm kill -i frozen-test")
  })

  it("after a timeout says what is left running and down, and how to wait, get it back, or end it", async () => {
    const r = rig({ frozen: "paused", watcher: true })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    for (const text of [
      "QEMU is still running",
      "Windows was paused, and stop resumed it",
      "the watcher",
      "Finder drives",
      "winvm status -i frozen-test",
      "winvm start -i frozen-test",
      "winvm pause -i frozen-test",
      "winvm kill -i frozen-test",
    ])
      expect(o.err).toContain(text)
  })

  it("after a timeout of a running guest says nothing about resuming it", async () => {
    const r = rig({ frozen: null })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(o.err).not.toContain("resumed")
    expect(o.err).toContain("winvm start -i frozen-test")
  })

  it("says when QEMU never confirmed the power-button request", async () => {
    const r = rig({ frozen: null, request: "unanswered" })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(o.err).toContain("which QEMU did not confirm")
  })

  it("does not start the forced shutdown with too little time left to see it through", async () => {
    const r = rig({ frozen: null, agentReadyAt: DEADLINE - 5000 })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(r.events).not.toContain("shutdown")
    expect(o.err).toContain("too little time")
  })

  it("leaves a warning in the record when it forces the shutdown", async () => {
    const r = rig({ frozen: null, forcedExitAfterMs: 5000 })
    expect((await stopped(r.seams)).code).toBe(0)
    expect(
      readSince(NAME, START).entries.some(
        (e) => e.kind === "warning" && e.what.includes("guest-shutdown"),
      ),
    ).toBe(true)
  })

  it("does not put an asleep guest back to sleep once shutdown was requested", async () => {
    const r = rig({ frozen: "asleep" })
    expect((await stopped(r.seams)).code).toBe(STOP_UNFINISHED)
    expect(r.events).not.toContain("hold")
    expect(r.events).not.toContain("afterUp")
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(false)
  })

  it("reports a refused forced shutdown and keeps waiting for the power button", async () => {
    const r = rig({
      frozen: null,
      refuse: "guest-shutdown: A required privilege is not held by the client.",
      acpiExitAfterMs: 100_000,
    })
    const o = await stopped(r.seams)
    expect(o.code).toBe(0)
    expect(o.err).toContain("A required privilege is not held by the client.")
  })

  it("says the forced shutdown was never sent when the agent does not answer", async () => {
    const r = rig({ frozen: null, agent: false })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(r.events).not.toContain("shutdown")
    expect(o.err).toContain("the guest agent did not answer")
  })

  it("finishes when QEMU exits even if the record never sees it", async () => {
    const r = rig({ frozen: null, acpiExitAfterMs: 7000, record: "none" })
    expect((await stopped(r.seams)).code).toBe(0)
    expect(r.events).toContain("stopSidecars")
  })

  it("ends the wait as soon as the service records QEMU closing the monitor, without SHUTDOWN", async () => {
    const r = rig({ frozen: null, acpiExitAfterMs: 7500, record: "closed" })
    expect((await stopped(r.seams)).code).toBe(0)
    expect(r.clock.t - T0).toBe(7500)
    expect(r.events).toContain("stopSidecars")
  })

  it("follows SHUTDOWN with the monitor closing from the cursor after it", async () => {
    const r = rig({ frozen: null, acpiExitAfterMs: 4000, lingers: true })
    await stopped(r.seams)
    const last = r.sinces.at(-1)
    expect(last).not.toEqual(r.sinces[0])
    if (last === undefined) return
    expect(readSince(NAME, last).entries.map((e) => e.kind)).toEqual([
      "disconnected",
    ])
  })

  it("still wants the QEMU pid gone after the monitor closed", async () => {
    const r = rig({
      frozen: null,
      acpiExitAfterMs: 5000,
      record: "closed",
      lingers: true,
    })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(o.err).toContain("disconnected (qemu-closed)")
    expect(o.err).toContain("has not exited")
  })

  it("says the record has a gap rather than reporting its silence as fact", async () => {
    appendEntry(NAME, { kind: "sync", status: "running", running: true })
    const r = rig({ frozen: null, agent: false, replaceRecord: true })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(o.err).toContain("the record has a gap")
  })

  it("waits for QEMU to exit after SHUTDOWN, and says so when it does not", async () => {
    const r = rig({
      frozen: null,
      acpiExitAfterMs: 5000,
      record: "shutdown",
      lingers: true,
    })
    const o = await stopped(r.seams)
    expect(o.code).toBe(STOP_UNFINISHED)
    expect(r.events).not.toContain("stopSidecars")
    expect(r.events).not.toContain("afterUp")
    expect(o.err).toContain("has not exited")
    expect(o.err).toContain("winvm kill -i frozen-test")
    expect(o.err).toContain("winvm start -i frozen-test")
  })

  it("a request QEMU may have acted on without answering is past the point of no return", async () => {
    const r = rig({
      frozen: "paused",
      watcher: true,
      request: "unanswered",
      acpiExitAfterMs: 4000,
    })
    expect((await stopped(r.seams)).code).toBe(0)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "resume",
      "powerdown",
      "stopSidecars",
    ])
  })

  it("when QEMU refuses the request, brings Finder back while resumed, then the pause, then the watcher", async () => {
    const r = rig({ frozen: "paused", watcher: true, request: "refused" })
    const o = await stopped(r.seams)
    expect(o.code).toBe(1)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "resume",
      "powerdown",
      "afterUp",
      "hold",
      "ensureWatcher",
    ])
    expect(o.err).toContain("not now")
  })

  it("when QEMU refuses the request of an asleep guest, puts it back to sleep against the same QEMU", async () => {
    const r = rig({ frozen: "asleep", request: "refused" })
    expect((await stopped(r.seams)).code).toBe(1)
    expect(r.asleepAtRequest).toEqual([false])
    expect(r.events).toContain("hold")
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(true)
  })

  it("on a refused request leaves alone a watcher that was not running", async () => {
    const r = rig({ frozen: null, request: "refused" })
    expect((await stopped(r.seams)).code).toBe(1)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "powerdown",
      "afterUp",
    ])
  })

  it("never holds or marks a QEMU other than the one it resumed", async () => {
    const r = rig({
      frozen: "asleep",
      request: "refused",
      pidAfterResume: OWN_PID + 1,
    })
    expect((await stopped(r.seams)).code).toBe(1)
    expect(r.events).not.toContain("hold")
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(false)
    expect(markedAsleep(pathsFor(NAME), OWN_PID + 1)).toBe(false)
  })

  it("when the resume itself fails, asks for nothing, keeps the asleep mark, and does not remount into a frozen guest", async () => {
    const r = rig({ frozen: "asleep", watcher: true, resumeFails: true })
    expect((await stopped(r.seams)).code).toBe(1)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "resume",
      "hold",
      "ensureWatcher",
    ])
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(true)
  })

  it("when the control service cannot start, sends nothing and puts everything back", async () => {
    const r = rig({ frozen: null, watcher: true, serviceFails: true })
    expect((await stopped(r.seams)).code).toBe(1)
    expect(r.events).toEqual([
      "stopWatcher",
      "beforeDown",
      "ensureService",
      "afterUp",
      "ensureWatcher",
    ])
  })
})

describe("winvm start on a running instance", () => {
  const run = async (
    frozen: "paused" | "asleep" | null,
  ): Promise<{ code: number; events: string[] }> => {
    const events: string[] = []
    const seams: RunningStartSeams = {
      reconcile: () => {
        events.push("reconcile")
        return Promise.resolve()
      },
      startWatcher: () => {
        events.push("startWatcher")
      },
      frozenState: () => Promise.resolve(frozen),
      afterUp: () => {
        events.push("afterUp")
        return Promise.resolve()
      },
    }
    const log = console.log
    console.log = () => undefined
    try {
      const code = await startRunning(
        NAME,
        parseArgs(["start", "-i", NAME]),
        seams,
      )
      return { code, events }
    } finally {
      console.log = log
    }
  }

  it("brings back what a stop took down: the watcher and the guest's Finder drives", async () => {
    expect(await run(null)).toEqual({
      code: 0,
      events: ["reconcile", "startWatcher", "afterUp"],
    })
  })

  it("does not mount drives into a paused or asleep guest", async () => {
    for (const f of ["paused", "asleep"] as const)
      expect((await run(f)).events).toEqual(["reconcile", "startWatcher"])
  })
})

describe("status after a stop that did not finish", () => {
  let n = 0
  const opEnd = (operation: string, ok: boolean, exitCode: number): void => {
    n += 1
    appendEntry(NAME, {
      kind: "op",
      phase: "end",
      id: `op-${String(n)}`,
      operation,
      pid: 4242,
      startedAt: "2026-11-16T18:00:00.000Z",
      endedAt: `2026-11-16T18:03:${String(n).padStart(2, "0")}.000Z`,
      automatic: false,
      leased: true,
      ok,
      exitCode,
    })
  }

  beforeEach(() => {
    rmSync(pathsFor(NAME).events, { force: true })
    rmSync(pathsFor(NAME).eventsPrev, { force: true })
  })

  it("says so, with what to do, while the same QEMU runs on", async () => {
    opEnd("stop", false, STOP_UNFINISHED)
    const s = await gather(NAME, false)
    expect(s.stopUnfinished).toEqual({ at: "2026-11-16T18:03:01.000Z" })
    const note = s.notes.find((x) => x.includes("did not finish"))
    expect(note).toBeDefined()
    expect(note).toContain("winvm start -i frozen-test")
    expect(note).toContain("winvm kill -i frozen-test")
  })

  it("does not count a stop that failed before asking, which put everything back", async () => {
    opEnd("stop", false, 1)
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
  })

  it("clears once a later start brings it back", async () => {
    opEnd("stop", false, STOP_UNFINISHED)
    opEnd("start", true, 0)
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
  })

  it("clears once QEMU records the shutdown", async () => {
    opEnd("stop", false, STOP_UNFINISHED)
    appendEntry(NAME, {
      kind: "qmp",
      event: "SHUTDOWN",
      data: { guest: true, reason: "guest-shutdown" },
      timestamp: null,
    })
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
  })

  it("reports a stop that was interrupted after the request, whatever the end says", async () => {
    n += 1
    appendEntry(NAME, {
      kind: "op",
      phase: "end",
      id: "op-abandoned",
      operation: "stop",
      pid: 4242,
      startedAt: "2026-11-16T18:00:00.000Z",
      endedAt: "2026-11-16T18:04:00.000Z",
      automatic: false,
      leased: true,
      ok: false,
      abandoned: true,
      error: "pid 4242 went away without letting go of the instance",
      irreversibleAt: "2026-11-16T18:01:00.000Z",
    })
    const s = await gather(NAME, false)
    expect(s.stopUnfinished).toEqual({ at: "2026-11-16T18:04:00.000Z" })
    expect(s.notes.find((x) => x.includes("did not finish"))).toContain(
      "winvm start -i frozen-test",
    )
  })

  const leaseOf = async (
    over: Record<string, unknown>,
    alive = false,
  ): Promise<void> => {
    let pid = process.pid
    if (!alive) {
      const gone = Bun.spawn(["true"])
      await gone.exited
      pid = gone.pid
    }
    writeFileSync(
      pathsFor(NAME).lease,
      JSON.stringify({
        operation: "stop",
        id: "killed-stop",
        pid,
        pidStart: processStart(pid),
        startedAt: "2026-11-16T18:00:00.000Z",
        instance: NAME,
        automatic: false,
        ...over,
      }),
    )
  }

  it("reports a stop that was killed outright without taking its lease over", async () => {
    await leaseOf({ irreversibleAt: "2026-11-16T18:01:00.000Z" })
    const before = readFileSync(pathsFor(NAME).lease, "utf8")
    const s = await gather(NAME, false)
    expect(s.stopUnfinished).toEqual({ at: "2026-11-16T18:01:00.000Z" })
    expect(s.notes.find((x) => x.includes("did not finish"))).toContain(
      "winvm start -i frozen-test",
    )
    expect(readFileSync(pathsFor(NAME).lease, "utf8")).toBe(before)
    expect(readSince(NAME, START).entries).toEqual([])
    rmSync(pathsFor(NAME).lease, { force: true })
  })

  it("does not report a killed stop whose record never got to the request, or one still alive", async () => {
    await leaseOf({})
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
    await leaseOf({ irreversibleAt: "2026-11-16T18:01:00.000Z" }, true)
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
    rmSync(pathsFor(NAME).lease, { force: true })
  })

  it("clears a killed stop's flag once QEMU records the shutdown or a start succeeds after it", async () => {
    await leaseOf({ irreversibleAt: "2026-11-16T18:01:00.000Z" })
    appendEntry(NAME, {
      kind: "qmp",
      event: "SHUTDOWN",
      data: { guest: true, reason: "guest-shutdown" },
      timestamp: null,
    })
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
    rmSync(pathsFor(NAME).events, { force: true })
    opEnd("start", true, 0)
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
    rmSync(pathsFor(NAME).lease, { force: true })
  })

  it("does not report an abandoned stop that never reached the request", async () => {
    appendEntry(NAME, {
      kind: "op",
      phase: "end",
      id: "op-early",
      operation: "stop",
      pid: 4242,
      startedAt: "2026-11-16T18:00:00.000Z",
      endedAt: "2026-11-16T18:04:00.000Z",
      automatic: false,
      leased: true,
      ok: false,
      abandoned: true,
    })
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
  })

  it("clears an interrupted stop when a later start succeeds", async () => {
    appendEntry(NAME, {
      kind: "op",
      phase: "end",
      id: "op-int",
      operation: "stop",
      pid: 4242,
      startedAt: "2026-11-16T18:00:00.000Z",
      endedAt: "2026-11-16T18:04:00.000Z",
      automatic: false,
      leased: true,
      ok: false,
      exitCode: STOP_UNFINISHED,
      irreversibleAt: "2026-11-16T18:01:00.000Z",
    })
    opEnd("start", true, 0)
    expect((await gather(NAME, false)).stopUnfinished).toBeNull()
  })

  it("is not reported for a machine that is not running", async () => {
    opEnd("stop", false, STOP_UNFINISHED)
    const s = await gather("frozen-nostop", false)
    expect(s.stopUnfinished).toBeNull()
  })
})

describe("status when the host powered Windows off", () => {
  const HOST = "frozen-hostoff"
  const LOG =
    "qemu-system-aarch64: terminating on signal 15 from pid 412 (launchd)\n"

  const shutdown = (reason: string): void => {
    appendEntry(HOST, {
      kind: "qmp",
      event: "SHUTDOWN",
      data: { guest: false, reason },
      timestamp: null,
    })
  }
  const closed = (): void => {
    appendEntry(HOST, { kind: "disconnected", reason: "qemu-closed" })
  }
  const op = (
    phase: "begin" | "end",
    operation: string,
    ok = true,
    id = `${operation}-${phase}`,
  ): void => {
    const who = {
      id,
      operation,
      pid: 4242,
      startedAt: "2026-11-16T18:00:00.000Z",
      automatic: false,
      leased: true,
    }
    appendEntry(
      HOST,
      phase === "begin"
        ? { kind: "op", phase, ...who }
        : {
            kind: "op",
            phase,
            ...who,
            endedAt: "2026-11-16T18:00:05.000Z",
            ok,
            exitCode: ok ? 0 : 1,
          },
    )
  }

  beforeEach(() => {
    const p = pathsFor(HOST)
    rmSync(p.dir, { recursive: true, force: true })
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(
      p.meta,
      JSON.stringify({
        image: "win11-arm64",
        vnc: 8,
        created: new Date().toISOString(),
      }),
    )
  })
  afterAll(() => {
    rmSync(pathsFor(HOST).dir, { recursive: true, force: true })
  })

  it("says so, and quotes who signalled QEMU, when QEMU recorded SHUTDOWN host-signal", async () => {
    writeFileSync(pathsFor(HOST).qemuLog, `boot noise\n${LOG}`)
    shutdown("host-signal")
    closed()
    const s = await gather(HOST, false)
    expect(s.state).toBe("stopped")
    expect(s.hostPoweredOff).toEqual({
      at: expect.any(String) as string,
      cause: "host-signal",
      detail: "terminating on signal 15 from pid 412 (launchd)",
    })
    const note = s.notes.find((x) => x.includes("host"))
    expect(note).toContain("launchd")
    expect(note).toContain("winvm start -i frozen-hostoff")
  })

  it("still says so when qemu.log has no signal line", async () => {
    shutdown("host-signal")
    closed()
    const s = await gather(HOST, false)
    expect(s.hostPoweredOff).toMatchObject({
      cause: "host-signal",
      detail: null,
    })
    expect(s.notes.some((x) => x.includes("host"))).toBe(true)
  })

  it("says QEMU is gone when its monitor closed with no SHUTDOWN and no winvm command ended it", async () => {
    closed()
    const s = await gather(HOST, false)
    expect(s.hostPoweredOff).toMatchObject({
      cause: "qemu-gone",
      detail: null,
    })
    expect(s.notes.join("\n")).toContain("without recording a shutdown")
  })

  it("is silent about a guest that shut itself down", async () => {
    shutdown("guest-shutdown")
    closed()
    expect((await gather(HOST, false)).hostPoweredOff).toBeNull()
  })

  it("is silent when winvm kill ended QEMU, whichever way the record orders the end", async () => {
    op("begin", "kill")
    closed()
    op("end", "kill")
    expect((await gather(HOST, false)).hostPoweredOff).toBeNull()
  })

  it("is silent about QEMU closing during a kill that has not ended yet", async () => {
    op("begin", "kill")
    closed()
    expect((await gather(HOST, false)).hostPoweredOff).toBeNull()
  })

  it("still notices QEMU vanishing after an idle sleep and wake", async () => {
    op("begin", "sleep")
    op("end", "sleep")
    op("begin", "wake")
    op("end", "wake")
    closed()
    expect((await gather(HOST, false)).hostPoweredOff).toMatchObject({
      cause: "qemu-gone",
    })
  })

  it("still notices QEMU vanishing after a load that launched it again", async () => {
    op("begin", "kill")
    op("end", "kill")
    op("begin", "load")
    op("end", "load")
    closed()
    expect((await gather(HOST, false)).hostPoweredOff).toMatchObject({
      cause: "qemu-gone",
    })
  })

  it("is silent about QEMU dying during a start that failed", async () => {
    op("begin", "start")
    closed()
    op("end", "start", false)
    expect((await gather(HOST, false)).hostPoweredOff).toBeNull()
  })

  it("clears once a later start succeeds", async () => {
    shutdown("host-signal")
    closed()
    op("begin", "start")
    op("end", "start")
    expect((await gather(HOST, false)).hostPoweredOff).toBeNull()
  })

  it("is null when nothing has happened, and for a machine that is running", async () => {
    expect((await gather(HOST, false)).hostPoweredOff).toBeNull()
    appendEntry(NAME, {
      kind: "qmp",
      event: "SHUTDOWN",
      data: { guest: false, reason: "host-signal" },
      timestamp: null,
    })
    expect((await gather(NAME, false)).hostPoweredOff).toBeNull()
  })

  it("is null for an instance that does not exist", async () => {
    expect(
      (await gather("frozen-hostoff-gone", false)).hostPoweredOff,
    ).toBeNull()
  })

  const keeper = (what: string, fields: Record<string, unknown> = {}): void => {
    appendEntry(HOST, { kind: "keeper", what, ...fields })
  }
  const step = (name: string, ok = true): void => {
    keeper("host-end", { step: name, ok })
  }
  const keptStart = (): void => {
    op("begin", "start")
    keeper("launched", { child: "qemu", pid: 501, program: "qemu" })
    op("end", "start")
  }

  it("says the keeper quit QEMU when Windows did not finish shutting down at host end", async () => {
    keptStart()
    keeper("host-ending", { signal: "SIGTERM", budgetMs: 55_000 })
    step("powerdown")
    step("quit")
    shutdown("host-qmp-quit")
    closed()
    keeper("exited", { child: "swtpm", pid: 502, signal: 9, core: false })
    keeper("exited", { child: "qemu", pid: 501, status: 0 })
    step("done")
    const s = await gather(HOST, false)
    expect(s.hostPoweredOff).toMatchObject({ cause: "host-quit" })
    const note = s.notes.join("\n")
    expect(note).toContain("did not shut down cleanly")
    expect(note).toContain("winvm start -i frozen-hostoff")
  })

  it("says the keeper killed QEMU at the deadline, whatever order the record has", async () => {
    keptStart()
    keeper("host-ending", { signal: "SIGTERM", budgetMs: 55_000 })
    step("powerdown")
    step("quit", false)
    step("kill")
    keeper("exited", { child: "qemu", pid: 501, signal: 9, core: false })
    closed()
    step("done")
    const s = await gather(HOST, false)
    expect(s.hostPoweredOff).toMatchObject({ cause: "host-kill" })
    expect(s.notes.join("\n")).toContain("did not shut down cleanly")
  })

  it("says Windows was shut down cleanly when the keeper's power button worked", async () => {
    keptStart()
    keeper("host-ending", { signal: "SIGTERM", budgetMs: 55_000 })
    step("powerdown")
    keeper("exited", { child: "qemu", pid: 501, status: 0 })
    shutdown("guest-shutdown")
    closed()
    step("done")
    const s = await gather(HOST, false)
    expect(s.hostPoweredOff).toMatchObject({ cause: "host-shutdown" })
    const note = s.notes.join("\n")
    expect(note).toContain("shut down cleanly when the Mac shut down")
    expect(note).not.toContain("lost")
  })

  it("forgets the keeper's host end once a later start succeeds", async () => {
    keptStart()
    keeper("host-ending", { signal: "SIGTERM", budgetMs: 55_000 })
    step("quit")
    keeper("exited", { child: "qemu", pid: 501, status: 0 })
    closed()
    keptStart()
    expect((await gather(HOST, false)).hostPoweredOff).toBeNull()
  })
})
