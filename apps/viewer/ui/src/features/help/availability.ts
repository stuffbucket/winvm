import type { Phase } from "../../model"
import type { TopicId } from "./topics"

/**
 * Whether a topic's action can be used while the machine is in `phase`, and
 * if not, the i18n key of the short reason. Help itself is always open: only
 * the thing it explains is unavailable.
 *
 * - exec, files: Windows' agent has to answer, so the machine has to run
 *   (`terminalBlocked`, `guestReady` in App.tsx; `winvm terminal` refuses an
 *   instance that is not running).
 * - save: a save captures a live guest (`requireSaveable` in core's
 *   savecmds.ts); the Checkpoints view offers New Checkpoint while the machine
 *   runs or is paused.
 * - restore: Checkpoints opens, and Go Back to This works, for a machine that
 *   is on or off, so only a machine that does not exist yet has nothing to go
 *   back to.
 * - agent: the MCP tools answer "Instance X isn't running" unless QEMU is up
 *   (`whyNot` in core's mcp.ts), and the agent has to answer for them to work.
 *
 * A null phase (not read yet) blocks nothing.
 */
export function blockedBy(topic: TopicId, phase: Phase | null | undefined): string | null {
  if (phase === null || phase === undefined) return null
  if (phase === "missing") return "abilities.why.setUp"
  if (topic === "restore") return null
  if (phase === "running") return null
  if (topic === "save" && phase === "paused") return null
  if (phase === "starting") return "abilities.why.starting"
  if (phase === "paused" || phase === "asleep") return "abilities.why.resume"
  return "abilities.why.start"
}
