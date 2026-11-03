/**
 * The screen while the machine is held (paused or asleep). Pure, so the tests
 * drive it.
 *
 * - Keys. A paused machine needs Resume: keys do nothing (noVNC is view-only
 *   while held, so nothing queues in QEMU to land on resume). An asleep one
 *   wakes on the first key pressed in the screen, and that key is DROPPED, not
 *   typed: like a Mac's wake key, it only wakes, and it would land on Windows'
 *   lock screen anyway, mid-resume. Keys after it are dropped too until the
 *   machine is awake. Keys with ⌘ are the app's own shortcuts: left alone.
 * - Sizes. A guest held can't change size: the window's size is kept, and asked
 *   for once it runs again. So is a guest not ready for one: Windows still
 *   starting or restarting (its agent silent), or a verb under way. A size the
 *   guest could not take when asked (its display driver not loaded yet, so
 *   QEMU refuses the size, or its agent not listening) is kept too, and asked
 *   for again a little later, and in any case once the guest is ready again.
 *   A size is never dropped.
 */
import type { Size, Timers } from "@winvm/displayfit"

export type KeyVerdict = "wake" | "drop" | "pass"

export interface KeyState {
  /** The machine is asleep (a key wakes it). */
  readonly asleep: boolean
  /** Paused or asleep. */
  readonly frozen: boolean
  /** A wake has been asked for and the machine isn't awake yet. */
  readonly waking: boolean
}

/** What a key pressed in the screen does: wake the machine (and go no further), be dropped, or go on as usual. */
export function keyVerdict(s: KeyState, key: { readonly metaKey: boolean }): KeyVerdict {
  if (key.metaKey) return "pass"
  if (s.asleep) return s.waking ? "drop" : "wake"
  // Paused: noVNC is view-only, so the key goes nowhere; it never resumes the machine.
  return "pass"
}

export interface HeldSizesOptions {
  /** A size the guest missed, to ask for again now (the guest can take sizes). */
  readonly onRetry?: (size: Size) => void
  readonly timers?: Timers
  /** The first wait before asking again after a miss; each one after doubles, up to 30 s. */
  readonly retryMs?: number
  /** Misses in a row asked again on the timer; after that the size waits for the guest to be ready again. */
  readonly tries?: number
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

const MAX_RETRY_MS = 30_000

/**
 * Sizes asked for while the guest can't take one (held, or not ready) wait
 * here; the latest is asked for when it can again. A size it missed waits here
 * too, and is asked for again on a timer.
 */
export class HeldSizes {
  private frozen: boolean
  private waiting: Size | null = null
  private misses = 0
  private timer: unknown = null
  private readonly o: HeldSizesOptions
  private readonly timers: Timers

  /** `frozen`: the guest can't take a size now (paused, asleep, or not ready). */
  constructor(frozen: boolean, o: HeldSizesOptions = {}) {
    this.frozen = frozen
    this.o = o
    this.timers = o.timers ?? realTimers
  }

  /** The size waiting for the guest, if any. */
  get pending(): Size | null {
    return this.waiting
  }

  /** True: ask the guest for `size` now. False: kept for when it can take it. */
  offer(size: Size): boolean {
    if (!this.frozen) {
      // Asked now: it replaces whatever a miss left waiting.
      this.waiting = null
      this.clearTimer()
      return true
    }
    this.waiting = size
    return false
  }

  /** The guest can't take a size, or can again; when it can again, the size kept for it (null if none). */
  setFrozen(frozen: boolean): Size | null {
    const thawed = this.frozen && !frozen
    this.frozen = frozen
    if (frozen) this.clearTimer()
    if (!thawed) return null
    this.misses = 0
    const size = this.waiting
    this.waiting = null
    return size
  }

  /**
   * The guest was asked for `size` and could not take it: kept (unless a newer
   * size already waits), and asked for again after a while if the guest can
   * take sizes then, else once it can.
   */
  missed(size: Size): void {
    this.waiting ??= size
    this.misses++
    this.clearTimer()
    if (this.frozen || this.misses > (this.o.tries ?? 6)) return
    const wait = Math.min((this.o.retryMs ?? 2000) * 2 ** (this.misses - 1), MAX_RETRY_MS)
    this.timer = this.timers.set(() => {
      this.timer = null
      if (this.frozen || this.waiting === null) return
      const again = this.waiting
      this.waiting = null
      this.o.onRetry?.(again)
    }, wait)
  }

  /** The guest took a size: misses start over. */
  took(): void {
    this.misses = 0
  }

  cancel(): void {
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
