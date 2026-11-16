import type { Size, Timers } from "@winvm/displayfit"
import { sameSize } from "@winvm/displayfit"

export type ResizePhase = "settled" | "resizing"

export interface Settled {
  readonly size: Size | null
  readonly ms: number | null
  readonly timedOut: boolean
}

export interface LiveResizeOptions {
  request(size: Size): Promise<void>
  onPhase(phase: ResizePhase, settled: Settled | null): void
  readonly timers?: Timers
  readonly now?: () => number
  readonly stillMs?: number
  readonly idleMs?: number
  readonly settleMs?: number
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => { clearTimeout(t as ReturnType<typeof setTimeout>) },
}

export class LiveResize {
  private live = false
  private wanted: Size | null = null
  private drawn: Size | null = null
  private asked: Size | null = null
  private inFlight = false
  private again = false
  private phase: ResizePhase = "settled"
  private endedAt: number | null = null
  private still: unknown = null
  private settleTimer: unknown = null
  private readonly o: LiveResizeOptions
  private readonly timers: Timers
  private readonly now: () => number

  constructor(o: LiveResizeOptions) {
    this.o = o
    this.timers = o.timers ?? realTimers
    this.now = o.now ?? (() => performance.now())
  }

  get resizing(): boolean {
    return this.phase === "resizing"
  }

  want(size: Size): void {
    this.wanted = size
    if (!this.live) this.endedAt = this.now()
    this.clearStill()
    if (!this.inFlight && sameSize(size, this.asked) && sameSize(size, this.drawn)) {
      if (!this.live) this.settle(false)
      return
    }
    this.enter()
    this.still = this.timers.set(() => { this.flush() }, this.live ? (this.o.stillMs ?? 250) : (this.o.idleMs ?? 120))
  }

  liveStart(): void {
    this.live = true
    this.endedAt = null
  }

  liveEnd(): void {
    this.live = false
    this.endedAt = this.now()
    if (this.phase !== "resizing") return
    this.armSettle()
    this.flush()
  }

  drawnAt(size: Size): void {
    this.drawn = size
    this.maybeSettle()
  }

  reset(): void {
    this.asked = null
    this.drawn = null
  }

  flush(): void {
    this.clearStill()
    const size = this.wanted
    if (size === null) return
    if (this.inFlight) {
      this.again = true
      return
    }
    if (sameSize(size, this.asked)) {
      this.maybeSettle()
      return
    }
    this.asked = size
    this.inFlight = true
    this.armSettle()
    this.o
      .request(size)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = false
        if (this.again) {
          this.again = false
          this.flush()
        } else this.maybeSettle()
      })
  }

  cancel(): void {
    this.clearStill()
    if (this.settleTimer !== null) this.timers.clear(this.settleTimer)
    this.settleTimer = null
  }

  private maybeSettle(): void {
    if (this.phase !== "resizing" || this.live) return
    if (sameSize(this.drawn, this.asked) && sameSize(this.asked, this.wanted)) this.settle(false)
  }

  private enter(): void {
    if (this.phase === "resizing") return
    this.phase = "resizing"
    this.o.onPhase("resizing", null)
  }

  private settle(timedOut: boolean): void {
    if (this.settleTimer !== null) this.timers.clear(this.settleTimer)
    this.settleTimer = null
    if (this.phase === "settled") return
    this.phase = "settled"
    const ms = this.endedAt === null ? null : this.now() - this.endedAt
    this.o.onPhase("settled", { size: this.drawn, ms, timedOut })
  }

  private armSettle(): void {
    if (this.settleTimer !== null) this.timers.clear(this.settleTimer)
    this.settleTimer = this.timers.set(() => {
      this.settleTimer = null
      if (!this.live && this.phase === "resizing") this.settle(true)
    }, this.o.settleMs ?? 1500)
  }

  private clearStill(): void {
    if (this.still !== null) this.timers.clear(this.still)
    this.still = null
  }
}
