/**
 * Keeps QEMU's VNC server checking the guest's screen at its fastest rate.
 *
 * QEMU looks for changes to send on a timer that starts at 30 ms and backs off
 * by 50 ms (up to 3 s) every time a check finds nothing it can send: the guest
 * drew nothing new yet, or the viewer had not yet asked for the next update.
 * It halves again only once something is sent (ui/vnc.c, vnc_refresh). With a
 * guest that draws at about the same rate, every check that falls between two
 * of its frames costs 80 ms instead of 30, which shows as a stutter; and the
 * picture that answers a click or a key, drawn 40-50 ms after it, waits for the
 * 80 ms check (and after a quiet spell, up to 3 s for a change the guest makes
 * on its own).
 *
 * Any message from the viewer above type 3 (a key, the pointer, ...) puts the
 * timer back to 30 ms (protocol_client_msg). So while the screen is shown we
 * send one every WAKE_MS that the guest never sees: QEMU's extended key event
 * releasing key 0. QEMU drops the release of a key that is not down
 * (qkbd_state_key_event) before it reaches the guest, and nothing else is done
 * with it.
 *
 * Measured with noVNC in WebKit against a Windows 11 guest at 2048x1534, from
 * the input to the first frame painted after it (p50/p95): a typed key 96/112
 * -> 69/90 ms, a window drag 118/145 -> 71/95 ms; a change the guest makes on
 * its own after a quiet spell reached the viewer 253/629 -> 9/37 ms after the
 * guest drew it. A moving window's longest gap went 140 -> 65 ms, and a
 * full-screen animation at 2560x1600 from 8.5 to 15.7 frames a second. The
 * cost: QEMU checks every 30 ms while the screen is shown, about 1% of a core
 * with an idle guest.
 */

/** Under QEMU's 30 ms base, so the timer never gets to back off. */
export const WAKE_MS = 15

/** The bytes noVNC's websocket wrapper needs to send a message. */
export interface WakeSock {
  sQpush8(n: number): void
  sQpush16(n: number): void
  sQpush32(n: number): void
  flush(): void
}

/** QEMU client message 255, sub-type 0 (extended key event): up, keysym 0, keycode 0. */
export function sendWake(sock: WakeSock): void {
  sock.sQpush8(255)
  sock.sQpush8(0)
  sock.sQpush16(0) // down-flag: released
  sock.sQpush32(0) // keysym
  sock.sQpush32(0) // keycode
  sock.flush()
}

export interface WakeTimers {
  every(fn: () => void, ms: number): unknown
  stop(t: unknown): void
}

const realTimers: WakeTimers = {
  every: (fn, ms) => setInterval(fn, ms),
  stop: (t) => clearInterval(t as ReturnType<typeof setInterval>),
}

/**
 * Sends the wake-up every WAKE_MS while `active()` holds (connected, and the
 * page visible). Returns the function that stops it.
 */
export function keepRefreshing(sock: WakeSock, active: () => boolean, timers: WakeTimers = realTimers): () => void {
  const t = timers.every(() => {
    if (active()) sendWake(sock)
  }, WAKE_MS)
  return () => timers.stop(t)
}
