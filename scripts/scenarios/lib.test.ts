import { describe, expect, it } from "bun:test"

import { type Sample, heldThroughout, path, rfbKeycode } from "./lib"

const s = (at: number, state: string | null, vmStatus: string | null = state): Sample => ({ at, state, vmStatus })

describe("assertions held over time", () => {
  const samples = [s(0, "running"), s(10, "paused"), s(20, "paused"), s(30, "paused", "postmigrate"), s(40, "running"), s(50, "running")]

  it("holds when every read in the window shows the state", () => {
    expect(heldThroughout(samples, 10, 30, ["paused"]).ok).toBe(true)
    expect(heldThroughout(samples, 10, 30, ["paused"]).count).toBe(3)
  })

  it("fails on a single read that slipped, and names it", () => {
    const h = heldThroughout(samples, 10, 40, ["paused"])
    expect(h.ok).toBe(false)
    expect(h.bad).toEqual([s(40, "running")])
  })

  it("checks QEMU's run state too when asked", () => {
    expect(heldThroughout(samples, 10, 30, ["paused"], { vm: ["paused"] }).ok).toBe(false)
    expect(heldThroughout(samples, 10, 30, ["paused"], { vm: ["paused", "postmigrate"] }).ok).toBe(true)
  })

  it("needs enough reads to mean anything; a stopped machine's reads (no run state) count", () => {
    expect(heldThroughout(samples, 10, 30, ["paused"], { minSamples: 4 }).ok).toBe(false)
    expect(heldThroughout([s(0, "stopped", null), s(5, "stopped", null)], 0, 10, ["stopped"], { minSamples: 2 }).ok).toBe(true)
  })

  it("an error read is never the state held", () => {
    expect(heldThroughout([s(0, null, "paused")], 0, 10, ["paused"]).ok).toBe(false)
  })

  it("summarises the states gone through", () => {
    expect(path(samples, 0, 50)).toBe("running > paused > paused(postmigrate) > running")
    expect(path([s(0, null, null)], 0, 1)).toBe("error")
  })
})

describe("keys as noVNC sends them", () => {
  it("sends an 0xE0 scancode as its low byte with the top bit set, others as they are", () => {
    expect(rfbKeycode("MetaLeft")).toBe(0xdb)
    expect(rfbKeycode("MetaRight")).toBe(0xdc)
    expect(rfbKeycode("ControlLeft")).toBe(0x1d)
    expect(rfbKeycode("KeyR")).toBe(0x13)
  })
})
