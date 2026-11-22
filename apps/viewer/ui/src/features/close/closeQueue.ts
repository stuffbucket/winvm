import type { Status } from "../../model"
import { isLivePhase, phase } from "../../model"

export function orderCloseQueue(
  statuses: readonly Status[],
  selected: string | null,
  resolved: ReadonlySet<string>,
): string[] {
  const names = statuses
    .filter((s) => isLivePhase(phase(s)) && !resolved.has(s.name))
    .map((s) => s.name)
  return selected !== null && names.includes(selected)
    ? [selected, ...names.filter((n) => n !== selected)]
    : names
}
