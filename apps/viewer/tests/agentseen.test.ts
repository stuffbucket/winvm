/**
 * Whether Windows has answered since this QEMU started: a silent agent after it
 * has is a busy Windows, not a booting one, and must not take the mouse and
 * keyboard away (features/winvm/agentSeen.ts).
 */
import { describe, expect, it } from "bun:test"

import { type Status, parseStatus } from "../ui/src/model"
import { UNSEEN, agentSeen, inputPhase } from "../ui/src/features/winvm/agentSeen"
import { inputRule } from "../ui/src/features/screen/input"
import { phase } from "../ui/src/model"

const read = (pid: number | null, agent: "ok" | "silent" | null): Status => {
  const s = parseStatus(
    JSON.stringify({
      name: "demo",
      state: pid === null ? "stopped" : "running",
      vmStatus: null,
      image: null,
      pid,
      uptimeSeconds: null,
      cpus: null,
      memoryMiB: null,
      screen: null,
      overlayBytes: null,
      guest: agent === null ? null : { agent, agentVersion: null, os: null },
      saves: { count: 0, bytes: 0 },
      notes: [],
    }),
  )?.[0]
  if (s === undefined) throw new Error("status did not parse")
  return s
}

describe("agentSeen", () => {
  it("is unseen until the agent answers", () => {
    expect(agentSeen(UNSEEN, read(7, "silent")).up).toBe(false)
    expect(agentSeen(UNSEEN, null)).toBe(UNSEEN)
  })

  it("stays seen through later silences, for the same QEMU", () => {
    let s = agentSeen(UNSEEN, read(7, "ok"))
    expect(s).toEqual({ pid: 7, up: true })
    s = agentSeen(s, read(7, "silent"))
    expect(s.up).toBe(true)
    s = agentSeen(s, read(7, null))
    expect(s.up).toBe(true)
  })

  it("starts over for another QEMU, and when there is none", () => {
    const seen = agentSeen(UNSEEN, read(7, "ok"))
    expect(agentSeen(seen, read(8, "silent"))).toEqual({ pid: 8, up: false })
    expect(agentSeen(seen, read(null, null))).toBe(UNSEEN)
  })

  it("keeps the mouse and keyboard on through a silent poll, but not through a real boot", () => {
    const silent = read(7, "silent")
    expect(phase(silent)).toBe("starting")
    // Booting: never seen, so input stays off.
    expect(inputRule(inputPhase(phase(silent), agentSeen(UNSEEN, silent)), false).forward).toBe(false)
    // Seen before: a blip.
    const seen = agentSeen(UNSEEN, read(7, "ok"))
    expect(inputRule(inputPhase(phase(silent), agentSeen(seen, silent)), false).forward).toBe(true)
    // Held states are never overridden.
    expect(inputPhase("paused", seen)).toBe("paused")
  })
})
