import { describe, expect, it } from "bun:test"

import type { Size, Timers } from "@winvm/displayfit"

import { LiveResize, type ResizePhase, type Settled } from "../ui/src/features/screen/resize"

/** A virtual clock: timers fire only when the test moves time on. */
class Clock implements Timers {
  now = 0
  private next = 1
  private readonly due = new Map<number, { at: number; fn: () => void }>()
  set(fn: () => void, ms: number): unknown {
    const id = this.next++
    this.due.set(id, { at: this.now + ms, fn })
    return id
  }
  clear(t: unknown): void {
    this.due.delete(t as number)
  }
  /** Move on `ms`, running what falls due in order. */
  async tick(ms: number): Promise<void> {
    const end = this.now + ms
    for (;;) {
      const first = [...this.due.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (first === undefined || first[1].at > end) break
      this.due.delete(first[0])
      this.now = first[1].at
      first[1].fn()
      await flushPromises()
    }
    this.now = end
    await flushPromises()
  }
}

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const S = (width: number, height: number): Size => ({ width, height })

function setup(o: { stillMs?: number; idleMs?: number; settleMs?: number } = {}) {
  const clock = new Clock()
  const asked: Size[] = []
  const answers: (() => void)[] = []
  const phases: { phase: ResizePhase; settled: Settled | null }[] = []
  const r = new LiveResize({
    request: (size) => {
      asked.push(size)
      return new Promise<void>((res) => answers.push(res))
    },
    onPhase: (phase, settled) => phases.push({ phase, settled }),
    timers: clock,
    now: () => clock.now,
    ...o,
  })
  /** The guest answers the oldest request. */
  const answer = async (): Promise<void> => {
    answers.shift()?.()
    await flushPromises()
  }
  return { clock, r, asked, phases, answer, last: () => phases.at(-1) }
}

describe("LiveResize", () => {
  it("asks nothing mid-drag, then the last size at once on release", async () => {
    const { clock, r, asked, last } = setup()
    r.liveStart()
    for (let w = 2000; w < 2400; w += 16) {
      r.want(S(w, 1200))
      await clock.tick(16)
    }
    expect(asked).toEqual([])
    expect(last()?.phase).toBe("resizing")
    r.liveEnd()
    expect(asked).toEqual([S(2384, 1200)])
  })

  it("asks mid-drag once the size has been still for 250 ms", async () => {
    const { clock, r, asked } = setup()
    r.liveStart()
    r.want(S(2000, 1200))
    await clock.tick(249)
    expect(asked).toEqual([])
    await clock.tick(1)
    expect(asked).toEqual([S(2000, 1200)])
  })

  it("asks after a short pause when nothing is being dragged (the panel, full screen)", async () => {
    const { clock, r, asked } = setup({ idleMs: 120 })
    r.want(S(1600, 1000))
    await clock.tick(119)
    expect(asked).toEqual([])
    await clock.tick(1)
    expect(asked).toEqual([S(1600, 1000)])
  })

  it("keeps one request out: sizes wanted meanwhile are coalesced to the latest", async () => {
    const { clock, r, asked, answer } = setup()
    r.liveStart()
    r.want(S(2000, 1200))
    await clock.tick(250)
    expect(asked).toEqual([S(2000, 1200)])
    r.want(S(2100, 1200))
    await clock.tick(250)
    r.want(S(2200, 1200))
    r.want(S(2300, 1200))
    r.liveEnd()
    expect(asked).toEqual([S(2000, 1200)])
    await answer()
    expect(asked).toEqual([S(2000, 1200), S(2300, 1200)])
    await answer()
    expect(asked).toHaveLength(2)
  })

  it("holds the old picture until the frame is drawn at the size asked for, ignoring sizes on the way", async () => {
    const { clock, r, phases, answer } = setup()
    r.drawnAt(S(1920, 1200))
    r.liveStart()
    r.want(S(2400, 1500))
    await clock.tick(30)
    r.liveEnd()
    await clock.tick(40)
    r.drawnAt(S(1024, 768)) // the driver's mode list flashing by
    await answer()
    expect(phases.map((p) => p.phase)).toEqual(["resizing"])
    await clock.tick(50)
    r.drawnAt(S(2400, 1500))
    expect(phases.map((p) => p.phase)).toEqual(["resizing", "settled"])
    expect(phases[1]?.settled).toEqual({ size: S(2400, 1500), ms: 90, timedOut: false })
  })

  it("settles as soon as the frame is drawn, before the guest's answer arrives", async () => {
    const { r, last } = setup()
    r.want(S(1600, 1000))
    r.flush()
    r.drawnAt(S(1600, 1000))
    expect(last()?.phase).toBe("settled")
  })

  it("does not settle while the edge is still held, even at the size asked for", async () => {
    const { clock, r, last, answer } = setup()
    r.liveStart()
    r.want(S(2000, 1200))
    await clock.tick(250)
    await answer()
    r.drawnAt(S(2000, 1200))
    expect(last()?.phase).toBe("resizing")
    r.liveEnd()
    expect(last()?.phase).toBe("settled")
  })

  it("settles on what arrived when the size asked for never comes", async () => {
    const { clock, r, last, answer } = setup({ settleMs: 1500 })
    r.want(S(6000, 3000))
    await clock.tick(120)
    r.drawnAt(S(5120, 2160))
    await answer()
    await clock.tick(1499)
    expect(last()?.phase).toBe("resizing")
    await clock.tick(1)
    expect(last()?.phase).toBe("settled")
    expect(last()?.settled?.timedOut).toBe(true)
    expect(last()?.settled?.size).toEqual(S(5120, 2160))
  })

  it("waits for the release before timing out a drag", async () => {
    const { clock, r, last, answer } = setup({ settleMs: 1500 })
    r.liveStart()
    r.want(S(2000, 1200))
    await clock.tick(250)
    await answer()
    await clock.tick(5000)
    expect(last()?.phase).toBe("resizing")
    r.liveEnd()
    await clock.tick(1500)
    expect(last()?.settled?.timedOut).toBe(true)
  })

  it("asks nothing when the window comes back to the size the guest already is", async () => {
    const { clock, r, asked, last, answer } = setup()
    r.want(S(1600, 1000))
    await clock.tick(120)
    await answer()
    r.drawnAt(S(1600, 1000))
    expect(last()?.phase).toBe("settled")
    r.liveStart()
    r.want(S(1700, 1000))
    await clock.tick(50)
    r.want(S(1600, 1000))
    r.liveEnd()
    await clock.tick(1000)
    expect(asked).toEqual([S(1600, 1000)])
    expect(last()?.phase).toBe("settled")
  })

  it("asks again after a reset (a new connection), even for the same size", async () => {
    const { clock, r, asked, answer } = setup()
    r.want(S(1600, 1000))
    await clock.tick(120)
    await answer()
    r.drawnAt(S(1600, 1000))
    r.reset()
    r.want(S(1600, 1000))
    r.flush()
    expect(asked).toEqual([S(1600, 1000), S(1600, 1000)])
  })

  it("keeps going after a request fails", async () => {
    const clock = new Clock()
    const asked: Size[] = []
    const r = new LiveResize({
      request: (size) => {
        asked.push(size)
        return Promise.reject(new Error("the agent went away"))
      },
      onPhase: () => undefined,
      timers: clock,
      now: () => clock.now,
    })
    r.want(S(1600, 1000))
    r.flush()
    await flushPromises()
    r.want(S(1700, 1000))
    r.flush()
    expect(asked).toEqual([S(1600, 1000), S(1700, 1000)])
  })
})
