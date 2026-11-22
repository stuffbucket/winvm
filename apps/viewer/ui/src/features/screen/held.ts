import type { Size, Timers } from "@winvm/displayfit"

export type KeyVerdict = "wake" | "drop" | "pass"

export interface KeyState {
  readonly asleep: boolean
  readonly frozen: boolean
  readonly waking: boolean
}

export function keyVerdict(
  s: KeyState,
  key: { readonly metaKey: boolean },
): KeyVerdict {
  if (key.metaKey) return "pass"
  if (s.asleep) return s.waking ? "drop" : "wake"
  return "pass"
}

export interface HeldSizesOptions {
  readonly onRetry?: (size: Size) => void
  readonly timers?: Timers
  readonly retryMs?: number
  readonly tries?: number
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => {
    clearTimeout(t as ReturnType<typeof setTimeout>)
  },
}

const MAX_RETRY_MS = 30_000
const DEFAULT_RETRY_MS = 2000
const DEFAULT_TRIES = 6

export class HeldSizes {
  private frozen: boolean
  private waiting: Size | null = null
  private misses = 0
  private timer: unknown = null
  private readonly o: HeldSizesOptions
  private readonly timers: Timers

  constructor(frozen: boolean, o: HeldSizesOptions = {}) {
    this.frozen = frozen
    this.o = o
    this.timers = o.timers ?? realTimers
  }

  get pending(): Size | null {
    return this.waiting
  }

  offer(size: Size): boolean {
    if (!this.frozen) {
      this.waiting = null
      this.clearTimer()
      return true
    }
    this.waiting = size
    return false
  }

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

  missed(size: Size): void {
    this.waiting ??= size
    this.misses++
    this.clearTimer()
    if (this.frozen || this.misses > (this.o.tries ?? DEFAULT_TRIES)) return
    const wait = Math.min(
      (this.o.retryMs ?? DEFAULT_RETRY_MS) * 2 ** (this.misses - 1),
      MAX_RETRY_MS,
    )
    this.timer = this.timers.set(() => {
      this.timer = null
      if (this.frozen || this.waiting === null) return
      const again = this.waiting
      this.waiting = null
      this.o.onRetry?.(again)
    }, wait)
  }

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
