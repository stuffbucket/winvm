import { describe, expect, it } from "bun:test"

import { formatGB, formatPair, fraction, parseSample, pushHistory, type Sample, usageFrom } from "../ui/src/features/usage/usage"

const GB = 1024 ** 3

const sample = (o: Partial<Sample> = {}): Sample => ({
  atMs: 10_000,
  host: { cpuSeconds: 100, rssBytes: 3 * GB },
  guest: { memory: { total: 4 * GB, available: 1.5 * GB }, disk: { path: "C:\\", total: 63 * GB, free: 51 * GB } },
  guestError: null,
  ...o,
})

describe("the meters", () => {
  it("read QEMU's CPU time over the time between samples, out of all the machine's processors", () => {
    const a = sample({ atMs: 10_000, host: { cpuSeconds: 100, rssBytes: GB } })
    const b = sample({ atMs: 12_500, host: { cpuSeconds: 105, rssBytes: GB } })
    // 5 s of CPU in 2.5 s is two processors' worth: half of four.
    expect(usageFrom(a, b, 4, 4096).cpu).toBe(50)
    expect(usageFrom(null, b, 4, 4096).cpu).toBeNull()
    expect(usageFrom(a, b, null, 4096).cpu).toBeNull()
  })

  it("keep CPU between 0 and 100 (QEMU's own threads, a restarted process)", () => {
    const a = sample({ atMs: 0, host: { cpuSeconds: 0, rssBytes: GB } })
    expect(usageFrom(a, sample({ atMs: 1000, host: { cpuSeconds: 9, rssBytes: GB } }), 4, 4096).cpu).toBe(100)
    expect(usageFrom(a, sample({ atMs: 1000, host: { cpuSeconds: -5, rssBytes: GB } }), 4, 4096).cpu).toBe(0)
  })

  it("show Windows' memory in use as total less available, and C: used out of its size", () => {
    const u = usageFrom(null, sample(), 4, 4096)
    expect(u.memory).toEqual({ used: 2.5 * GB, total: 4 * GB, source: "windows" })
    expect(u.disk).toEqual({ used: 12 * GB, total: 63 * GB })
  })

  it("fall back to what QEMU holds on the Mac, said so, while Windows doesn't answer", () => {
    const u = usageFrom(null, sample({ guest: null, guestError: "connection refused" }), 4, 4096)
    expect(u.memory).toEqual({ used: 3 * GB, total: 4 * GB, source: "mac" })
    expect(u.disk).toBeNull()
  })

  it("leave out what can't be told", () => {
    const u = usageFrom(null, sample({ host: null, guest: { memory: { total: 0, available: 0 }, disk: null } }), 4, null)
    expect(u).toEqual({ cpu: null, memory: null, disk: null })
  })

  it("take the app's samples only in the shape it sends", () => {
    expect(parseSample(sample())).toEqual(sample())
    expect(parseSample({ atMs: 1, host: null, guest: null, guestError: null })).not.toBeNull()
    expect(parseSample({ atMs: "soon" })).toBeNull()
    expect(parseSample(null)).toBeNull()
  })

  it("say sizes as Windows does, compactly", () => {
    expect(formatGB(2.13 * GB)).toBe("2.1 GB")
    expect(formatGB(4 * GB)).toBe("4 GB")
    expect(formatGB(62.8 * GB)).toBe("63 GB")
    expect(formatGB(0)).toBe("0 GB")
    expect(formatPair({ used: 2.13 * GB, total: 4 * GB })).toBe("2.1/4 GB")
    expect(formatPair({ used: 12 * GB, total: 63 * GB })).toBe("12/63 GB")
    expect(fraction({ used: 3, total: 4 })).toBe(0.75)
    expect(fraction({ used: 3, total: 0 })).toBe(0)
  })

  it("keep the last 40 readings for the panel's lines", () => {
    let h: number[] = []
    for (let i = 0; i < 45; i += 1) h = pushHistory(h, i)
    expect(h).toHaveLength(40)
    expect(h[0]).toBe(5)
    expect(pushHistory(h, null)).toEqual(h)
  })
})
