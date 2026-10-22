/**
 * `winvm test --pool`: the scheduler with fake jobs and instances, and the
 * timing figures (report.ts). No VM needed.
 */
import { describe, expect, it } from "bun:test"

import type { ScheduleDeps } from "../pool"
import { isResetFailure, longestFirst, poolMembers, poolSizeError, resourceWarnings, schedule } from "../pool"
import type { JobResult } from "../report"
import { formatSummary, merge, poolStats, toJson, uncoveredMs } from "../report"

const T0 = Date.parse("2026-10-22T10:00:00.000Z")

function result(name: string, instance: string, o: Partial<JobResult> = {}): JobResult {
  return {
    name,
    file: "",
    status: "passed",
    error: null,
    instance,
    golden: "golden",
    channel: "agent",
    resetMs: 0,
    stageMs: 0,
    stepsMs: 0,
    collectMs: 0,
    totalMs: 0,
    steps: [],
    artifacts: [],
    startedAt: new Date(T0).toISOString(),
    ...o,
  }
}

/** A job starting `at` ms after T0, resetting for `reset` and working for `work`. */
const timed = (name: string, instance: string, at: number, reset: number, work: number): JobResult =>
  result(name, instance, { startedAt: new Date(T0 + at).toISOString(), resetMs: reset, stepsMs: work, totalMs: reset + work })

const resetFail = (name: string, instance: string): JobResult =>
  result(name, instance, { status: "error", error: 'reset to "golden" failed: boom' })

function fakeDeps(run: ScheduleDeps<string>["run"]): ScheduleDeps<string> & { readonly recovered: string[]; readonly lines: string[] } {
  const recovered: string[] = []
  const lines: string[] = []
  return {
    run,
    recover: async (i) => {
      recovered.push(i)
      await Promise.resolve()
    },
    log: (i, l) => lines.push(`${i}: ${l}`),
    abandoned: (job, why) => result(job, "", { status: "error", error: why }),
    recovered,
    lines,
  }
}

describe("pool sizing", () => {
  it("names members prefix-1..prefix-N", () => {
    expect(poolMembers("ci", 3)).toEqual(["ci-1", "ci-2", "ci-3"])
  })
  it("takes 1-16", () => {
    expect(poolSizeError("3")).toBeNull()
    expect(poolSizeError("0")).not.toBeNull()
    expect(poolSizeError("17")).not.toBeNull()
    expect(poolSizeError("true")).not.toBeNull()
  })
  it("warns only when the host would be oversubscribed", () => {
    const gib = 1024 ** 3
    expect(resourceWarnings(4, 18, 128 * gib)).toEqual([])
    expect(resourceWarnings(5, 18, 128 * gib)).toHaveLength(1) // 20 vCPUs
    expect(resourceWarnings(4, 18, 16 * gib)).toHaveLength(1) // 16 GiB > half of 16
  })
})

describe("queue order", () => {
  it("is longest first, unknown jobs before timed ones, ties in file order", () => {
    expect(longestFirst(["a", "b", "c", "d"], { a: 5, b: 30, d: 5 })).toEqual([2, 1, 0, 3])
    expect(longestFirst(["a", "b"], {})).toEqual([0, 1])
  })
})

describe("schedule", () => {
  it("runs every job once, side by side, results in job order", async () => {
    let running = 0
    let peak = 0
    const deps = fakeDeps(async (job, instance) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, job === "a" ? 30 : 5))
      running -= 1
      return result(job, instance)
    })
    const rs = await schedule(["a", "b", "c", "d", "e"], ["ci-1", "ci-2", "ci-3"], deps)
    expect(rs.map((r) => r.name)).toEqual(["a", "b", "c", "d", "e"])
    expect(peak).toBe(3)
    // "a" is slow, so ci-1 runs only it while the others share the rest.
    expect(rs[0]?.instance).toBe("ci-1")
    expect(rs.filter((r) => r.instance === "ci-1")).toHaveLength(1)
  })

  it("restarts an instance whose reset failed, and retries the job there", async () => {
    let failed = false
    const deps = fakeDeps(async (job, instance) => {
      await Promise.resolve()
      if (!failed && instance === "ci-1") {
        failed = true
        return resetFail(job, instance)
      }
      return result(job, instance)
    })
    const rs = await schedule(["a"], ["ci-1"], deps)
    expect(rs[0]?.status).toBe("passed")
    expect(deps.recovered).toEqual(["ci-1"])
  })

  it("retires an instance that cannot be reset and hands its job to another", async () => {
    const deps = fakeDeps(async (job, instance) => {
      await new Promise((r) => setTimeout(r, 1))
      return instance === "ci-2" ? resetFail(job, instance) : result(job, instance)
    })
    const rs = await schedule(["a", "b", "c"], ["ci-1", "ci-2"], deps)
    expect(rs.map((r) => r.status)).toEqual(["passed", "passed", "passed"])
    expect(rs.every((r) => r.instance === "ci-1")).toBe(true)
  })

  it("reports jobs no instance was left to run", async () => {
    const deps = fakeDeps(async (job, instance) => {
      await Promise.resolve()
      return resetFail(job, instance)
    })
    const rs = await schedule(["a", "b"], ["ci-1"], deps)
    expect(rs.map((r) => r.status)).toEqual(["error", "error"])
    expect(isResetFailure(rs[0] as JobResult)).toBe(true)
    expect(rs[1]?.error).toContain("no instance")
  })
})

describe("pool timing", () => {
  it("merges and subtracts intervals", () => {
    expect(merge([{ start: 5, end: 8 }, { start: 0, end: 3 }, { start: 2, end: 4 }])).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 8 },
    ])
    expect(uncoveredMs([{ start: 0, end: 10 }], [{ start: 2, end: 4 }, { start: 3, end: 6 }])).toBe(6)
    expect(uncoveredMs([{ start: 0, end: 10 }], [])).toBe(10)
  })

  it("one instance: every reset is exposed", () => {
    const jobs = [timed("a", "ci-1", 0, 1000, 9000), timed("b", "ci-1", 10_000, 1000, 9000)]
    const s = poolStats(jobs, ["ci-1"])
    expect(s.runMs).toBe(20_000)
    expect(s.resetMs).toBe(2000)
    expect(s.exposedResetMs).toBe(2000)
  })

  it("two instances: a reset hidden behind the other's job is not exposed", () => {
    const jobs = [
      timed("a", "ci-1", 0, 1000, 9000),
      timed("b", "ci-2", 0, 1000, 4000),
      timed("c", "ci-2", 5000, 1000, 9000), // its reset overlaps a's work
    ]
    const s = poolStats(jobs, ["ci-1", "ci-2"])
    expect(s.runMs).toBe(15_000)
    expect(s.exposedResetMs).toBe(1000) // only the first, parallel resets
    expect(s.perInstance).toEqual([
      { instance: "ci-1", jobs: 1, busyMs: 10_000 },
      { instance: "ci-2", jobs: 2, busyMs: 15_000 },
    ])
    const summary = { jobs, wallMs: 20_000, setupMs: 5000, pool: s }
    expect(formatSummary(summary)).toContain("exposed reset")
    expect(JSON.parse(toJson(summary)).pool.exposedResetShare).toBeCloseTo(1 / 15)
  })
})
