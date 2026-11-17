import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

import { type Args, instanceName } from "./args"
import { dataDir } from "./xdg"

export interface MachineNote {
  readonly text: string
  readonly updatedAt: string
}

export const MAX_NOTE_CHARS = 20_000

type Env = NodeJS.ProcessEnv

export function machineNotePath(
  instance: string,
  env: Env = process.env,
): string {
  if (
    instance === "" ||
    instance.includes("/") ||
    instance.includes("\\") ||
    instance.startsWith(".")
  ) {
    throw new Error(`"${instance}" is not a valid instance name`)
  }
  return resolve(dataDir(env), "machine-notes", `${instance}.json`)
}

export function readMachineNote(
  instance: string,
  env: Env = process.env,
): MachineNote | null {
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
  const text = typeof r.text === "string" ? r.text : ""
  if (text.trim() === "") return null
  let updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : ""
  if (Number.isNaN(Date.parse(updatedAt))) {
    try {
      updatedAt = statSync(path).mtime.toISOString()
    } catch {
      updatedAt = new Date(0).toISOString()
    }
  }
  return { text, updatedAt }
}

export function writeMachineNote(
  instance: string,
  text: string,
  env: Env = process.env,
  now = new Date(),
): MachineNote | null {
  const path = machineNotePath(instance, env)
  if (text.trim() === "") {
    removeMachineNote(instance, env)
    return null
  }
  const note: MachineNote = {
    text: text.slice(0, MAX_NOTE_CHARS),
    updatedAt: now.toISOString(),
  }
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

export function removeMachineNote(
  instance: string,
  env: Env = process.env,
): void {
  rmSync(machineNotePath(instance, env), { force: true })
}

export function forgetMachineNote(
  instance: string,
  env: Env = process.env,
): void {
  try {
    removeMachineNote(instance, env)
  } catch {}
}

const NOTE_USAGE =
  "usage: winvm note [-i name] [--text TEXT|-] [--clear] [--json]"

export function noteCmd(
  args: Args,
  stdin: () => string = () => readFileSync(0, "utf8"),
): number {
  const fail = (message: string): number => {
    console.error(`::error::${message}`)
    return 2
  }
  if (args.positional.length > 1) return fail(NOTE_USAGE)
  const name = instanceName(args)
  const json = args.flags.has("json")
  let text = args.flags.get("text")
  const clear = args.flags.has("clear")
  if (clear && text !== undefined)
    return fail("--clear and --text together: choose one")
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
    else
      console.log(
        written === null
          ? `instance "${name}" has no note`
          : `updated the note on instance "${name}"`,
      )
    return 0
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
