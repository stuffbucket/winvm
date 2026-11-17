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
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
  CLOSE_POLICIES,
  checkTitle,
  configPath,
  DEFAULTS,
  effectiveConfig,
  parseAssignment,
  readOverrides,
  writeAssignments,
} from "../src/config"
import { readSince, START } from "../src/eventlog"
import { buildIdentity } from "../src/identity"
import type { Decision, Sample, Settings, Timing } from "../src/idle"
import { autosaveName, IdleMachine, savesToRotate } from "../src/idle"
import { instanceDir, PACKAGE_DIR, pathsFor } from "../src/paths"
import { STOW_REFUSED } from "../src/saves"
import {
  ensureWatcher,
  idleSettings,
  noteStowRefused,
  parseCpuTime,
  readWatchState,
  stopWatcher,
  stowOutcome,
  watchAfterRestore,
  watcherFreshness,
  watcherRecord,
  watchPathsFor,
} from "../src/watch"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"

const MIN = 60_000
const TIMING: Timing = {
  tickMs: 15_000,
  wakeGapMs: 45_000,
  cpuWindowMs: 60_000,
  settleMs: 60_000,
  driftCheckMs: 30 * MIN,
}
const SETTINGS: Settings = {
  idleCpuPercent: 5,
  autosave: { enabled: true, idleMinutes: 10 },
  stow: { enabled: true, idleMinutes: 60 },
}

class Harness {
  now = 1_700_000_000_000
  readonly machine = new IdleMachine(this.now, TIMING)
  activityAt: number | null = null
  vnc = 0
  frozen = false
  readonly log: { readonly at: number; readonly d: Decision }[] = []

  private readonly settings: Settings

  constructor(settings: Settings = SETTINGS) {
    this.settings = settings
  }

  tick(cpu: number | null, advanceMs = TIMING.tickMs): Decision[] {
    this.now += advanceMs
    const s: Sample = {
      wallMs: this.now,
      cpu,
      activityAtMs: this.activityAt,
      vncClients: this.vnc,
      frozen: this.frozen,
    }
    const ds = this.machine.tick(s, this.settings)
    for (const d of ds) {
      this.log.push({ at: this.now, d })
      if (d.kind === "autosave") this.machine.actionDone(this.now)
    }
    return ds
  }

  run(minutes: number, cpu: number): void {
    for (let t = 0; t < (minutes * MIN) / TIMING.tickMs; t += 1) this.tick(cpu)
  }

  kinds(kind: Decision["kind"]): number[] {
    return this.log.filter((e) => e.d.kind === kind).map((e) => e.at)
  }
}

const IDLE = 0.004
const BUSY = 0.25

describe("idle state machine", () => {
  it("autosaves once per idle stretch, and again only after real activity", () => {
    const h = new Harness()
    h.run(9.5, IDLE)
    expect(h.kinds("autosave")).toHaveLength(0)
    h.run(1, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)

    h.run(30, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)

    h.run(2, BUSY)
    const busyEnded = h.now
    h.run(12, IDLE)
    const saves = h.kinds("autosave")
    expect(saves).toHaveLength(2)
    const second = saves[1] ?? 0
    expect(second - busyEnded).toBeGreaterThanOrEqual(10 * MIN)
    expect(second - busyEnded).toBeLessThanOrEqual(11 * MIN + TIMING.tickMs)
  })

  it("does not count the CPU of its own save as activity", () => {
    const h = new Harness()
    h.run(10.25, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
    h.tick(0.9)
    h.tick(0.5)
    h.run(20, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
    expect(h.machine.autosaveArmed).toBe(false)
  })

  it("ignores a single background spike but not sustained load", () => {
    const h = new Harness()
    h.run(5, IDLE)
    h.tick(0.167)
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
    expect(h.kinds("autosave")).toHaveLength(1)
  })

  it("stow supersedes an autosave due at the same moment", () => {
    const h = new Harness({
      ...SETTINGS,
      autosave: { enabled: true, idleMinutes: 5 },
      stow: { enabled: true, idleMinutes: 5 },
    })
    h.run(6, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
    expect(h.kinds("autosave")).toHaveLength(0)
  })

  it("retries a failed stow only after another full idle period", () => {
    const h = new Harness({
      ...SETTINGS,
      autosave: { enabled: false, idleMinutes: 10 },
    })
    h.run(60.25, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
    h.machine.stowFailed(h.now)
    h.run(59, IDLE)
    expect(h.kinds("stow")).toHaveLength(1)
    h.run(1.25, IDLE)
    expect(h.kinds("stow")).toHaveLength(2)
  })

  it("honours disabled autosave and stow", () => {
    const h = new Harness({
      ...SETTINGS,
      autosave: { enabled: false, idleMinutes: 10 },
      stow: { enabled: false, idleMinutes: 60 },
    })
    h.run(120, IDLE)
    expect(h.log.filter((e) => e.d.kind !== "checkDrift")).toEqual([])
  })

  it("syncs the clock after host sleep, and does not count the sleep as idle time", () => {
    const h = new Harness()
    h.run(8, IDLE)
    const ds = h.tick(IDLE, 8 * 60 * MIN)
    expect(ds).toEqual([{ kind: "syncClock", reason: "wake" }])
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
    h.tick(IDLE, TIMING.tickMs + 40_000)
    expect(h.kinds("syncClock")).toHaveLength(0)
    h.machine.actionDone(h.now + 5 * MIN)
    h.now += 5 * MIN
    h.tick(IDLE)
    expect(h.kinds("syncClock")).toHaveLength(0)
  })

  it("asks for a drift check every 30 minutes", () => {
    const h = new Harness({
      ...SETTINGS,
      autosave: { enabled: false, idleMinutes: 10 },
      stow: { enabled: false, idleMinutes: 60 },
    })
    h.run(95, IDLE)
    expect(h.kinds("checkDrift")).toHaveLength(3)
  })

  it("never autosaves or stows a paused guest, however long it is paused", () => {
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
    h.tick(IDLE)
    expect(h.kinds("stow")).toHaveLength(0)
    expect(h.kinds("autosave")).toHaveLength(0)
    expect(h.machine.idleMs(h.now)).toBeLessThanOrEqual(TIMING.tickMs)
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
    expect(h.tick(IDLE, -10 * MIN)).toEqual([
      { kind: "syncClock", reason: "clock-jump" },
    ])
  })
})

describe("autosave rotation", () => {
  const at = (min: number): string =>
    new Date(Date.UTC(2026, 9, 21, 12, min)).toISOString()
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
    expect(savesToRotate(saves, 1)).toEqual([
      "auto-6",
      "auto-4",
      "auto-2",
      "auto-1",
    ])
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
    expect(autosaveName(Date.UTC(2026, 9, 21, 16, 43, 7, 250))).toBe(
      "auto-20261021T164307Z",
    )
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
  const before = process.env.WINVM_HOME
  beforeAll(() => {
    process.env.WINVM_HOME = home
  })
  afterAll(() => {
    if (before === undefined) delete process.env.WINVM_HOME
    else process.env.WINVM_HOME = before
    rmSync(home, { recursive: true, force: true })
  })

  it("defaults, overrides, and back to default", () => {
    expect(effectiveConfig("t")).toEqual(DEFAULTS)
    writeAssignments("t", [
      parseAssignment("autosave.idleMinutes=1"),
      parseAssignment("stow.enabled=off"),
    ])
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
    expect(parseAssignment("title=  Build box  ")).toEqual([
      "title",
      "Build box",
    ])
    expect(parseAssignment("title=a=b")).toEqual(["title", "a=b"])
    writeAssignments("titled", [
      parseAssignment("title=Build box"),
      parseAssignment("stow.enabled=off"),
    ])
    expect(effectiveConfig("titled").title).toBe("Build box")
    writeAssignments("titled", [parseAssignment("title=")])
    expect(readOverrides("titled")).toEqual({ "stow.enabled": false })
    expect(() => parseAssignment(`title=${"x".repeat(81)}`)).toThrow("80")
    expect(() => parseAssignment("title=two\nlines")).toThrow("control")
  })

  it("rejects exactly the C0 and C1 controls and the line separators in a title", () => {
    const rejected = [0x00, 0x09, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029]
    for (const c of rejected)
      expect(() => checkTitle(`a${String.fromCharCode(c)}b`)).toThrow("control")
    const accepted = [0x20, 0x7e, 0xa0, 0x2027, 0x202a, 0xfeff]
    for (const c of accepted) {
      const title = `a${String.fromCharCode(c)}b`
      expect(checkTitle(title)).toBe(title)
    }
    expect(checkTitle("a\u{1f600}b")).toBe("a\u{1f600}b")
    expect(checkTitle("a\ud800b")).toBe("a\ud800b")
  })

  it("ignores a title in config.json that would not pass the check", () => {
    mkdirSync(instanceDir("edited"), { recursive: true })
    writeFileSync(
      configPath("edited"),
      JSON.stringify({ title: "bad\u0007bell", "stow.enabled": false }),
    )
    expect(readOverrides("edited")).toEqual({ "stow.enabled": false })
    writeFileSync(configPath("edited"), JSON.stringify({ title: 42 }))
    expect(effectiveConfig("edited").title).toBe("")
  })
})

describe("instance settings: close policy", () => {
  const home = mkdtempSync(resolve(tmpdir(), "winvm-closepolicy-"))
  const before = process.env.WINVM_HOME
  beforeAll(() => {
    process.env.WINVM_HOME = home
  })
  afterAll(() => {
    if (before === undefined) delete process.env.WINVM_HOME
    else process.env.WINVM_HOME = before
    rmSync(home, { recursive: true, force: true })
  })

  it("lists exactly four policies, and ask is the default", () => {
    expect(CLOSE_POLICIES).toEqual(["ask", "leave", "stow", "shutdown"])
    expect(DEFAULTS["viewer.closePolicy"]).toBe("ask")
  })

  it("accepts each policy exactly", () => {
    for (const policy of CLOSE_POLICIES)
      expect(parseAssignment(`viewer.closePolicy=${policy}`)).toEqual([
        "viewer.closePolicy",
        policy,
      ])
  })

  it("rejects case variants and unknown values, listing what is allowed", () => {
    for (const bad of [
      "Ask",
      "LEAVE",
      "Stow",
      "shutDown",
      "pause",
      "",
      "leave now",
    ]) {
      expect(() => parseAssignment(`viewer.closePolicy=${bad}`)).toThrow(
        "ask, leave, stow, shutdown",
      )
    }
  })

  it("does not apply title validation to it", () => {
    expect(() =>
      parseAssignment(`viewer.closePolicy=${"x".repeat(81)}`),
    ).not.toThrow("80")
  })

  it("falls back to ask for an invalid value on disk, keeping valid neighbours", () => {
    mkdirSync(instanceDir("badpolicy"), { recursive: true })
    for (const bad of ["Ask", "pause", "", 3, null, true]) {
      writeFileSync(
        configPath("badpolicy"),
        JSON.stringify({ "viewer.closePolicy": bad, "stow.enabled": false }),
      )
      expect(readOverrides("badpolicy")).toEqual({ "stow.enabled": false })
      expect(effectiveConfig("badpolicy")["viewer.closePolicy"]).toBe("ask")
    }
  })

  it("persists a non-default policy and reads it back", () => {
    writeAssignments("chosen", [parseAssignment("viewer.closePolicy=shutdown")])
    expect(readOverrides("chosen")).toEqual({
      "viewer.closePolicy": "shutdown",
    })
    expect(effectiveConfig("chosen")["viewer.closePolicy"]).toBe("shutdown")
  })

  it("writing ask removes the override and keeps unrelated settings", () => {
    writeAssignments("reset", [
      parseAssignment("viewer.closePolicy=stow"),
      parseAssignment("title=Build box"),
      parseAssignment("stow.enabled=off"),
    ])
    writeAssignments("reset", [parseAssignment("viewer.closePolicy=ask")])
    expect(readOverrides("reset")).toEqual({
      title: "Build box",
      "stow.enabled": false,
    })
    expect(
      JSON.parse(readFileSync(configPath("reset"), "utf8")),
    ).not.toHaveProperty("viewer.closePolicy")
    expect(effectiveConfig("reset")["viewer.closePolicy"]).toBe("ask")
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
  const before = process.env.WINVM_HOME
  beforeAll(() => {
    process.env.WINVM_HOME = home
  })
  afterAll(() => {
    if (before === undefined) delete process.env.WINVM_HOME
    else process.env.WINVM_HOME = before
    rmSync(home, { recursive: true, force: true })
  })
  it("never starts one with watch.enabled=false", () => {
    writeAssignments("off", [parseAssignment("watch.enabled=false")])
    expect(ensureWatcher("off")).toBeNull()
  })
})

describe("watcher generations", () => {
  const CURRENT = "sha256:current"
  let home = ""
  let savedHome: string | undefined
  const spawned: ReturnType<typeof Bun.spawn>[] = []

  beforeEach(() => {
    savedHome = process.env.WINVM_HOME
    home = mkdtempSync(resolve(tmpdir(), "winvm-watchgen-"))
    process.env.WINVM_HOME = home
    mkdirSync(instanceDir("w"), { recursive: true })
  })
  afterEach(() => {
    for (const s of spawned.splice(0)) s.kill()
    if (savedHome === undefined) delete process.env.WINVM_HOME
    else process.env.WINVM_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  const fakeWatcher = (): ReturnType<typeof Bun.spawn> => {
    const holder = resolve(import.meta.dir, "fakes", "holder.ts")
    const h = Bun.spawn(
      [process.execPath, holder, "winvm", "watch", "-i", "w"],
      { stdout: "ignore", stderr: "ignore" },
    )
    spawned.push(h)
    return h
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const lock = (pid: number): void => {
    writeFileSync(watchPathsFor("w").pid, `${String(pid)}\n`)
  }
  const state = (o: Record<string, unknown>): void => {
    writeFileSync(watchPathsFor("w").state, JSON.stringify(o))
  }

  it("classifies a record by its build: current, stale, or legacy when it has none", () => {
    expect(watcherFreshness({ pid: 1, build: CURRENT }, CURRENT)).toBe(
      "current",
    )
    expect(watcherFreshness({ pid: 1, build: "sha256:old" }, CURRENT)).toBe(
      "stale",
    )
    expect(watcherFreshness({ pid: 1 }, CURRENT)).toBe("legacy")
    expect(watcherFreshness({ pid: 1, build: buildIdentity() })).toBe("current")
  })

  it("reads the pid and build of a live watcher", () => {
    const h = fakeWatcher()
    lock(h.pid)
    state({ pid: h.pid, build: CURRENT, state: "watching" })
    expect(watcherRecord("w")).toEqual({ pid: h.pid, build: CURRENT })
  })

  it("has no record without a live watcher, and drops the pidfile of a reused pid without signalling it", () => {
    expect(watcherRecord("w")).toBeNull()
    const stranger = Bun.spawn(["sleep", "20"])
    spawned.push(stranger)
    lock(stranger.pid)
    state({ pid: stranger.pid, build: CURRENT })
    expect(watcherRecord("w")).toBeNull()
    expect(existsSync(watchPathsFor("w").pid)).toBe(false)
    expect(alive(stranger.pid)).toBe(true)
  })

  it("does not trust a watch.json written by a different pid than watch.pid's", () => {
    const h = fakeWatcher()
    lock(h.pid)
    state({ pid: h.pid + 1, build: CURRENT })
    const rec = watcherRecord("w")
    expect(rec).toEqual({ pid: h.pid })
    expect(watcherFreshness(rec ?? { pid: 0 }, CURRENT)).toBe("legacy")
  })

  it("treats a live watcher whose watch.json has no build as legacy", () => {
    const h = fakeWatcher()
    lock(h.pid)
    state({ pid: h.pid, state: "watching" })
    const rec = watcherRecord("w")
    expect(rec).toEqual({ pid: h.pid })
    expect(watcherFreshness(rec ?? { pid: 0 }, CURRENT)).toBe("legacy")
  })

  it("keeps a running watcher rather than starting a second, whatever its generation", () => {
    const h = fakeWatcher()
    lock(h.pid)
    state({ pid: h.pid, build: "sha256:old" })
    expect(ensureWatcher("w")).toBe(h.pid)
  })

  const seams = (o: { readonly dies: "never" | "on-term" }) => {
    const calls: { sig: string; at: number }[] = []
    let t = 1_000
    let gone = false
    return {
      calls,
      elapsed: (): number => t - 1_000,
      seams: {
        kill: (_pid: number, sig: NodeJS.Signals): void => {
          calls.push({ sig, at: t })
          if (sig === "SIGKILL" || o.dies === "on-term") gone = true
        },
        now: (): number => t,
        sleep: (ms: number): Promise<void> => {
          t += ms
          return Promise.resolve()
        },
        isWatcher: (): boolean => !gone,
      },
    }
  }

  it("gives a watcher that is only watching 10 seconds to finish, then kills it", async () => {
    lock(424_242)
    state({ pid: 424_242, build: CURRENT, state: "watching" })
    const s = seams({ dies: "never" })
    expect(await stopWatcher("w", s.seams)).toBe(true)
    expect(s.calls.map((c) => c.sig)).toEqual(["SIGTERM", "SIGKILL"])
    expect(s.elapsed()).toBeGreaterThanOrEqual(10_000)
    expect(s.elapsed()).toBeLessThan(11_000)
    expect(existsSync(watchPathsFor("w").pid)).toBe(false)
  })

  for (const st of ["autosaving", "stowing"] as const) {
    it(`gives a watcher that is ${st} 10 minutes to finish`, async () => {
      lock(424_242)
      state({ pid: 424_242, build: CURRENT, state: st })
      const s = seams({ dies: "never" })
      expect(await stopWatcher("w", s.seams)).toBe(true)
      expect(s.calls.map((c) => c.sig)).toEqual(["SIGTERM", "SIGKILL"])
      expect(s.elapsed()).toBeGreaterThanOrEqual(600_000)
      expect(s.elapsed()).toBeLessThan(601_000)
    })
  }

  it("does not kill a watcher that exits after SIGTERM", async () => {
    lock(424_242)
    state({ pid: 424_242, state: "autosaving" })
    const s = seams({ dies: "on-term" })
    expect(await stopWatcher("w", s.seams)).toBe(true)
    expect(s.calls.map((c) => c.sig)).toEqual(["SIGTERM"])
  })

  it("believes watch.json's autosaving only when it names the watcher being stopped", async () => {
    lock(424_242)
    state({ pid: 424_243, build: CURRENT, state: "autosaving" })
    const s = seams({ dies: "never" })
    expect(await stopWatcher("w", s.seams)).toBe(true)
    expect(s.elapsed()).toBeGreaterThanOrEqual(10_000)
    expect(s.elapsed()).toBeLessThan(11_000)
  })

  it("re-checks the pid is still a watcher's just before SIGKILL", async () => {
    lock(424_242)
    state({ pid: 424_242, build: CURRENT, state: "watching" })
    let t = 1_000
    const kills: string[] = []
    const result = await stopWatcher("w", {
      kill: (_pid, sig) => void kills.push(sig),
      now: () => t,
      sleep: (ms) => {
        t += ms
        return Promise.resolve()
      },
      isWatcher: () => t < 11_000,
    })
    expect(result).toBe(true)
    expect(kills).toEqual(["SIGTERM"])
  })

  it("signals nobody when watch.pid names a process that is not a watcher", async () => {
    const stranger = Bun.spawn(["sleep", "20"])
    spawned.push(stranger)
    lock(stranger.pid)
    const kills: string[] = []
    expect(
      await stopWatcher("w", { kill: (_p, sig) => void kills.push(sig) }),
    ).toBe(false)
    expect(kills).toEqual([])
    expect(alive(stranger.pid)).toBe(true)
  })

  for (const [label, argv] of [
    ["another instance's watcher", ["winvm", "watch", "-i", "other"]],
    [
      "the watcher of an instance whose name starts with this one's",
      ["winvm", "watch", "-i", "wx"],
    ],
    [
      "a watcher named with --instance=",
      ["winvm", "watch", "--instance=other"],
    ],
    [
      "a `watch --stop` for this instance",
      ["winvm", "watch", "-i", "w", "--stop"],
    ],
    [
      "an unrelated executable whose name ends in winvm",
      ["evilwinvm", "watch", "-i", "w"],
    ],
  ] as const) {
    it(`never takes ${label} for this instance's watcher, before SIGTERM or SIGKILL`, async () => {
      const holder = resolve(import.meta.dir, "fakes", "holder.ts")
      const h = Bun.spawn([process.execPath, holder, ...argv], {
        stdout: "ignore",
        stderr: "ignore",
      })
      spawned.push(h)
      lock(h.pid)
      state({ pid: h.pid, build: CURRENT, state: "watching" })
      const kills: string[] = []
      let t = 0
      const stopped = await stopWatcher("w", {
        kill: (_p, sig) => void kills.push(sig),
        now: () => t,
        sleep: (ms) => {
          t += ms
          return Promise.resolve()
        },
      })
      expect(kills).toEqual([])
      expect(stopped).toBe(false)
      expect(watcherRecord("w")).toBeNull()
      expect(alive(h.pid)).toBe(true)
    })
  }

  it("still recognises this instance's own watcher, however it was named", () => {
    const holder = resolve(import.meta.dir, "fakes", "holder.ts")
    for (const argv of [
      ["winvm", "watch", "-i", "w"],
      ["winvm.ts", "watch", "--instance", "w"],
      ["winvm", "watch", "--instance=w"],
      ["winvm-aarch64-apple-darwin", "watch", "-i", "w"],
    ]) {
      const h = Bun.spawn([process.execPath, holder, ...argv], {
        stdout: "ignore",
        stderr: "ignore",
      })
      spawned.push(h)
      lock(h.pid)
      expect(watcherRecord("w")?.pid).toBe(h.pid)
    }
  })

  it("publishes its build as soon as it holds the lock, and in every later state", async () => {
    const cli = resolve(
      PACKAGE_DIR,
      "..",
      "..",
      "apps",
      "cli",
      "src",
      "winvm.ts",
    )
    const p = pathsFor("w")
    writeFileSync(p.meta, JSON.stringify({ image: "x", vnc: 9, created: "" }))
    await lockPidfile(p.pid, "qemu-system-aarch64")
    const env: Record<string, string | undefined> = {
      ...process.env,
      WINVM_HOME: home,
    }
    delete env.WINVM_BUILD_ID
    const child = Bun.spawn([process.execPath, cli, "watch", "-i", "w"], {
      env,
      stdout: "pipe",
      stderr: "ignore",
    })
    spawned.push(child)
    let output = ""
    const decoder = new TextDecoder()
    void (async () => {
      for await (const chunk of child.stdout) output += decoder.decode(chunk)
    })()
    try {
      while (readWatchState("w")?.build === undefined)
        await new Promise((r) => setTimeout(r, 5))
      expect(readWatchState("w")).toMatchObject({
        pid: child.pid,
        build: buildIdentity(),
      })
      expect(watcherRecord("w")).toEqual({
        pid: child.pid,
        build: buildIdentity(),
        cli,
      })
      while (!output.includes("watching qemu pid"))
        await new Promise((r) => setTimeout(r, 5))
      child.kill("SIGTERM")
      await child.exited
      expect(
        JSON.parse(readFileSync(watchPathsFor("w").state, "utf8")),
      ).toMatchObject({ state: "stopped", build: buildIdentity() })
    } finally {
      child.kill("SIGKILL")
      await releasePidfiles()
    }
  }, 30_000)
})

describe("an idle stow that winvm refuses", () => {
  it("is told apart from a failed stow by winvm stow's exit code", () => {
    expect(stowOutcome(0)).toBe("stowed")
    expect(stowOutcome(STOW_REFUSED)).toBe("refused")
    expect(stowOutcome(1)).toBe("failed")
  })

  it("turns idle stows off for the rest of this QEMU, leaving autosave alone", () => {
    expect(
      idleSettings(SETTINGS, { ephemeral: false, stowRefused: true }),
    ).toEqual({
      ...SETTINGS,
      stow: { ...SETTINGS.stow, enabled: false },
    })
    expect(
      idleSettings(SETTINGS, { ephemeral: false, stowRefused: false }),
    ).toEqual(SETTINGS)
    expect(
      idleSettings(SETTINGS, { ephemeral: true, stowRefused: false }).autosave
        .enabled,
    ).toBe(false)
  })

  it("is recorded once, however often it comes back", () => {
    rmSync(instanceDir("refused"), { recursive: true, force: true })
    mkdirSync(instanceDir("refused"), { recursive: true })
    const logged: string[] = []
    const log = (line: string): void => {
      logged.push(line)
    }
    expect(noteStowRefused("refused", false, log)).toBe(true)
    expect(noteStowRefused("refused", true, log)).toBe(true)
    const refusals = readSince("refused", START).entries.filter(
      (e) => e.kind === "warning" && e.what === "stow refused",
    )
    expect(refusals).toHaveLength(1)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain("idle stows are off")
  })
})
