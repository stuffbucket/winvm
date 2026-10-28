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
 *   for once it runs again.
 */
import type { Size } from "@winvm/displayfit"

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

/** Sizes asked for while the guest is held wait here; the latest is asked for when it runs again. */
export class HeldSizes {
  private frozen: boolean
  private waiting: Size | null = null

  constructor(frozen: boolean) {
    this.frozen = frozen
  }

  /** True: ask the guest for `size` now. False: kept for when it runs again. */
  offer(size: Size): boolean {
    if (!this.frozen) return true
    this.waiting = size
    return false
  }

  /** The guest is held, or runs again; on running again, the size kept for it (null if none). */
  setFrozen(frozen: boolean): Size | null {
    const thawed = this.frozen && !frozen
    this.frozen = frozen
    if (!thawed) return null
    const size = this.waiting
    this.waiting = null
    return size
  }
}
