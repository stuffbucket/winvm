/**
 * Which machine-impacting command is running against an instance, across
 * processes. The viewer and the close policy read this to tell "starting" or
 * "saving" from an idle machine, so it has to survive a crashed command
 * without becoming a permanent busy state.
 *
 * Each running command publishes `operations/<pid>.json` and removes exactly
 * that record when it settles. Readers never trust a record on its own: the
 * pid must be alive and still be a WinVM CLI process running the recorded verb.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { commandInstance, winvmCommandAfter } from "./args"
import type { Args } from "./args"
import { pathsFor } from "./paths"

export const VM_OPERATIONS = [
  "start",
  "stop",
  "reboot",
  "kill",
  "reset",
  "snapshot",
  "rewind",
  "save",
  "load",
  "pause",
  "resume",
  "sleep",
  "wake",
  "lock",
  "stow",
  "setup",
  "golden-create",
  "golden-reset",
] as const

export type VmOperation = (typeof VM_OPERATIONS)[number]

export interface OperationInfo {
  readonly operation: VmOperation
  readonly pid: number
  readonly startedAt: string
}

/** What is on disk: the public record plus the lease token that proves ownership. */
interface OperationRecord extends OperationInfo {
  readonly instance: string
  readonly token: string
}

export interface OperationReadSeams {
  readonly alive?: (pid: number) => boolean
  readonly command?: (pid: number) => string | null
}

/** Whether a process with this pid exists. EPERM means it does, and is someone else's. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The process's command line as `ps` prints it, or null when there is none. */
function commandOf(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  const text = (r.stdout ?? "").trim()
  return r.status === 0 && text !== "" ? text : null
}

const recordFile = (name: string, pid: number): string => resolve(pathsFor(name).operations, `${String(pid)}.json`)

/** Write the record whole, or not at all: a reader never sees half of one. */
function publish(file: string, record: OperationRecord): void {
  const tmp = `${file}.${String(process.pid)}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
  renameSync(tmp, file)
}

/** Remove the file only while it still carries this lease; a newer owner's is left alone. */
function release(file: string, token: string): void {
  try {
    const current = JSON.parse(readFileSync(file, "utf8")) as { token?: unknown }
    if (current.token === token) rmSync(file, { force: true })
  } catch {
    // already gone or replaced by something unreadable: not this lease's to remove
  }
}

const isOperation = (v: unknown): v is VmOperation => typeof v === "string" && (VM_OPERATIONS as readonly string[]).includes(v)

/** The nested `winvm golden <action>` each golden operation is. */
const GOLDEN_ACTION: Readonly<Partial<Record<VmOperation, string>>> = { "golden-create": "create", "golden-reset": "reset" }

/**
 * The operation a CLI invocation performs on its machine, or null for one that
 * only reads or touches something else. `golden` counts only for the two
 * actions that run or replace the machine's state.
 */
export function operationFor(sub: string | undefined, args: Args): VmOperation | null {
  if (sub === "golden") {
    const action = args.positional[0]
    return action === "create" ? "golden-create" : action === "reset" ? "golden-reset" : null
  }
  return isOperation(sub) && GOLDEN_ACTION[sub] === undefined ? sub : null
}

export async function withOperation<T>(name: string, operation: VmOperation, run: () => T | Promise<T>): Promise<T> {
  const file = recordFile(name, process.pid)
  const token = randomUUID()
  mkdirSync(pathsFor(name).operations, { recursive: true })
  publish(file, { operation, pid: process.pid, startedAt: new Date().toISOString(), instance: name, token })
  try {
    return await run()
  } finally {
    release(file, token)
  }
}

/** The record in `text`, if it is a whole one written by process `pid` for `name`. */
function parseRecord(text: string, pid: number, name: string): OperationRecord | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (!isOperation(r["operation"]) || r["pid"] !== pid || r["instance"] !== name) return null
  if (typeof r["startedAt"] !== "string" || typeof r["token"] !== "string" || r["token"] === "") return null
  return { operation: r["operation"], pid, startedAt: r["startedAt"], instance: name, token: r["token"] }
}

/**
 * Whether `command` is a WinVM CLI process running `operation` for `name`. An
 * explicit selector must name this instance; without one the command ran
 * against the instance it resolved (WINVM_INSTANCE, else "default"), which `ps`
 * cannot show, so the record's own instance stands.
 */
function runs(command: string, operation: VmOperation, name: string): boolean {
  const nested = GOLDEN_ACTION[operation]
  const after = winvmCommandAfter(command, nested === undefined ? operation : "golden")
  if (after === null) return false
  if (nested !== undefined && after.trim().split(/\s+/)[0] !== nested) return false
  const selected = commandInstance(after)
  return selected === null || selected === name
}

/**
 * Remove a record judged stale — exactly the one inspected. A command that
 * published its own meanwhile (a reused pid, or a lease renewed in place) must
 * keep it, so the file is moved aside, compared with what was judged, and put
 * back if it differs.
 */
function dropStale(file: string, judged: string): void {
  const aside = `${file}.${String(process.pid)}.${randomUUID()}.stale`
  try {
    renameSync(file, aside)
  } catch {
    return
  }
  try {
    if (readFileSync(aside, "utf8") !== judged) {
      try {
        // Another owner may have published since; if so, theirs stands.
        linkSync(aside, file)
      } catch {
        // EEXIST: a newer record already holds the name
      }
    }
  } catch {
    // vanished: nothing of ours to put back
  }
  rmSync(aside, { force: true })
}

export function readOperation(name: string, seams: OperationReadSeams = {}): OperationInfo | null {
  const alive = seams.alive ?? isAlive
  const command = seams.command ?? commandOf
  const dir = pathsFor(name).operations
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  let newest: OperationRecord | null = null
  for (const entry of entries) {
    const pid = /^(\d+)\.json$/.exec(entry)?.[1]
    if (pid === undefined) continue
    const file = resolve(dir, entry)
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    const r = parseRecord(text, Number(pid), name)
    const cmd = r !== null && alive(r.pid) ? command(r.pid) : null
    if (r === null || cmd === null || !runs(cmd, r.operation, name)) {
      dropStale(file, text)
      continue
    }
    if (newest === null || r.startedAt > newest.startedAt || (r.startedAt === newest.startedAt && r.pid > newest.pid)) newest = r
  }
  return newest === null ? null : { operation: newest.operation, pid: newest.pid, startedAt: newest.startedAt }
}
