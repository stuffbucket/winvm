/**
 * The user's own settings, the same for every instance: `settings.json` in
 * winvm's XDG config directory (xdg.ts). Per-instance settings are config.ts.
 *
 *   winvm settings [--json]                      print them
 *   winvm settings key=value [...]               set some
 *   winvm settings --section NAME                one part the app owns, as JSON (null: none)
 *   winvm settings --section NAME --set JSON     replace that part (null removes it)
 *
 * THE ONE WRITER OF settings.json. The flat keys ("viewer.pauseOverlay") and
 * the app's sections ("checkpoints", an object the Checkpoints view owns)
 * share the file. Every write reads the whole file, changes only its own keys
 * and keeps the rest, so the pause overlay toggle and the Checkpoints view
 * never undo each other. Reading, only known flat keys count, each with a
 * default; a file that cannot be read is the defaults.
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

/** The whole file as an object, every key kept; {} when there is none or it cannot be read. */
function readAll(env: Env): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(settingsPath(env), "utf8"))
  } catch {
    return {}
  }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/** Writes the whole file at once (a temporary file, renamed), with `change` applied to what is in it now. */
function update(env: Env, change: (all: Record<string, unknown>) => void): void {
  const all = readAll(env)
  change(all)
  const file = settingsPath(env)
  mkdirSync(configDir(env), { recursive: true })
  const tmp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`)
  renameSync(tmp, file)
}

export function readSettings(env: Env = process.env): Settings {
  const got = readAll(env)
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

/** Sets flat keys, keeping everything else in the file (the app's sections too). */
export function writeSettings(changes: Partial<Settings>, env: Env = process.env): Settings {
  update(env, (all) => Object.assign(all, changes))
  return readSettings(env)
}

/** Why `name` cannot be a section (a plain word, never a flat key), or null. */
export function sectionError(name: string): string | null {
  if (!/^[a-z][a-zA-Z0-9-]{0,63}$/.test(name)) return `a settings section is a plain word, got "${name}"`
  return null
}

/** One part of the settings the app owns (e.g. "checkpoints"), or null when it has none. */
export function readSection(name: string, env: Env = process.env): unknown {
  return readAll(env)[name] ?? null
}

/** Replaces one part, keeping the others and the flat keys; null removes it. */
export function writeSection(name: string, value: unknown, env: Env = process.env): void {
  const err = sectionError(name)
  if (err !== null) throw new Error(err)
  update(env, (all) => {
    if (value === null) delete all[name]
    else all[name] = value
  })
}

/** `--section NAME [--set JSON]`: print one part as JSON, after replacing it if asked. */
function sectionCmd(name: string, set: string | undefined): number {
  const err = sectionError(name)
  if (err !== null) {
    console.error(`::error::${err}`)
    return 2
  }
  if (set !== undefined) {
    let value: unknown
    try {
      value = JSON.parse(set)
    } catch {
      console.error(`::error::--set takes JSON, got "${set}"`)
      return 2
    }
    writeSection(name, value)
  }
  console.log(JSON.stringify(readSection(name)))
  return 0
}

/** `winvm settings [--json] [key=value ...]`, or `winvm settings --section NAME [--set JSON]`. */
export function settingsCmd(args: Args): number {
  const section = args.flags.get("section")
  if (section !== undefined) return sectionCmd(section, args.flags.get("set"))
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
