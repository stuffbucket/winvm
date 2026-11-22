import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
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
import type { Decision, Sample, Settings, Timing } from "../src/idle"
import {
  autosaveName,
  DEFAULT_TIMING,
  IdleMachine,
  savesToRotate,
  timingFrom,
} from "../src/idle"
import { instanceDir } from "../src/paths"
import { STOW_REFUSED, STOW_UNDECIDED } from "../src/saves"
import {
  caffeinateArgs,
  ensureWatcher,
  idleSettings,
  idleState,
  KeepAwake,
  noteStowRefused,
  parseCpuTime,
  stowOutcome,
  watchAfterRestore,
} from "../src/watch"

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
  vnc: number | null = 0
  frozen: boolean | null = false
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

  it("does not turn an unknown monitor or viewer count into an idle guest", () => {
    for (const sample of [
      { frozen: null, vnc: 0 },
      { frozen: false, vnc: null },
      { frozen: null, vnc: null },
    ]) {
      const h = new Harness()
      h.run(9.75, IDLE)
      h.frozen = sample.frozen
      h.vnc = sample.vnc
      h.run(90, IDLE)
      expect(h.kinds("autosave")).toHaveLength(0)
      expect(h.kinds("stow")).toHaveLength(0)
      expect(h.kinds("checkDrift")).toHaveLength(0)
      expect(h.machine.lastVerdict.quiet).toBe(false)
      expect(h.machine.idleMs(h.now)).toBe(0)
      h.frozen = false
      h.vnc = 0
      h.run(9.5, IDLE)
      expect(h.kinds("autosave")).toHaveLength(0)
      h.run(1, IDLE)
      expect(h.kinds("autosave")).toHaveLength(1)
    }
  })

  it("a missing monitor sample does not re-arm an autosave already taken", () => {
    const h = new Harness()
    h.run(10.25, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
    h.vnc = null
    h.run(20, IDLE)
    expect(h.machine.autosaveArmed).toBe(false)
    h.vnc = 0
    h.run(10.25, IDLE)
    expect(h.kinds("autosave")).toHaveLength(1)
  })

  it("still records known command or viewer activity when another monitor field is unknown", () => {
    for (const kind of ["command", "viewer"]) {
      const h = new Harness()
      h.run(10.25, IDLE)
      expect(h.machine.autosaveArmed).toBe(false)
      if (kind === "command") {
        h.vnc = null
        h.activityAt = h.now + 1000
      } else {
        h.vnc = 1
        h.frozen = null
      }
      h.run(1, IDLE)
      expect(h.machine.autosaveArmed).toBe(true)
      expect(h.kinds("autosave")).toHaveLength(1)
      h.vnc = 0
      h.frozen = false
      h.run(10.25, IDLE)
      expect(h.kinds("autosave")).toHaveLength(2)
    }
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

describe("the watcher's timing, as tests set it through the environment", () => {
  it("takes the positive numbers it knows and nothing else", () => {
    expect(timingFrom(undefined)).toEqual({})
    expect(timingFrom("")).toEqual({})
    expect(timingFrom("not json")).toEqual({})
    expect(timingFrom("[200]")).toEqual({})
    expect(
      timingFrom(
        JSON.stringify({
          tickMs: 200,
          wakeGapMs: 1500,
          driftCheckMs: 0,
          settleMs: -1,
          cpuWindowMs: "60",
          other: 5,
        }),
      ),
    ).toEqual({ tickMs: 200, wakeGapMs: 1500 })
    expect(Object.keys(DEFAULT_TIMING).toSorted()).toEqual([
      "cpuWindowMs",
      "driftCheckMs",
      "settleMs",
      "tickMs",
      "wakeGapMs",
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

  it("keeps protected autosaves outside the unprotected retention budget", () => {
    const locked = saves.map((s) => ({
      ...s,
      protected: s.name === "auto-7" || s.name === "auto-1",
    }))
    expect(savesToRotate(locked, 2)).toEqual(["auto-2"])
    expect(savesToRotate(locked, 0)).toEqual(["auto-6", "auto-4", "auto-2"])
    expect(
      savesToRotate(
        locked.map((s) => ({ ...s, protected: true })),
        0,
      ),
    ).toEqual([])
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

  it("rejects exactly the C0 and C1 controls, the line separators and the invisible and direction marks in a title", () => {
    const rejected = [
      0x00, 0x09, 0x1f, 0x7f, 0x85, 0x9f, 0x200b, 0x200e, 0x200f, 0x2028,
      0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff,
    ]
    for (const c of rejected)
      expect(() => checkTitle(`a${String.fromCharCode(c)}b`)).toThrow("control")
    const accepted = [0x20, 0x7e, 0xa0, 0x200c, 0x200d, 0x2027, 0x202f, 0x2065]
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
    expect(ensureWatcher("off")).toBe(false)
  })
})

describe("power.keepAwake", () => {
  type Child = NonNullable<
    ReturnType<typeof import("node:child_process").spawn>
  >
  const fake = (): {
    started: (readonly string[])[]
    killed: number
    start: (a: readonly string[]) => Child
  } => {
    const o = {
      started: [] as (readonly string[])[],
      killed: 0,
      start: (a: readonly string[]): Child => {
        o.started.push(a)
        return {
          kill: () => {
            o.killed += 1
            return true
          },
        } as unknown as Child
      },
    }
    return o
  }

  it("is off by default, so nothing changes for anyone who has not asked", () => {
    expect(DEFAULTS["power.keepAwake"]).toBe(false)
    const f = fake()
    expect(
      new KeepAwake(f.start).update(DEFAULTS["power.keepAwake"], 4242),
    ).toBeNull()
    expect(f.started).toEqual([])
  })

  it("holds the Mac awake for QEMU's lifetime, once, and says so", () => {
    const f = fake()
    const k = new KeepAwake(f.start)
    expect(k.update(true, 4242)).toContain("4242")
    expect(k.update(true, 4242)).toBeNull()
    expect(f.started).toEqual([caffeinateArgs(4242)])
    expect(caffeinateArgs(4242)).toEqual(["-i", "-w", "4242"])
  })

  it("follows QEMU being replaced and lets go when switched off", () => {
    const f = fake()
    const k = new KeepAwake(f.start)
    k.update(true, 1)
    k.update(true, 2)
    expect(f.started.map((a) => a[2])).toEqual(["1", "2"])
    expect(f.killed).toBe(1)
    expect(k.update(false, 2)).toContain("no longer")
    expect(f.killed).toBe(2)
    expect(k.update(false, 2)).toBeNull()
  })

  it("reports a Mac that will not run caffeinate instead of pretending", () => {
    expect(new KeepAwake(() => null).update(true, 7)).toContain(
      "could not start",
    )
  })

  it("is a setting that takes true or false", () => {
    expect(parseAssignment("power.keepAwake=on")).toEqual([
      "power.keepAwake",
      true,
    ])
    expect(() => parseAssignment("power.keepAwake=maybe")).toThrow()
  })
})

describe("an idle stow that winvm refuses", () => {
  it("is told apart from a failed stow by winvm stow's exit code", () => {
    expect(stowOutcome(0)).toBe("stowed")
    expect(stowOutcome(STOW_REFUSED)).toBe("refused")
    expect(stowOutcome(STOW_UNDECIDED)).toBe("failed")
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

  it("is published as idle stow off, with why, while it holds", () => {
    const cfg = { ...DEFAULTS, "stow.enabled": true }
    const latched = idleState(
      cfg,
      { ephemeral: false, stowRefused: true },
      { stow: "2026-11-17T08:00:00Z" },
    )
    expect(latched.stow.enabled).toBe(false)
    expect(latched.stow.off).toContain("refused")
    expect(latched.stow.off).toContain("until QEMU restarts")
    expect(latched.stow.lastAt).toBe("2026-11-17T08:00:00Z")
    expect(latched.autosave.enabled).toBe(cfg["autosave.enabled"])
    const free = idleState(cfg, { ephemeral: false, stowRefused: false }, {})
    expect(free.stow.enabled).toBe(true)
    expect(free.stow.off).toBeUndefined()
    expect(
      idleState(
        { ...cfg, "stow.enabled": false },
        { ephemeral: false, stowRefused: true },
        {},
      ).stow.off,
    ).toBeUndefined()
  })

  it("is logged once, however often it comes back, and leaves the record to winvm stow", () => {
    rmSync(instanceDir("refused"), { recursive: true, force: true })
    mkdirSync(instanceDir("refused"), { recursive: true })
    const logged: string[] = []
    const log = (line: string): void => {
      logged.push(line)
    }
    expect(noteStowRefused(false, log)).toBe(true)
    expect(noteStowRefused(true, log)).toBe(true)
    expect(readSince("refused", START).entries).toEqual([])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain("idle stows are off")
  })
})
