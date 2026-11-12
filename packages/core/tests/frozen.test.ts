/**
 * A paused or asleep guest (frozen.ts): what status reports, that nothing calls
 * into it, and the asleep mark. QEMU is a FakeQmp; the "QEMU process" is this one.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import * as agent from "../src/agent"
import { parseArgs } from "../src/args"
import { stopWith, type StopCommandSeams } from "../src/commands"
import { configPath, parseAssignment, writeAssignments } from "../src/config"
import { filesCmd } from "../src/finder"
import { GuestFrozen, clearSavingRunning, frozenFrom, frozenState, isFrozenRunState, markAsleep, clearAsleep, markSavingRunning, markedAsleep, refuseFrozen, savingRunning } from "../src/frozen"
import { pathsFor } from "../src/paths"
import { deriveState, gather } from "../src/status"
import { FakeQmp } from "./fakes/qmp"

const NAME = "frozen-test"
let home: string
let savedHome: string | undefined
let fake: FakeQmp
let runState = "running"

beforeAll(async () => {
  savedHome = process.env["WINVM_HOME"]
  // Short: unix socket paths are limited to ~104 bytes.
  home = mkdtempSync("/tmp/wvfz-")
  process.env["WINVM_HOME"] = home
  const p = pathsFor(NAME)
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify({ image: "win11-arm64", vnc: 9, created: new Date().toISOString() }))
  writeFileSync(p.pid, `${String(process.pid)}\n`)
  fake = new FakeQmp(p.qmp)
  fake.handler = (cmd) => (cmd["execute"] === "query-status" ? { return: { status: runState, running: runState === "running" } } : { return: {} })
  await fake.listen()
})

afterAll(async () => {
  await fake.close()
  rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env["WINVM_HOME"]
  else process.env["WINVM_HOME"] = savedHome
})

afterEach(() => {
  runState = "running"
  clearAsleep(pathsFor(NAME))
  fake.commands.length = 0
})

describe("run states", () => {
  it("counts paused, suspended and postmigrate as frozen, nothing else", () => {
    for (const s of ["paused", "suspended", "postmigrate"]) expect(isFrozenRunState(s)).toBe(true)
    for (const s of ["running", "finish-migrate", "inmigrate", "prelaunch", "unknown"]) expect(isFrozenRunState(s)).toBe(false)
    expect(isFrozenRunState(null)).toBe(false)
  })

  it("tells asleep from paused by the mark", () => {
    expect(frozenFrom("paused", false)).toBe("paused")
    expect(frozenFrom("paused", true)).toBe("asleep")
    expect(frozenFrom("running", true)).toBeNull()
  })

  it("reports a save of a paused guest (postmigrate) as paused, not running", () => {
    // The bug: after an autosave of a paused guest QEMU says "postmigrate",
    // status said "running", and the app flipped Resume back to Pause.
    expect(deriveState(true, "postmigrate", [])).toBe("paused")
    expect(deriveState(true, "paused", [], true)).toBe("asleep")
    expect(deriveState(true, "running", [], true)).toBe("running")
    // A monitor too busy to answer is a save or load at work, not a pause.
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

  it("is marked by the process saving, and the mark of a process gone counts for nothing", () => {
    const p = pathsFor(NAME)
    expect(savingRunning(p)).toBe(false)
    markSavingRunning(p)
    expect(savingRunning(p)).toBe(true)
    // A pid no process has: a save that died left its mark behind.
    markSavingRunning(p, 2 ** 22 + 12_345)
    expect(savingRunning(p)).toBe(false)
    clearSavingRunning(p)
    expect(savingRunning(p)).toBe(false)
  })

  it("status says running while the save holds it stopped, and does not wait on its guest agent", async () => {
    runState = "postmigrate"
    markSavingRunning(pathsFor(NAME))
    try {
      const t0 = Date.now()
      const s = await gather(NAME, true)
      expect(s.state).toBe("running")
      expect(s.vmStatus).toBe("postmigrate")
      expect(s.guest).toBeNull()
      expect(Date.now() - t0).toBeLessThan(1500)
    } finally {
      clearSavingRunning(pathsFor(NAME))
    }
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
    markAsleep(p, process.pid)
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
    markAsleep(pathsFor(NAME), process.pid)
    const asleep = await refuseFrozen(NAME).catch((e: unknown) => e)
    expect((asleep as GuestFrozen).state).toBe("asleep")
    expect((asleep as Error).message).toContain("winvm wake -i frozen-test")
  })

  it("agent.ensure refuses at once: no waiting on the agent, no qemu-ga, no reinstall, never cont", async () => {
    runState = "paused"
    const t0 = Date.now()
    const got = await agent.ensure(NAME, { waitMs: 15_000 }).catch((e: unknown) => e)
    expect(got).toBeInstanceOf(GuestFrozen)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(fake.commands.filter((c) => c !== "qmp_capabilities")).toEqual(["query-status"])
  })

  it("winvm files open and mount refuse at once, before any mount or setup", async () => {
    runState = "paused"
    for (const sub of ["open", "mount"]) {
      const t0 = Date.now()
      expect(await filesCmd(parseArgs([sub, "-i", NAME]))).toBe(1)
      expect(Date.now() - t0).toBeLessThan(2000)
    }
    expect(fake.commands.filter((c) => c !== "qmp_capabilities" && c !== "query-status")).toEqual([])
    expect(existsSync(resolve(pathsFor(NAME).dir, "smb.json"))).toBe(false)
  })

  it("agent.requireAgent refuses too", async () => {
    runState = "postmigrate"
    expect(await agent.requireAgent(NAME).catch((e: unknown) => e)).toBeInstanceOf(GuestFrozen)
  })
})

describe("status of a frozen guest", () => {
  let qga: Server
  let probes = 0
  beforeAll(async () => {
    // A guest agent that never answers, as a paused guest's does not.
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
    markAsleep(pathsFor(NAME), process.pid)
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
    // `ps` shows `bun <dir>/winvm.ts start -i frozen-test`: a WinVM CLI process.
    writeFileSync(resolve(dir, "winvm.ts"), "setInterval(() => undefined, 1000)\n")
  })
  afterAll(() => {
    for (const c of children) c.kill()
    rmSync(dir, { recursive: true, force: true })
    rmSync(pathsFor(NAME).operations, { recursive: true, force: true })
    rmSync(pathsFor("frozen-gone").dir, { recursive: true, force: true })
  })

  const publish = (instance: string, pid: number, operation: string): void => {
    const ops = pathsFor(instance).operations
    mkdirSync(ops, { recursive: true })
    writeFileSync(resolve(ops, `${String(pid)}.json`), JSON.stringify({ operation, pid, startedAt: "2026-03-03T00:00:00.000Z", instance, token: "t" }))
  }
  const launch = (...argv: string[]): { pid: number; exited: Promise<number>; kill: () => void } => {
    const c = Bun.spawn(["bun", resolve(dir, "winvm.ts"), ...argv], { stdio: ["ignore", "ignore", "ignore"] })
    children.push(c)
    return c
  }

  it("is null when nothing is running, and the live operation while one is", async () => {
    expect((await gather(NAME, false)).operation).toBeNull()
    const c = launch("start", "-i", NAME)
    publish(NAME, c.pid, "start")
    const s = await gather(NAME, false)
    expect(s.state).toBe("running")
    expect(s.operation).toEqual({ operation: "start", pid: c.pid, startedAt: "2026-03-03T00:00:00.000Z" })
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

  interface Rig {
    readonly events: string[]
    readonly waitForMs: number[]
    readonly seams: StopCommandSeams
    readonly clock: { t: number }
    /** QEMU stays alive until this is called (a guest that finished shutting down). */
    readonly exit: () => void
    readonly asleepAtWait: boolean[]
  }

  /**
   * A stop with every outside call replaced: a fake clock that only `sleep` and
   * `waitFor` advance, a QEMU that exits when told to, and an event log. The
   * asleep mark is the real one, in the temp home, naming OWN_PID.
   */
  function rig(o: {
    frozen: "paused" | "asleep" | null
    watcher?: boolean
    /** How long the readiness wait takes (it answers true after that), or "never". */
    readyAfterMs?: number | "never"
    /** The guest powers off this long after shutdown was requested; unset: it never does. */
    exitsAfterMs?: number
    /** QEMU is a different process by the time of a failure (its pid was reused or it was restarted). */
    pidAfterShutdown?: number
    /** QMP `cont` is refused. */
    resumeFails?: boolean
  }): Rig {
    const p = pathsFor(NAME)
    const events: string[] = []
    const waitForMs: number[] = []
    const asleepAtWait: boolean[] = []
    const clock = { t: 1_000_000 }
    let alive = true
    let shutdownAt: number | null = null
    if (o.frozen === "asleep") markAsleep(p, OWN_PID)
    const seams: StopCommandSeams = {
      now: () => clock.t,
      sleep: (ms) => {
        clock.t += ms
        return Promise.resolve()
      },
      pidOf: () => (!alive ? null : shutdownAt !== null && o.pidAfterShutdown !== undefined ? o.pidAfterShutdown : OWN_PID),
      isRunning: () => {
        if (shutdownAt !== null && o.exitsAfterMs !== undefined && clock.t - shutdownAt >= o.exitsAfterMs) alive = false
        return alive
      },
      frozenState: () => Promise.resolve(o.frozen),
      resume: () => {
        events.push("resume")
        return o.resumeFails === true ? Promise.reject(new Error("qmp refused cont")) : Promise.resolve()
      },
      hold: () => {
        events.push("hold")
        return Promise.resolve()
      },
      waitFor: (_sock, ms) => {
        events.push("waitFor")
        waitForMs.push(ms)
        asleepAtWait.push(markedAsleep(p, OWN_PID))
        if (o.readyAfterMs === "never") {
          clock.t += ms
          return Promise.resolve(false)
        }
        clock.t += o.readyAfterMs ?? 0
        return Promise.resolve(true)
      },
      shutdown: () => {
        events.push("shutdown")
        shutdownAt = clock.t
        return Promise.resolve()
      },
      watcherPid: () => (o.watcher === true ? 7 : null),
      stopWatcher: () => {
        events.push("stopWatcher")
        return Promise.resolve(o.watcher === true)
      },
      ensureWatcher: () => {
        events.push("ensureWatcher")
        return null
      },
      beforeDown: () => {
        events.push("beforeDown")
      },
      afterUp: () => {
        events.push("afterUp")
        return Promise.resolve()
      },
      stopSidecars: () => {
        events.push("stopSidecars")
      },
    }
    return {
      events,
      waitForMs,
      seams,
      clock,
      asleepAtWait,
      exit: () => {
        alive = false
      },
    }
  }

  const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
    const log = console.log
    const err = console.error
    console.log = () => undefined
    console.error = () => undefined
    try {
      return await f()
    } finally {
      console.log = log
      console.error = err
    }
  }
  const stopped = (seams: StopCommandSeams): Promise<number> => quiet(() => stopWith(parseArgs(["stop", "-i", NAME]), seams))

  it("waits for the agent of a starting guest, asks for shutdown, and leaves nothing to restore on success", async () => {
    const r = rig({ frozen: null, watcher: true, readyAfterMs: 20_000, exitsAfterMs: 6000 })
    expect(await stopped(r.seams)).toBe(0)
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "waitFor", "shutdown", "stopSidecars"])
    expect(r.waitForMs).toEqual([DEADLINE])
  })

  it("starts the shutdown deadline only after a busy watcher has drained", async () => {
    const r = rig({ frozen: null, watcher: true, exitsAfterMs: 0 })
    const seams: StopCommandSeams = {
      ...r.seams,
      stopWatcher: () => {
        r.events.push("stopWatcher")
        r.clock.t += DEADLINE + 20_000
        return Promise.resolve(true)
      },
    }
    expect(await stopped(seams)).toBe(0)
    expect(r.waitForMs).toEqual([DEADLINE])
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "waitFor", "shutdown", "stopSidecars"])
  })

  it("fails a guest that never becomes agent-ready without sending shutdown", async () => {
    const r = rig({ frozen: null, readyAfterMs: "never" })
    expect(await stopped(r.seams)).toBe(1)
    expect(r.events).not.toContain("shutdown")
    expect(r.waitForMs).toEqual([DEADLINE])
    expect(r.clock.t - 1_000_000).toBeLessThanOrEqual(DEADLINE)
  })

  it("on failure brings Finder back, then the watcher that was running", async () => {
    const r = rig({ frozen: null, watcher: true, readyAfterMs: "never" })
    expect(await stopped(r.seams)).toBe(1)
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "waitFor", "afterUp", "ensureWatcher"])
  })

  it("on failure leaves alone a watcher that was not running", async () => {
    const r = rig({ frozen: null, readyAfterMs: "never" })
    expect(await stopped(r.seams)).toBe(1)
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "waitFor", "afterUp"])
  })

  it("resumes a paused guest before asking it to shut down, and restores nothing on success", async () => {
    const r = rig({ frozen: "paused", watcher: true, readyAfterMs: 2000, exitsAfterMs: 3000 })
    expect(await stopped(r.seams)).toBe(0)
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "resume", "waitFor", "shutdown", "stopSidecars"])
  })

  it("clears the asleep mark for the shutdown-only resume of an asleep guest, and leaves it cleared on success", async () => {
    const r = rig({ frozen: "asleep", readyAfterMs: 1000, exitsAfterMs: 3000 })
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(true)
    expect(await stopped(r.seams)).toBe(0)
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "resume", "waitFor", "shutdown", "stopSidecars"])
    expect(r.asleepAtWait).toEqual([false])
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(false)
  })

  it("when a paused guest does not shut down in time, restores Finder while resumed, then the pause, then the watcher", async () => {
    const r = rig({ frozen: "paused", watcher: true, readyAfterMs: 5000 })
    expect(await stopped(r.seams)).toBe(1)
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "resume", "waitFor", "shutdown", "afterUp", "hold", "ensureWatcher"])
    expect(r.waitForMs).toEqual([DEADLINE])
    expect(r.clock.t - 1_000_000).toBe(DEADLINE)
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(false)
  })

  it("when an asleep guest does not become agent-ready, puts it back to sleep against the same QEMU", async () => {
    const r = rig({ frozen: "asleep", readyAfterMs: "never" })
    expect(await stopped(r.seams)).toBe(1)
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "resume", "waitFor", "afterUp", "hold"])
    expect(r.asleepAtWait).toEqual([false])
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(true)
  })

  it("never holds or marks a QEMU other than the one it resumed", async () => {
    const r = rig({ frozen: "asleep", readyAfterMs: 1000, pidAfterShutdown: OWN_PID + 1 })
    expect(await stopped(r.seams)).toBe(1)
    expect(r.events).not.toContain("hold")
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(false)
    expect(markedAsleep(pathsFor(NAME), OWN_PID + 1)).toBe(false)
  })

  it("gives readiness and power-off one shared deadline, not 180 seconds each", async () => {
    const r = rig({ frozen: null, readyAfterMs: 170_000, exitsAfterMs: 15_000 })
    expect(await stopped(r.seams)).toBe(1)
    expect(r.waitForMs).toEqual([DEADLINE])
    expect(r.events).toContain("shutdown")
    expect(r.clock.t - 1_000_000).toBe(DEADLINE)
  })

  it("when the resume itself fails, asks for nothing, keeps the asleep mark, and does not remount into a frozen guest", async () => {
    const r = rig({ frozen: "asleep", watcher: true, resumeFails: true })
    expect(await stopped(r.seams)).toBe(1)
    expect(r.events).toEqual(["stopWatcher", "beforeDown", "resume", "hold", "ensureWatcher"])
    expect(markedAsleep(pathsFor(NAME), OWN_PID)).toBe(true)
  })
})
