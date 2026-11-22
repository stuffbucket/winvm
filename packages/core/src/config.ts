import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { instanceDir } from "./paths"

export const CLOSE_POLICIES = ["ask", "leave", "stow", "shutdown"] as const

export type ClosePolicy = (typeof CLOSE_POLICIES)[number]

export const HOST_END_ACTIONS = ["stow", "shutdown"] as const

export type HostEndAction = (typeof HOST_END_ACTIONS)[number]

export interface InstanceConfig {
  readonly "autosave.enabled": boolean
  readonly "autosave.idleMinutes": number
  readonly "autosave.keep": number
  readonly "hostEnd.action": HostEndAction
  readonly "stow.enabled": boolean
  readonly "stow.idleMinutes": number
  readonly "viewer.closePolicy": ClosePolicy
  readonly "watch.enabled": boolean
  readonly "watch.idleCpuPercent": number
  readonly "power.keepAwake": boolean
  readonly title: string
}

export type ConfigKey = keyof InstanceConfig

export const DEFAULTS: InstanceConfig = {
  "autosave.enabled": true,
  "autosave.idleMinutes": 10,
  "autosave.keep": 3,
  "hostEnd.action": "stow",
  "stow.enabled": true,
  "stow.idleMinutes": 60,
  "viewer.closePolicy": "ask",
  "watch.enabled": true,
  "watch.idleCpuPercent": 10,
  "power.keepAwake": false,
  title: "",
}

export const TITLE_MAX = 80

export function checkTitle(raw: string): string {
  const title = raw.trim()
  if (Array.from(title).length > TITLE_MAX)
    throw new Error(`title is at most ${String(TITLE_MAX)} characters`)
  if (
    /[\p{Cc}\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u.test(
      title,
    )
  )
    throw new Error("title is one line of text, without control characters")
  return title
}

type Value = InstanceConfig[ConfigKey]

const isClosePolicy = (v: string): v is ClosePolicy =>
  (CLOSE_POLICIES as readonly string[]).includes(v)

const isHostEndAction = (v: string): v is HostEndAction =>
  (HOST_END_ACTIONS as readonly string[]).includes(v)

const valid = (k: ConfigKey, v: unknown): v is Value => {
  if (typeof v !== typeof DEFAULTS[k]) return false
  if (typeof v !== "string") return true
  if (k === "viewer.closePolicy") return isClosePolicy(v)
  if (k === "hostEnd.action") return isHostEndAction(v)
  try {
    return checkTitle(v) === v
  } catch {
    return false
  }
}

export const CONFIG_KEYS = Object.keys(DEFAULTS) as readonly ConfigKey[]

export const configPath = (name: string): string =>
  resolve(instanceDir(name), "config.json")

const isKey = (k: string): k is ConfigKey => Object.hasOwn(DEFAULTS, k)

export function readOverrides(name: string): Partial<InstanceConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath(name), "utf8"))
  } catch {
    return {}
  }
  if (typeof raw !== "object" || raw === null) return {}
  const out: Partial<Record<ConfigKey, Value>> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (isKey(k) && valid(k, v)) out[k] = v
  }
  return out as Partial<InstanceConfig>
}

export function effectiveConfig(name: string): InstanceConfig {
  return { ...DEFAULTS, ...readOverrides(name) }
}

export function parseAssignment(assignment: string): [ConfigKey, Value] {
  const eq = assignment.indexOf("=")
  if (eq < 1) throw new Error(`expected key=value, got "${assignment}"`)
  const key = assignment.slice(0, eq).trim()
  const value = assignment.slice(eq + 1).trim()
  if (!isKey(key))
    throw new Error(
      `unknown setting "${key}" — one of: ${CONFIG_KEYS.join(", ")}`,
    )
  if (key === "viewer.closePolicy") {
    if (isClosePolicy(value)) return [key, value]
    throw new Error(
      `${key} is one of: ${CLOSE_POLICIES.join(", ")}, got "${value}"`,
    )
  }
  if (key === "hostEnd.action") {
    if (isHostEndAction(value)) return [key, value]
    throw new Error(
      `${key} is one of: ${HOST_END_ACTIONS.join(", ")}, got "${value}"`,
    )
  }
  if (typeof DEFAULTS[key] === "string") return [key, checkTitle(value)]
  if (typeof DEFAULTS[key] === "boolean") {
    if (/^(true|on|yes|1)$/i.test(value)) return [key, true]
    if (/^(false|off|no|0)$/i.test(value)) return [key, false]
    throw new Error(`${key} is true or false, got "${value}"`)
  }
  const n = Number(value)
  if (value === "" || !Number.isFinite(n) || n <= 0)
    throw new Error(`${key} is a positive number, got "${value}"`)
  if (key === "autosave.keep" && !Number.isInteger(n))
    throw new Error(`${key} is a whole number, got "${value}"`)
  return [key, n]
}

export function writeAssignments(
  name: string,
  assignments: readonly (readonly [ConfigKey, Value])[],
): void {
  const next: Partial<Record<ConfigKey, Value>> = { ...readOverrides(name) }
  for (const [k, v] of assignments) {
    if (DEFAULTS[k] === v) delete next[k]
    else next[k] = v
  }
  mkdirSync(instanceDir(name), { recursive: true })
  const tmp = `${configPath(name)}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tmp, configPath(name))
}
