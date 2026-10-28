import { describe, expect, it } from "bun:test"

import { WAKE_MS, type WakeSock, type WakeTimers, keepRefreshing, sendWake } from "../ui/src/features/screen/wake"

/** Records what noVNC's websocket wrapper would put on the wire. */
class Wire implements WakeSock {
  readonly sent: number[][] = []
  private pending: number[] = []
  sQpush8(n: number): void {
    this.pending.push(n & 0xff)
  }
  sQpush16(n: number): void {
    this.pending.push((n >> 8) & 0xff, n & 0xff)
  }
  sQpush32(n: number): void {
    this.pending.push((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
  }
  flush(): void {
    this.sent.push(this.pending)
    this.pending = []
  }
}

class Ticker implements WakeTimers {
  fn: (() => void) | null = null
  ms = 0
  every(fn: () => void, ms: number): unknown {
    this.fn = fn
    this.ms = ms
    return 1
  }
  stop(): void {
    this.fn = null
  }
  tick(n = 1): void {
    for (let i = 0; i < n; i++) this.fn?.()
  }
}

describe("refresh wake-up", () => {
  it("is QEMU's extended key event releasing key 0, which the guest never sees", () => {
    const wire = new Wire()
    sendWake(wire)
    // type 255 (QEMU), sub-type 0 (extended key event), down 0, keysym 0, keycode 0
    expect(wire.sent).toEqual([[255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]])
  })

  it("runs more often than QEMU's 30 ms base refresh", () => {
    const ticker = new Ticker()
    keepRefreshing(new Wire(), () => true, ticker)
    expect(ticker.ms).toBe(WAKE_MS)
    expect(WAKE_MS).toBeLessThan(30)
  })

  it("sends only while active, and nothing once stopped", () => {
    const wire = new Wire()
    const ticker = new Ticker()
    let active = true
    const stop = keepRefreshing(wire, () => active, ticker)
    ticker.tick(3)
    expect(wire.sent.length).toBe(3)
    active = false
    ticker.tick(2)
    expect(wire.sent.length).toBe(3)
    active = true
    stop()
    ticker.tick(2)
    expect(wire.sent.length).toBe(3)
  })
})
