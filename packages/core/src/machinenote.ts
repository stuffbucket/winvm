/**
 * A person's note on a machine: free text they jot about this Windows
 * instance, written in the viewer's suspended screen or with `winvm note`.
 *
 *   winvm note [-i name] [--json]               print it
 *   winvm note [-i name] --text TEXT|-          replace it (`-`: from stdin)
 *   winvm note [-i name] --clear                remove it
 *
 * It lives beside the notes on saves (notes.ts), in the XDG data dir, but in a
 * directory of its own:
 *
 *   $XDG_DATA_HOME/winvm/machine-notes/<instance>.json
 *     { "text": string, "updatedAt": ISO }
 *
 * Why not under notes/<instance>/: that directory is the instance's SAVES'
 * notes and goes whenever its saves do (`removeAllSaves`); a save may be called
 * anything, so a file there could clash with one. This note belongs to the
 * machine and goes with it: `destroy` removes it, even with --keep-saves.
 *
 * The same rules as notes.ts: the name is checked before it becomes a path, a
 * note with nothing in it is no file, a write is a temporary file renamed over.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { type Args, instanceName } from "./args"
import { dataDir } from "./xdg"

export interface MachineNote {
  readonly text: string
  /** ISO 8601: when the note was last written. */
  readonly updatedAt: string
}

/** A note is for jotting, not for keeping a manuscript: more than this is cut. */
export const MAX_NOTE_CHARS = 20_000

type Env = NodeJS.ProcessEnv

export function machineNotePath(instance: string, env: Env = process.env): string {
  if (instance === "" || instance.includes("/") || instance.includes("\\") || instance.startsWith(".")) {
    throw new Error(`"${instance}" is not a valid instance name`)
  }
  return resolve(dataDir(env), "machine-notes", `${instance}.json`)
}

/** The note on a machine; null when there is none, it is empty, or it cannot be read. */
export function readMachineNote(instance: string, env: Env = process.env): MachineNote | null {
  let path: string
  let raw: unknown
  try {
    path = machineNotePath(instance, env)
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const text = typeof r["text"] === "string" ? r["text"] : ""
  if (text.trim() === "") return null
  let updatedAt = typeof r["updatedAt"] === "string" ? r["updatedAt"] : ""
  if (Number.isNaN(Date.parse(updatedAt))) {
    try {
      updatedAt = statSync(path).mtime.toISOString()
    } catch {
      updatedAt = new Date(0).toISOString()
    }
  }
  return { text, updatedAt }
}

/** Replaces the note; text with nothing in it removes it, and null is returned. */
export function writeMachineNote(instance: string, text: string, env: Env = process.env, now = new Date()): MachineNote | null {
  const path = machineNotePath(instance, env)
  if (text.trim() === "") {
    removeMachineNote(instance, env)
    return null
  }
  const note: MachineNote = { text: text.slice(0, MAX_NOTE_CHARS), updatedAt: now.toISOString() }
  mkdirSync(resolve(path, ".."), { recursive: true })
  const tmp = `${path}.tmp-${String(process.pid)}`
  try {
    writeFileSync(tmp, `${JSON.stringify(note, null, 2)}\n`)
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  return note
}

export function removeMachineNote(instance: string, env: Env = process.env): void {
  rmSync(machineNotePath(instance, env), { force: true })
}

/** For `destroy`: an instance name the store refuses has no note to remove. */
export function forgetMachineNote(instance: string, env: Env = process.env): void {
  try {
    removeMachineNote(instance, env)
  } catch {
    // see above
  }
}

const NOTE_USAGE = "usage: winvm note [-i name] [--text TEXT|-] [--clear] [--json]"

/** `winvm note`: print the machine's note, or replace or clear it. */
export function noteCmd(args: Args, stdin: () => string = () => readFileSync(0, "utf8")): number {
  const fail = (message: string): number => {
    console.error(`::error::${message}`)
    return 2
  }
  if (args.positional.length > 1) return fail(NOTE_USAGE)
  const name = instanceName(args)
  const json = args.flags.has("json")
  let text = args.flags.get("text")
  const clear = args.flags.has("clear")
  if (clear && text !== undefined) return fail("--clear and --text together: choose one")
  try {
    if (text === undefined && !clear) {
      const n = readMachineNote(name)
      if (json) console.log(JSON.stringify(n, null, 2))
      else if (n === null) console.log(`instance "${name}" has no note`)
      else console.log(n.text)
      return 0
    }
    if (text === "-") text = stdin().replace(/\s+$/, "")
    const written = writeMachineNote(name, clear ? "" : (text ?? ""))
    if (json) console.log(JSON.stringify(written, null, 2))
    else console.log(written === null ? `instance "${name}" has no note` : `updated the note on instance "${name}"`)
    return 0
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
