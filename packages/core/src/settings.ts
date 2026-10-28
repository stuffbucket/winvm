/**
 * The user's own settings, the same for every instance: `settings.json` in
 * winvm's XDG config directory (xdg.ts). Per-instance settings are config.ts.
 *
 *   winvm settings [--json]              print them
 *   winvm settings key=value [...]       set some
 *
 * Only known keys are kept, each with a default; a file that cannot be read is
 * the defaults.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Args } from "./args"
import { configDir } from "./xdg"

export interface Settings {
  /** The app dims a paused or asleep guest's screen and shows a pause glyph over it. */
  readonly "viewer.pauseOverlay": boolean
}

export const SETTING_DEFAULTS: Settings = { "viewer.pauseOverlay": true }

export type SettingKey = keyof Settings

const KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[]

const isKey = (k: string): k is SettingKey => (KEYS as string[]).includes(k)

type Env = Readonly<Record<string, string | undefined>>

export const settingsPath = (env: Env = process.env): string => resolve(configDir(env), "settings.json")

export function readSettings(env: Env = process.env): Settings {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(settingsPath(env), "utf8"))
  } catch {
    return SETTING_DEFAULTS
  }
  if (typeof raw !== "object" || raw === null) return SETTING_DEFAULTS
  const got = raw as Record<string, unknown>
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS }
  for (const k of KEYS) if (typeof got[k] === typeof SETTING_DEFAULTS[k]) out[k] = got[k]
  return out as unknown as Settings
}

/** `key=value` checked against the key's type; a string says what is wrong. */
export function parseSetting(assignment: string): { key: SettingKey; value: Settings[SettingKey] } | string {
  const eq = assignment.indexOf("=")
  if (eq <= 0) return `expected key=value, got "${assignment}"`
  const key = assignment.slice(0, eq)
  const value = assignment.slice(eq + 1)
  if (!isKey(key)) return `unknown setting "${key}" (known: ${KEYS.join(", ")})`
  if (value !== "true" && value !== "false") return `${key} is true or false, got "${value}"`
  return { key, value: value === "true" }
}

export function writeSettings(changes: Partial<Settings>, env: Env = process.env): Settings {
  const next = { ...readSettings(env), ...changes }
  const file = settingsPath(env)
  mkdirSync(configDir(env), { recursive: true })
  const tmp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(tmp, file)
  return next
}

/** `winvm settings [--json] [key=value ...]`. */
export function settingsCmd(args: Args): number {
  const changes: Record<string, unknown> = {}
  for (const a of args.positional) {
    const p = parseSetting(a)
    if (typeof p === "string") {
      console.error(`::error::${p}`)
      return 2
    }
    changes[p.key] = p.value
  }
  const now = Object.keys(changes).length === 0 ? readSettings() : writeSettings(changes as Partial<Settings>)
  if (args.flags.has("json")) console.log(JSON.stringify(now))
  else {
    for (const k of KEYS) console.log(`${k}=${String(now[k])}`)
    console.log(`\n  ${settingsPath()}`)
  }
  return 0
}
