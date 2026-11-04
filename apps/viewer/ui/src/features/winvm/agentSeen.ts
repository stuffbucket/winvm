/**
 * Whether Windows has answered its agent since this QEMU started.
 *
 * WHY. The app's "starting" phase is inferred, not known: QEMU is up and the
 * agent did not answer a probe (`winvm status`, 4 s) (model.ts `phase`). The
 * same silence is also what a Windows that is busy looks like (Defender, an
 * installer, a host paging QEMU in, a wake from the Mac's sleep), so a machine
 * in use drops back to "starting" for a poll or two, now and again. Input off
 * for "starting" (input.ts) is right while Windows is booting and wrong then:
 * the mouse and keyboard stop for a few seconds, with Windows drawing as usual.
 *
 * So once the agent has answered for THIS process (its pid), a later silence
 * is not a boot, and the screen goes on taking input. A restarted QEMU (another
 * pid) begins unseen again. Pure, so the tests drive it.
 */
import type { Phase, Status } from "../../model"

export interface AgentSeen {
  readonly pid: number | null
  readonly up: boolean
}

export const UNSEEN: AgentSeen = { pid: null, up: false }

/** What a status read adds: the agent answering marks this pid seen; another pid starts over. */
export function agentSeen(prev: AgentSeen, s: Status | null): AgentSeen {
  if (s === null || s.pid === null) return UNSEEN
  const up = (s.pid === prev.pid && prev.up) || s.guest?.agent === "ok"
  return up === prev.up && s.pid === prev.pid ? prev : { pid: s.pid, up }
}

/** The phase input follows: a "starting" that is only a silent probe, after the agent has answered, is running. */
export const inputPhase = (phase: Phase | null, seen: AgentSeen): Phase | null => (phase === "starting" && seen.up ? "running" : phase)
