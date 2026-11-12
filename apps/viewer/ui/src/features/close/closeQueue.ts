import type { Status } from "../../model"
import { isLivePhase, phase } from "../../model"

/**
 * The machines a close still has to resolve, in the order it asks: the selected one first,
 * then the others in the list's own order. Only live machines (running, starting, paused,
 * asleep) are asked about, and none already resolved: called again on a fresh list, it is
 * what started since.
 */
export function orderCloseQueue(statuses: readonly Status[], selected: string | null, resolved: ReadonlySet<string>): string[] {
  const names = statuses.filter((s) => isLivePhase(phase(s)) && !resolved.has(s.name)).map((s) => s.name)
  return selected !== null && names.includes(selected) ? [selected, ...names.filter((n) => n !== selected)] : names
}
