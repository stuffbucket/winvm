/**
 * Per-instance settings: what the watcher does when the guest goes idle.
 *
 * Stored as OVERRIDES ONLY in `instances/<name>/config.json`, so a default that
 * changes in a later version reaches every instance that never chose otherwise.
 * `effectiveConfig` merges them over the defaults; `winvm config` prints that.
 *
 * Read by the watcher on every tick, so `winvm config ... key=value` takes
 * effect on a running watcher without restarting it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { instanceDir } from "./paths"

export interface InstanceConfig {
  readonly "autosave.enabled": boolean
  readonly "autosave.idleMinutes": number
  readonly "autosave.keep": number
  readonly "stow.enabled": boolean
  readonly "stow.idleMinutes": number
  readonly "watch.enabled": boolean
  /**
   * The guest counts as busy above this share of its vCPU capacity (QEMU's
   * process CPU time / wall time / vCPUs), averaged over the last minute.
   *
   * MEASURED on this guest (Windows 11 25H2 ARM64, 4 vCPUs, M-series host under
   * heavy load), 15 s samples: an idle desktop is 0.2-1%, with background
   * bursts (Defender, indexing) of 3-17% for a single sample; the worst
   * 1-minute average seen idle was ~5.5%. One busy thread (`cmd /c for /L`
   * loop via `winvm exec`) is 25%; four are 97-101%. 10% sits clear of both:
   * a burst does not restart the idle clock, a single busy thread for half a
   * minute does.
   */
  readonly "watch.idleCpuPercent": number
}

export type ConfigKey = keyof InstanceConfig

export const DEFAULTS: InstanceConfig = {
  "autosave.enabled": true,
  "autosave.idleMinutes": 10,
  "autosave.keep": 3,
  "stow.enabled": true,
  "stow.idleMinutes": 60,
  "watch.enabled": true,
  "watch.idleCpuPercent": 10,
}

export const CONFIG_KEYS = Object.keys(DEFAULTS) as readonly ConfigKey[]

export const configPath = (name: string): string => resolve(instanceDir(name), "config.json")

const isKey = (k: string): k is ConfigKey => Object.hasOwn(DEFAULTS, k)

/** The overrides an instance has set, ignoring anything unknown or mistyped. */
export function readOverrides(name: string): Partial<InstanceConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath(name), "utf8"))
  } catch {
    return {}
  }
  if (typeof raw !== "object" || raw === null) return {}
  const out: Partial<Record<ConfigKey, boolean | number>> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (isKey(k) && typeof v === typeof DEFAULTS[k]) out[k] = v as boolean | number
  }
  return out as Partial<InstanceConfig>
}

export function effectiveConfig(name: string): InstanceConfig {
  return { ...DEFAULTS, ...readOverrides(name) }
}

/**
 * Parse one `key=value`. Throws with a message fit for the user, because the
 * alternative — storing a string where a number belongs — surfaces much later
 * as a watcher that silently never saves.
 */
export function parseAssignment(assignment: string): [ConfigKey, boolean | number] {
  const eq = assignment.indexOf("=")
  if (eq < 1) throw new Error(`expected key=value, got "${assignment}"`)
  const key = assignment.slice(0, eq).trim()
  const value = assignment.slice(eq + 1).trim()
  if (!isKey(key)) throw new Error(`unknown setting "${key}" — one of: ${CONFIG_KEYS.join(", ")}`)
  if (typeof DEFAULTS[key] === "boolean") {
    if (/^(true|on|yes|1)$/i.test(value)) return [key, true]
    if (/^(false|off|no|0)$/i.test(value)) return [key, false]
    throw new Error(`${key} is true or false, got "${value}"`)
  }
  const n = Number(value)
  if (value === "" || !Number.isFinite(n) || n <= 0) throw new Error(`${key} is a positive number, got "${value}"`)
  if (key === "autosave.keep" && !Number.isInteger(n)) throw new Error(`${key} is a whole number, got "${value}"`)
  return [key, n]
}

/** Apply assignments and write the file atomically. Setting a key to its default removes the override. */
export function writeAssignments(name: string, assignments: readonly (readonly [ConfigKey, boolean | number])[]): void {
  const next: Partial<Record<ConfigKey, boolean | number>> = { ...readOverrides(name) }
  for (const [k, v] of assignments) {
    if (DEFAULTS[k] === v) delete next[k]
    else next[k] = v
  }
  mkdirSync(instanceDir(name), { recursive: true })
  const tmp = `${configPath(name)}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tmp, configPath(name))
}
