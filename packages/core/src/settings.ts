import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Args } from "./args"
import { configDir } from "./xdg"

export interface Settings {
  readonly "viewer.pauseOverlay": boolean
}

export const SETTING_DEFAULTS: Settings = { "viewer.pauseOverlay": true }

export type SettingKey = keyof Settings

const KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[]

const isKey = (k: string): k is SettingKey => (KEYS as string[]).includes(k)

type Env = Readonly<Record<string, string | undefined>>

export const settingsPath = (env: Env = process.env): string => resolve(configDir(env), "settings.json")

function readAll(env: Env): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(settingsPath(env), "utf8"))
  } catch {
    return {}
  }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

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
  update(env, (all) => Object.assign(all, changes))
  return readSettings(env)
}

export function sectionError(name: string): string | null {
  if (!/^[a-z][a-zA-Z0-9-]{0,63}$/.test(name)) return `a settings section is a plain word, got "${name}"`
  return null
}

export function readSection(name: string, env: Env = process.env): unknown {
  return readAll(env)[name] ?? null
}

export function writeSection(name: string, value: unknown, env: Env = process.env): void {
  const err = sectionError(name)
  if (err !== null) throw new Error(err)
  update(env, (all) => {
    if (value === null) delete all[name]
    else all[name] = value
  })
}

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
  const now = Object.keys(changes).length === 0 ? readSettings() : writeSettings(changes)
  if (args.flags.has("json")) console.log(JSON.stringify(now))
  else {
    for (const k of KEYS) console.log(`${k}=${String(now[k])}`)
    console.log(`\n  ${settingsPath()}`)
  }
  return 0
}
