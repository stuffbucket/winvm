/** Existing per-machine watcher settings, read and written through the CLI. */
import { z } from "zod"

const positive = z.number().finite().positive()
export const Policy = z.object({
  "autosave.enabled": z.boolean(),
  "autosave.idleMinutes": positive,
  "autosave.keep": positive.int(),
  "stow.enabled": z.boolean(),
  "stow.idleMinutes": positive,
  "watch.enabled": z.boolean(),
  "power.keepAwake": z.boolean(),
})
export type Policy = z.infer<typeof Policy>

export function parsePolicy(stdout: string): Policy | null {
  try { return Policy.safeParse(JSON.parse(stdout)).data ?? null } catch { return null }
}

export const policyReadArgs = (instance: string): string[] => ["config", "-i", instance, "--json"]

/** Only changed keys: don't overwrite settings another window/CLI changed meanwhile. */
export function policyWriteArgs(instance: string, before: Policy, after: Policy): string[] {
  const checked = Policy.parse(after)
  return ["config", "-i", instance, ...Object.entries(checked).filter(([key, value]) => before[key as keyof Policy] !== value).map(([key, value]) => `${key}=${String(value)}`), "--json"]
}
