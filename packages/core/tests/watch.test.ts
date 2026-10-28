/**
 * The watcher's decisions, driven by a fake clock and fake samples — no VM.
 *
 *   pnpm test   (or: bun test)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { DEFAULTS, configPath, effectiveConfig, parseAssignment, readOverrides, writeAssignments } from "../src/config"
import { instanceDir } from "../src/paths"
import type { Decision, Sample, Settings, Timing } from "../src/idle"
import { IdleMachine, autosaveName, savesToRotate } from "../src/idle"
import { ensureWatcher, parseCpuTime, watchAfterRestore } from "../src/watch"

const MIN = 60_000
const TIMING: Timing = { tickMs: 15_000, wakeGapMs: 45_000, cpuWindowMs: 60_000, settleMs: 60_000, driftCheckMs: 30 * MIN }
const SETTINGS: Settings = {
  idleCpuPercent: 5,
  autosave: { enabled: true, idleMinutes: 10 },
  stow: { enabled: true, idleMinutes: 60 },
}

/** Drives an IdleMachine tick by tick, like the watcher loop does. */
class Harness {
  now = 1_700_000_000_000
  readonly machine = new IdleMachine(this.now, TIMING)
  activityAt: number | null = null
  vnc = 0
  /** The guest is paused or asleep. */
  frozen = false
  readonly log: { readonly at: number; readonly d: Decision }[] = []

  private readonly settings: Settings

  constructor(settings: Settings = SETTINGS) {
    this.settings = settings
  }

  tick(cpu: number | null, advanceMs = TIMING.tickMs): Decision[] {
    this.now += advanceMs
    const s: Sample = { wallMs: this.now, cpu, activityAtMs: this.activityAt, vncClients: this.vnc, frozen: this.frozen }
    const ds = this.machine.tick(s, this.settings)
    for (const d of ds) {
      this.log.push({ at: this.now, d })
      // The loop reports back after running an action, as watch.ts does.
      if (d.kind === "autosave") this.machine.actionDone(this.now)
    }
    return ds
  }

  /** Tick `minutes` worth at a fixed CPU share. */
  run(minutes: number, cpu: number): void {
    for (let t = 0; t < (minutes * MIN) / TIMING.tickMs; t += 1) this.tick(cpu)
  }

  kinds(kind: Decision["kind"]): number[] {
    return this.log.filter((e) => e.d.kind === kind).map((e) => e.at)
  }
}

const IDLE = 0.004 // measured: an idle desktop is 0.3-1% of 4 vCPUs
const BUSY = 0.25 // one busy thread

describe("idle state machine", () => {
  it("autosaves once per idle stretch, and again only after real activity", () => {
    const h = new Harness()
    h.run(9.5, IDLE)
    expect(h.kinds("autosave")).toHaveLength(0)
    h.run(1, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)

    // Still idle, long past the threshold: no second save.
    h.run(30, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)

    // Used, then idle again: a second save, idleMinutes after the activity stopped.
    h.run(2, BUSY)
    const busyEnded = h.now
    h.run(12, IDLE)
    const saves = h.kinds("autosave")
    expect(saves).toHaveLength(2)
    const second = saves[1] ?? 0
    // The 1-minute CPU average is what delays it by up to a minute.
    expect(second - busyEnded).toBeGreaterThanOrEqual(10 * MIN)
    expect(second - busyEnded).toBeLessThanOrEqual(11 * MIN + TIMING.tickMs)
  })

  it("does not count the CPU of its own save as activity", () => {
    const h = new Harness()
    h.run(10.25, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
    // The save made QEMU busy for a while; the samples right after say so.
    h.tick(0.9)
    h.tick(0.5)
    h.run(20, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
    expect(h.machine.autosaveArmed).toBe(false)
  })

  it("ignores a single background spike but not sustained load", () => {
    const h = new Harness()
    h.run(5, IDLE)
    h.tick(0.167) // one Defender/indexer burst, as measured: 16.7% for one sample
    h.run(5.25, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)

    const g = new Harness()
    g.run(5, IDLE)
    g.run(1, 0.2)
    g.run(5.25, IDLE)
    expect(g.kinds("autosave")).toHaveLength(0)
  })

  it("treats `winvm exec` activity as use", () => {
    const h = new Harness()
    h.run(10.25, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
    h.activityAt = h.now + 1000
    h.run(5, IDLE)
    expect(h.machine.autosaveArmed).toBe(true)
    h.run(5.5, IDLE)
    expect(h.kinds("autosave")).toHaveLength(2)
  })

  it("never goes idle while a VNC client is connected", () => {
    const h = new Harness()
    h.vnc = 1
    h.run(90, IDLE)
    expect(h.kinds("autosave")).toHaveLength(0)
    expect(h.kinds("stow")).toHaveLength(0)
    h.vnc = 0
    h.run(10.25, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
  })

  it("stows after the longer threshold, once, and stops deciding", () => {
    const h = new Harness()
    h.run(59.5, IDLE)
    expect(h.kinds("stow")).toHaveLength(0)
    h.run(1, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
    h.run(30, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
    expect(h.kinds("autosave")).toHaveLength(1) // the one at 10 min
  })

  it("stow supersedes an autosave due at the same moment", () => {
    const h = new Harness({ ...SETTINGS, autosave: { enabled: true, idleMinutes: 5 }, stow: { enabled: true, idleMinutes: 5 } })
    h.run(6, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
    expect(h.kinds("autosave")).toHaveLength(0)
  })

  it("retries a failed stow only after another full idle period", () => {
    const h = new Harness({ ...SETTINGS, autosave: { enabled: false, idleMinutes: 10 } })
    h.run(60.25, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
    h.machine.stowFailed(h.now)
    h.run(59, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
    h.run(1.25, IDLE)
    expect(h.kinds("stow")).toHaveLength(2)
  })

  it("honours disabled autosave and stow", () => {
    const h = new Harness({ ...SETTINGS, autosave: { enabled: false, idleMinutes: 10 }, stow: { enabled: false, idleMinutes: 60 } })
    h.run(120, IDLE)
    expect(h.log.filter((e) => e.d.kind !== "checkDrift")).toEqual([])
  })

  it("syncs the clock after host sleep, and does not count the sleep as idle time", () => {
    const h = new Harness()
    h.run(8, IDLE)
    // Lid shut for 8 hours: the next tick lands 8 h later on the wall clock.
    const ds = h.tick(IDLE, 8 * 60 * MIN)
    expect(ds).toEqual([{ kind: "syncClock", reason: "wake" }])
    // Neither autosave (was 2 min away) nor stow fired on wake.
    expect(h.kinds("autosave")).toHaveLength(0)
    expect(h.kinds("stow")).toHaveLength(0)
    expect(h.machine.idleMs(h.now)).toBe(0)
    h.run(9.5, IDLE)
    expect(h.kinds("autosave")).toHaveLength(0)
    h.run(1, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
  })

  it("does not mistake a late tick or a long action for sleep", () => {
    const h = new Harness()
    h.tick(IDLE, TIMING.tickMs + 40_000) // a loaded host delays a timer by 40 s
    expect(h.kinds("syncClock")).toHaveLength(0)
    // A five-minute save, reported through actionDone, is not a gap either.
    h.machine.actionDone(h.now + 5 * MIN)
    h.now += 5 * MIN
    h.tick(IDLE)
    expect(h.kinds("syncClock")).toHaveLength(0)
  })

  it("asks for a drift check every 30 minutes", () => {
    const h = new Harness({ ...SETTINGS, autosave: { enabled: false, idleMinutes: 10 }, stow: { enabled: false, idleMinutes: 60 } })
    h.run(95, IDLE)
    expect(h.kinds("checkDrift")).toHaveLength(3)
  })

  it("never autosaves or stows a paused guest, however long it is paused", () => {
    // A paused guest's CPU reads as idle (0.1% measured on pause-test).
    const h = new Harness()
    h.frozen = true
    h.run(6 * 60, 0.001)
    expect(h.kinds("autosave")).toHaveLength(0)
    expect(h.kinds("stow")).toHaveLength(0)
    expect(h.kinds("checkDrift")).toHaveLength(0)
    expect(h.machine.lastVerdict.reasons).toEqual(["paused"])
  })

  it("does not count time paused as idle: the idle clock starts again on resume", () => {
    const h = new Harness()
    h.run(8, IDLE)
    h.frozen = true
    h.run(120, 0.001)
    h.frozen = false
    // Resumed after two hours: not stowed, not autosaved, on the spot.
    h.tick(IDLE)
    expect(h.kinds("stow")).toHaveLength(0)
    expect(h.kinds("autosave")).toHaveLength(0)
    expect(h.machine.idleMs(h.now)).toBeLessThanOrEqual(TIMING.tickMs)
    // Left idle after resuming, it is treated like any idle guest.
    h.run(10.25, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
    h.run(50, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
  })

  it("an autosave due as the guest is paused is held until it runs and idles again", () => {
    const h = new Harness()
    h.run(9.75, IDLE)
    h.frozen = true
    h.run(30, 0.001)
    expect(h.kinds("autosave")).toHaveLength(0)
    h.frozen = false
    h.run(9.5, IDLE)
    expect(h.kinds("autosave")).toHaveLength(0)
    h.run(1, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
  })

  it("treats the wall clock going backwards as a jump to resync", () => {
    const h = new Harness()
    h.tick(IDLE)
    expect(h.tick(IDLE, -10 * MIN)).toEqual([{ kind: "syncClock", reason: "clock-jump" }])
  })
})

describe("autosave rotation", () => {
  const at = (min: number): string => new Date(Date.UTC(2026, 9, 21, 12, min)).toISOString()
  const saves = [
    { name: "auto-1", kind: "auto", createdAt: at(1) },
    { name: "baseline", kind: "baseline", createdAt: at(0) },
    { name: "auto-2", kind: "auto", createdAt: at(2) },
    { name: "mine", kind: "manual", createdAt: at(3) },
    { name: "auto-4", kind: "auto", createdAt: at(4) },
    { name: "stow-5", kind: "stow", createdAt: at(5) },
    { name: "auto-6", kind: "auto", createdAt: at(6) },
    { name: "auto-7", kind: "auto", createdAt: at(7) },
  ]

  it("keeps the newest N auto saves and deletes the rest", () => {
    expect(savesToRotate(saves, 3)).toEqual(["auto-2", "auto-1"])
    expect(savesToRotate(saves, 1)).toEqual(["auto-6", "auto-4", "auto-2", "auto-1"])
    expect(savesToRotate(saves, 10)).toEqual([])
  })

  it("never deletes manual, baseline or stow saves", () => {
    const victims = savesToRotate(saves, 0)
    expect(victims).not.toContain("baseline")
    expect(victims).not.toContain("mine")
    expect(victims).not.toContain("stow-5")
    expect(victims).toHaveLength(5)
  })

  it("names autosaves sortably", () => {
    expect(autosaveName(Date.UTC(2026, 9, 21, 16, 43, 7, 250))).toBe("auto-20261021T164307Z")
  })
})

describe("ps cpu time", () => {
  it("parses every TIME shape ps prints", () => {
    expect(parseCpuTime("  0:41.97")).toBeCloseTo(41.97)
    expect(parseCpuTime("123:05.40")).toBeCloseTo(7385.4)
    expect(parseCpuTime("1:02:03")).toBe(3723)
    expect(parseCpuTime("2-01:00:00")).toBe(2 * 86_400 + 3600)
    expect(parseCpuTime("")).toBeNull()
  })
})

describe("instance config", () => {
  const home = mkdtempSync(resolve(tmpdir(), "winvm-config-"))
  const before = process.env["WINVM_HOME"]
  beforeAll(() => {
    process.env["WINVM_HOME"] = home
  })
  afterAll(() => {
    if (before === undefined) delete process.env["WINVM_HOME"]
    else process.env["WINVM_HOME"] = before
    rmSync(home, { recursive: true, force: true })
  })

  it("defaults, overrides, and back to default", () => {
    expect(effectiveConfig("t")).toEqual(DEFAULTS)
    writeAssignments("t", [parseAssignment("autosave.idleMinutes=1"), parseAssignment("stow.enabled=off")])
    expect(effectiveConfig("t")["autosave.idleMinutes"]).toBe(1)
    expect(effectiveConfig("t")["stow.enabled"]).toBe(false)
    writeAssignments("t", [parseAssignment("stow.enabled=true")])
    expect(readOverrides("t")).toEqual({ "autosave.idleMinutes": 1 })
  })

  it("rejects what would make the watcher silently misbehave", () => {
    expect(() => parseAssignment("autosave.idleMinutes=soon")).toThrow()
    expect(() => parseAssignment("autosave.idleMinutes=0")).toThrow()
    expect(() => parseAssignment("autosave.keep=2.5")).toThrow()
    expect(() => parseAssignment("stow.enabled=maybe")).toThrow()
    expect(() => parseAssignment("nope=1")).toThrow()
    expect(() => parseAssignment("autosave.enabled")).toThrow()
  })

  it("keeps a title for the Mac app, checked, and clears it when empty", () => {
    expect(effectiveConfig("titled").title).toBe("")
    expect(parseAssignment("title=  Build box  ")).toEqual(["title", "Build box"])
    expect(parseAssignment("title=a=b")).toEqual(["title", "a=b"])
    writeAssignments("titled", [parseAssignment("title=Build box"), parseAssignment("stow.enabled=off")])
    expect(effectiveConfig("titled").title).toBe("Build box")
    writeAssignments("titled", [parseAssignment("title=")])
    expect(readOverrides("titled")).toEqual({ "stow.enabled": false })
    expect(() => parseAssignment(`title=${"x".repeat(81)}`)).toThrow("80")
    expect(() => parseAssignment("title=two\nlines")).toThrow("control")
  })

  it("ignores a title in config.json that would not pass the check", () => {
    mkdirSync(instanceDir("edited"), { recursive: true })
    writeFileSync(configPath("edited"), JSON.stringify({ title: "bad\u0007bell", "stow.enabled": false }))
    expect(readOverrides("edited")).toEqual({ "stow.enabled": false })
    writeFileSync(configPath("edited"), JSON.stringify({ title: 42 }))
    expect(effectiveConfig("edited").title).toBe("")
  })
})

describe("watcher after a load or rewind", () => {
  it("starts one for a stopped instance, as start would", () => {
    expect(watchAfterRestore(false, false)).toBe(true)
  })
  it("keeps a running instance's choice: none if it ran without one", () => {
    expect(watchAfterRestore(true, false)).toBe(false)
    expect(watchAfterRestore(true, true)).toBe(true)
  })

  const home = mkdtempSync(resolve(tmpdir(), "winvm-rewatch-"))
  const before = process.env["WINVM_HOME"]
  beforeAll(() => {
    process.env["WINVM_HOME"] = home
  })
  afterAll(() => {
    if (before === undefined) delete process.env["WINVM_HOME"]
    else process.env["WINVM_HOME"] = before
    rmSync(home, { recursive: true, force: true })
  })
  it("never starts one with watch.enabled=false", () => {
    writeAssignments("off", [parseAssignment("watch.enabled=false")])
    expect(ensureWatcher("off")).toBeNull()
  })
})
