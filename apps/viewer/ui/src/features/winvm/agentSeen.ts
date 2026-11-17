import type { Phase, Status } from "../../model"

export interface AgentSeen {
  readonly pid: number | null
  readonly up: boolean
}

export const UNSEEN: AgentSeen = { pid: null, up: false }

export function agentSeen(prev: AgentSeen, s: Status | null): AgentSeen {
  if (s === null || s.pid === null) return UNSEEN
  const up = (s.pid === prev.pid && prev.up) || s.guest?.agent === "ok"
  return up === prev.up && s.pid === prev.pid ? prev : { pid: s.pid, up }
}

export const inputPhase = (
  phase: Phase | null,
  seen: AgentSeen,
): Phase | null => (phase === "starting" && seen.up ? "running" : phase)
