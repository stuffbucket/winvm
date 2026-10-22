/**
 * The pure half of goldens: reading QEMU's CPU time and deciding the guest has
 * settled. No VM needed.
 */
import { describe, expect, it } from "bun:test"

import type { CpuSample } from "../golden"
import { cpuPercent, isSettled, parseCpuTime, parseDuration, parsePercent, parseSmp } from "../golden"

describe("reading QEMU from ps", () => {
  it("parses every shape of ps cputime", () => {
    expect(parseCpuTime("  0:03.56")).toBeCloseTo(3.56)
    expect(parseCpuTime("12:00.50")).toBeCloseTo(720.5)
    expect(parseCpuTime("1:02:03.00")).toBeCloseTo(3723)
    expect(parseCpuTime("2-01:00:00")).toBeCloseTo(2 * 86_400 + 3600)
    expect(parseCpuTime("")).toBeNaN()
  })
  it("finds the vCPU count on the command line", () => {
    expect(parseSmp("qemu-system-aarch64 -name winvm-x -cpu host -smp 4 -m 4096")).toBe(4)
    expect(parseSmp("qemu -smp cpus=8,sockets=1")).toBe(8)
    expect(parseSmp("qemu -m 4096")).toBe(1)
  })
})

describe("settling", () => {
  // 4 vCPUs; `pcts` are per 5 s interval, as a share of all four.
  const series = (pcts: readonly number[]): CpuSample[] => {
    const out: CpuSample[] = [{ atMs: 0, cpuSec: 0 }]
    for (const pct of pcts) {
      const prev = out.at(-1) as CpuSample
      out.push({ atMs: prev.atMs + 5000, cpuSec: prev.cpuSec + (pct / 100) * 4 * 5 })
    }
    return out
  }
  it("measures CPU as a share of all vCPUs", () => {
    const [a, b] = series([25]) as [CpuSample, CpuSample]
    expect(cpuPercent(a, b, 4)).toBeCloseTo(25)
    expect(cpuPercent(a, a, 4)).toBe(0)
  })
  it("needs the whole window covered", () => {
    expect(isSettled(series([1, 1, 1]), 4, 3, 60_000)).toBe(false)
    expect(isSettled(series(Array(12).fill(1) as number[]), 4, 3, 60_000)).toBe(true)
    expect(isSettled([], 4, 3, 60_000)).toBe(false)
  })
  it("only looks at the last window: a busy boot before it does not count", () => {
    expect(isSettled(series([80, 60, 40, ...(Array(12).fill(2) as number[])]), 4, 3, 60_000)).toBe(true)
  })
  it("one burst inside the window means not settled", () => {
    const pcts = Array(12).fill(1) as number[]
    pcts[6] = 20
    expect(isSettled(series(pcts), 4, 3, 60_000)).toBe(false)
  })
})

describe("flags", () => {
  it("parses durations", () => {
    expect(parseDuration("60s")).toBe(60_000)
    expect(parseDuration("10m")).toBe(600_000)
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("90")).toBe(90_000)
    expect(parseDuration("1.5h")).toBe(5_400_000)
    expect(() => parseDuration("soon")).toThrow(/duration/)
  })
  it("parses percentages", () => {
    expect(parsePercent("3%")).toBe(3)
    expect(parsePercent("2.5")).toBe(2.5)
    expect(() => parsePercent("150%")).toThrow(/percentage/)
    expect(() => parsePercent("x")).toThrow(/percentage/)
  })
})
