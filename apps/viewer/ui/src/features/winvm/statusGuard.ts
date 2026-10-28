/**
 * Which `winvm status` answers the window may show, and what it shows between
 * a verb and the first answer read after it. Pure, so the tests drive it.
 *
 * WHY. Status reads overlap: the poll loop restarts when it speeds up or slows
 * down (its last read still lands), and a verb reads once more when it ends. A
 * read started before Pause took effect can land after one started later, and
 * would put "running" back over "paused": the buttons flip back, and a click
 * meant for Pause lands on Resume. So:
 *
 * - Each read takes a ticket when it starts. An answer lands only if no read
 *   started later has landed already.
 * - A verb that ends sets a barrier: only reads started after it may land.
 * - Pause, Sleep, Resume and Wake know what they did, so the window shows that
 *   at once (`held`) and keeps it until a read started after the verb lands.
 */
import type { Phase, Status } from "../../model"

export type Verb = "start" | "stop" | "reboot" | "pause" | "resume" | "sleep" | "wake" | "lock" | "kill" | "setup" | "save" | "load"

/** What the machine is, once `verb` has succeeded; null when that is for a status read to say. */
export function phaseAfter(verb: Verb): Phase | null {
  switch (verb) {
    case "pause":
      return "paused"
    case "sleep":
      return "asleep"
    case "resume":
    case "wake":
      return "running"
    default:
      return null
  }
}

export class StatusGuard {
  private next = 0
  private landed = -1
  private barrier = 0
  private holding: Phase | null = null

  /** A read is starting: its ticket. */
  begin(): number {
    return this.next++
  }

  /** Whether the answer to read `ticket` may be shown. If so, it is the newest, and ends any hold. */
  land(ticket: number): boolean {
    if (ticket <= this.landed || ticket < this.barrier) return false
    this.landed = ticket
    this.holding = null
    return true
  }

  /** A verb ended: reads already out are stale. With `phase`, show it until a fresh read lands. */
  settle(phase: Phase | null): void {
    this.barrier = this.next
    this.holding = phase
  }

  /** The phase the last verb left, until a read started after it lands. */
  get held(): Phase | null {
    return this.holding
  }
}

/** The phase to show: what the last verb left, while held; else what status said. */
export function shownPhase(held: Phase | null, status: Status | null, statusPhase: (s: Status) => Phase): Phase | null {
  if (held !== null) return held
  return status === null ? null : statusPhase(status)
}
