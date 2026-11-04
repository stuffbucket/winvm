/**
 * The lag recorder: which layer stopped answering (lag.ts). Pure analysis, a
 * recording against a fake clock and fake layers, and the log readers.
 */
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { LagProbe, LagSample } from "../src/lag"
import {
  STALL_MS,
  analyzeLag,
  appendToWatchLog,
  eventsBetween,
  formatLagReport,
  formatSample,
  minThreadPriority,
  recordLag,
  watchLogBetween,
} from "../src/lag"

const T0 = 1_700_000_000_000
const sample = (i: number, over: Partial<LagSample> = {}): LagSample => ({
  t: T0 + i * 1000,
  lateMs: 0,
  qmp: 2,
  agent: 4,
  state: "running",
  cpu: 8,
  proc: "S",
  minPri: 31,
  ...over,
})
const run = (n: number, from: number, over: Partial<LagSample>): LagSample[] => Array.from({ length: n }, (_, k) => sample(from + k, over))

describe("analyzeLag", () => {
  it("finds no stall in a healthy minute and says what it measured", () => {
    const r = analyzeLag(Array.from({ length: 60 }, (_, i) => sample(i)))
    expect(r.stalls).toEqual([])
    expect(r.qmp.p50).toBe(2)
    expect(r.agent?.max).toBe(4)
    expect(r.summary).toContain("no stall")
  })

  it("blames Windows when QEMU answers and the agent does not", () => {
    const s = [...run(5, 0, {}), ...run(3, 5, { agent: null }), ...run(5, 8, {})]
    const r = analyzeLag(s)
    expect(r.stalls).toHaveLength(1)
    expect(r.stalls[0]?.kind).toBe("windows")
    expect(r.stalls[0]?.samples).toBe(3)
    expect(r.stalls[0]?.explanation).toContain("inside Windows")
    expect(r.agent?.missed).toBe(3)
  })

  it("blames QEMU when the monitor and the agent both stop but the recorder ran on time", () => {
    const r = analyzeLag([...run(2, 0, {}), ...run(2, 2, { qmp: null, agent: null, state: null }), ...run(2, 4, {})])
    expect(r.stalls.map((x) => x.kind)).toEqual(["qemu"])
  })

  it("blames the Mac when the recorder's own timer was late too", () => {
    const r = analyzeLag([sample(0), sample(1, { lateMs: 3400, qmp: 900, agent: 950 }), sample(2)])
    expect(r.stalls.map((x) => x.kind)).toEqual(["mac"])
    expect(r.stalls[0]?.explanation).toContain("pmset")
  })

  it("calls a paused machine paused, even though the monitor answers instantly", () => {
    const r = analyzeLag([sample(0), ...run(2, 1, { state: "paused", agent: null }), sample(3)])
    expect(r.stalls.map((x) => x.kind)).toEqual(["paused"])
    expect(r.stalls[0]?.explanation).toContain("autosave")
  })

  it("keeps different causes apart and ends a stall when answers recover", () => {
    const r = analyzeLag([sample(0, { agent: 900 }), sample(1, { agent: 800 }), sample(2), sample(3, { qmp: 700, agent: 4 })])
    expect(r.stalls.map((x) => x.kind)).toEqual(["windows", "monitor"])
    expect(r.stalls[0]?.samples).toBe(2)
  })

  it("does not count an answer at exactly the threshold", () => {
    expect(analyzeLag([sample(0, { qmp: STALL_MS, agent: STALL_MS })]).stalls).toEqual([])
    expect(analyzeLag([sample(0, { qmp: STALL_MS + 1 })]).stalls).toHaveLength(1)
  })

  it("only times the monitor when the guest has no agent", () => {
    const r = analyzeLag(Array.from({ length: 3 }, (_, i) => sample(i, { agent: undefined })))
    expect(r.agent).toBeNull()
    expect(r.summary).toContain("no agent")
    expect(analyzeLag(run(2, 0, { agent: undefined, qmp: null })).stalls[0]?.kind).toBe("monitor")
  })

  it("reports the lowest thread priority and the CPU peak", () => {
    const r = analyzeLag([sample(0, { minPri: 31, cpu: 40 }), sample(1, { minPri: 4, cpu: 380 })])
    expect(r.minPri).toBe(4)
    expect(r.peakCpu).toBe(380)
    expect(formatLagReport("x", r, [])).toContain("LOW priority")
  })

  it("measures a stall from its first slow answer to the end of its last", () => {
    const r = analyzeLag([sample(0), sample(1, { qmp: null, agent: null }), sample(2, { qmp: null, agent: null }), sample(3)])
    // two seconds of samples, the last one's wait lasting the 5 s timeout
    expect(r.stalls[0]?.durationMs).toBe(1000 + 5000)
  })
})

describe("minThreadPriority", () => {
  const ps = [
    "USER   PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND",
    "brian 99850   ??    0.0 S    31T   0:00.01   0:00.02 /bin/qemu -name x",
    "      99850         0.0 S    31T   0:00.00   0:00.00 ",
    "      99850         5.9 S     4T   0:49.91   9:47.04 ",
    "      99850         0.5 S    37T   1:27.27   3:14.85 ",
  ].join("\n")
  it("takes the lowest priority of any thread", () => {
    expect(minThreadPriority(ps)).toBe(4)
  })
  it("is null when nothing parses", () => {
    expect(minThreadPriority("USER PID\n")).toBeNull()
  })
})

describe("recordLag", () => {
  /** A clock the fake layers advance: the recorder's sleeps move it, and so do slow answers. */
  const world = (): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } => {
    let t = T0
    return {
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
      advance: (ms) => {
        t += ms
      },
    }
  }

  it("asks once a second for as long as it is told, and hands each sample over as it arrives", async () => {
    const w = world()
    let cpu = 100
    const probe: LagProbe = {
      qmp: async () => ({ ms: 3, state: "running" }),
      agent: async () => 5,
      process: () => ({ proc: "S", cpuSec: (cpu += 0.5), minPri: 31 }),
    }
    const seen: number[] = []
    const out = await recordLag(probe, { seconds: 4, now: w.now, sleep: w.sleep, onSample: (_s, i) => seen.push(i) })
    expect(out).toHaveLength(4)
    expect(seen).toEqual([0, 1, 2, 3])
    expect(out.map((s) => s.t)).toEqual([T0, T0 + 1000, T0 + 2000, T0 + 3000])
    expect(out[0]?.cpu).toBeNull() // no full second behind the first
    expect(out[1]?.cpu).toBe(50) // half a CPU-second in one second
    expect(analyzeLag(out).stalls).toEqual([])
  })

  it("asks the layers at the same time, so a monitor that hangs does not hide the agent's answer", async () => {
    const w = world()
    const order: string[] = []
    const probe: LagProbe = {
      qmp: async () => {
        order.push("qmp start")
        await new Promise((r) => setTimeout(r, 20))
        order.push("qmp end")
        return { ms: null, state: null }
      },
      agent: async () => {
        order.push("agent")
        return 4
      },
      process: () => ({ proc: "S", cpuSec: null, minPri: null }),
    }
    const out = await recordLag(probe, { seconds: 1, now: w.now, sleep: w.sleep })
    expect(order).toEqual(["qmp start", "agent", "qmp end"])
    expect(out[0]?.qmp).toBeNull()
    expect(out[0]?.agent).toBe(4)
  })

  it("notes how late its own timer ran, which is how a stalled Mac shows", async () => {
    const w = world()
    let calls = 0
    const probe: LagProbe = {
      qmp: async () => {
        return { ms: 2, state: "running" }
      },
      agent: undefined,
      process: () => {
        // the Mac stands still for 3 s after the first sample (call 1 is the baseline, call 2 follows sample 0)
        calls += 1
        if (calls === 2) w.advance(3000)
        return { proc: "S", cpuSec: null, minPri: null }
      },
    }
    const out = await recordLag(probe, { seconds: 3, now: w.now, sleep: w.sleep })
    expect(out[0]?.lateMs).toBe(0)
    expect(out[1]?.lateMs).toBeGreaterThan(STALL_MS)
  })
})

describe("what the instance's logs say meanwhile", () => {
  it("lists the pauses and resumes in the window, and nothing outside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lag-"))
    const file = join(dir, "events.jsonl")
    const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
    writeFileSync(
      file,
      [
        { t: at(-100), kind: "state", state: "paused" },
        { t: at(10), kind: "state", state: "paused" },
        { t: at(11.6), kind: "state", state: "running" },
        { t: at(500), kind: "service", what: "started" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n{half a line",
    )
    expect(eventsBetween(file, T0, T0 + 60_000).map((l) => l.text)).toEqual(["events: state paused", "events: state running"])
    expect(eventsBetween(join(dir, "none.jsonl"), 0, 1)).toEqual([])
  })

  it("lists the watcher's actions but not its routine ticks", () => {
    const dir = mkdtempSync(join(tmpdir(), "lag-"))
    const file = join(dir, "watch.log")
    const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
    writeFileSync(
      file,
      [
        `${at(1)} [default] tick: cpu 1.0% (1-min avg 1.0%) · quiet · idle 15 s`,
        `${at(2)} [default] autosave: idle 601 s — saving auto-x`,
        `${at(4)} [default] autosave: saved "auto-x" in 1.6 s, 8.5 GB on disk`,
        `${at(900)} [default] clock: guest within 3 ms`,
      ].join("\n"),
    )
    const lines = watchLogBetween(file, T0, T0 + 60_000).map((l) => l.text)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("autosave: idle 601 s")
  })

  it("puts a summary and each stall in watch.log, in the watcher's own line format", () => {
    const dir = mkdtempSync(join(tmpdir(), "lag-"))
    const before = process.env["WINVM_HOME"]
    process.env["WINVM_HOME"] = dir
    // instanceDir() is under WINVM_HOME/instances/<name>; the folder must exist for the append
    mkdirSync(join(dir, "instances", "demo"), { recursive: true })
    const report = analyzeLag([sample(0), sample(1, { agent: null }), sample(2)])
    appendToWatchLog("demo", report, new Date(T0))
    const text = readFileSync(join(dir, "instances", "demo", "watch.log"), "utf8")
    expect(text).toContain(`${new Date(T0).toISOString()} [demo] lag: recorded 3 s`)
    expect(text).toContain("lag: windows stall")
    if (before === undefined) delete process.env["WINVM_HOME"]
    else process.env["WINVM_HOME"] = before
  })
})

describe("formatSample", () => {
  it("marks slow seconds and says why", () => {
    const ok = formatSample(sample(0), 0)
    expect(ok).not.toContain("<--")
    const bad = formatSample(sample(1, { agent: null }), 1)
    expect(bad).toContain("<-- windows")
    expect(bad).toContain("NONE")
  })
})
