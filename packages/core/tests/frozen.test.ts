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
