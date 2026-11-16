export const WAKE_MS = 15

export interface WakeSock {
  sQpush8(n: number): void
  sQpush16(n: number): void
  sQpush32(n: number): void
  flush(): void
}

export function sendWake(sock: WakeSock): void {
  sock.sQpush8(255)
  sock.sQpush8(0)
  sock.sQpush16(0)
  sock.sQpush32(0)
  sock.sQpush32(0)
  sock.flush()
}

export interface WakeTimers {
  repeat(fn: () => void, ms: number): unknown
  stop(t: unknown): void
}

const realTimers: WakeTimers = {
  repeat: (fn, ms) => setInterval(fn, ms),
  stop: (t) => {
    clearInterval(t as ReturnType<typeof setInterval>)
  },
}

export function keepRefreshing(
  sock: WakeSock,
  active: () => boolean,
  timers: WakeTimers = realTimers,
): () => void {
  const t = timers.repeat(() => {
    if (active()) sendWake(sock)
  }, WAKE_MS)
  return () => {
    timers.stop(t)
  }
}
