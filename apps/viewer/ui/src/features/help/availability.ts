import type { Phase } from "../../model"
import type { TopicId } from "./topics"

export function blockedBy(
  topic: TopicId,
  phase: Phase | null | undefined,
): string | null {
  if (phase === null || phase === undefined) return null
  if (phase === "missing") return "abilities.why.setUp"
  if (topic === "restore") return null
  if (phase === "running") return null
  if (topic === "save" && phase === "paused") return null
  if (phase === "starting") return "abilities.why.starting"
  if (phase === "paused" || phase === "asleep") return "abilities.why.resume"
  return "abilities.why.start"
}
