/**
 * When a resizable (virtio-gpu) guest is asked to follow the window, and when
 * the viewer may draw its screen one guest pixel per device pixel again. Pure:
 * timers and the clock are injected, so the tests drive it.
 *
 * - While the window's edge is dragged, the guest is asked only once the size
 *   has been still for `stillMs`, and at once when the mouse is let go. Other
 *   changes (the panel, full screen, another display) are asked after `idleMs`.
 * - One request at a time. Sizes wanted while one is out are not stacked: the
 *   latest goes next.
 * - "resizing" lasts from the first size that differs until the framebuffer
 *   has been drawn in full at the size last asked for, which is also what the
 *   window wants; the viewer holds the old picture, scaled, until then. Sizes
 *   the guest passes through on the way are ignored. With no such frame within
 *   `settleMs` of the request (or of the release), it settles on what there is.
 */
import type { Size, Timers } from "@winvm/displayfit"
import { sameSize } from "@winvm/displayfit"

export type ResizePhase = "settled" | "resizing"

export interface Settled {
  /** The framebuffer drawn now; null before any. */
  readonly size: Size | null
  /** From the end of the resize (the release, or the last size change) to now; null if unknown. */
  readonly ms: number | null
  /** Settled without the size asked for, after `settleMs`. */
  readonly timedOut: boolean
}

export interface LiveResizeOptions {
  /** Asks the guest for `size`; resolves when it answered (its errors are the caller's to report). */
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
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
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

  /** The size the window wants the guest to be now. */
  want(size: Size): void {
    this.wanted = size
    if (!this.live) this.endedAt = this.now()
    this.clearStill()
    if (!this.inFlight && sameSize(size, this.asked) && sameSize(size, this.drawn)) {
      // Back to the size it is: nothing to ask.
      if (!this.live) this.settle(false)
      return
    }
    this.enter()
    this.still = this.timers.set(() => this.flush(), this.live ? (this.o.stillMs ?? 250) : (this.o.idleMs ?? 120))
  }

  /** The window's edge is being dragged. */
  liveStart(): void {
    this.live = true
    this.endedAt = null
  }

  /** The drag ended: ask for the last size now. */
  liveEnd(): void {
    this.live = false
    this.endedAt = this.now()
    if (this.phase !== "resizing") return
    this.armSettle()
    this.flush()
  }

  /** The framebuffer has been drawn in full at `size`. */
  drawnAt(size: Size): void {
    this.drawn = size
    this.maybeSettle()
  }

  /** A new connection: nothing asked yet, nothing drawn. */
  reset(): void {
    this.asked = null
    this.drawn = null
  }

  /** Ask now for the size wanted, unless it is out already. */
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
      // Still dragging: the release asks again and re-arms this.
      if (!this.live && this.phase === "resizing") this.settle(true)
    }, this.o.settleMs ?? 1500)
  }

  private clearStill(): void {
    if (this.still !== null) this.timers.clear(this.still)
    this.still = null
  }
}
