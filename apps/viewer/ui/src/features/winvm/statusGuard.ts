import type { Phase, Status, VmOperation } from "../../model"

export type Verb =
  | "start"
  | "stop"
  | "reboot"
  | "pause"
  | "resume"
  | "sleep"
  | "wake"
  | "lock"
  | "kill"
  | "setup"
  | "save"
  | "load"
  | "stow"

export const operationFor = (verb: Verb): VmOperation => verb

export function phaseAfter(verb: Verb): Phase | null {
  switch (verb) {
    case "pause":
      return "paused"
    case "sleep":
      return "asleep"
    case "resume":
    case "wake":
      return "running"
    case "start":
    case "stop":
    case "reboot":
    case "lock":
    case "kill":
    case "setup":
    case "save":
    case "load":
    case "stow":
      return null
  }
}

export class StatusGuard {
  private next = 0
  private landed = -1
  private barrier = 0
  private holding: Phase | null = null

  begin(): number {
    return this.next++
  }

  land(ticket: number): boolean {
    if (ticket <= this.landed || ticket < this.barrier) return false
    this.landed = ticket
    this.holding = null
    return true
  }

  settle(phase: Phase | null): void {
    this.barrier = this.next
    this.holding = phase
  }

  get held(): Phase | null {
    return this.holding
  }
}

export function shownPhase(
  held: Phase | null,
  status: Status | null,
  statusPhase: (s: Status) => Phase,
): Phase | null {
  if (held !== null) return held
  return status === null ? null : statusPhase(status)
}
