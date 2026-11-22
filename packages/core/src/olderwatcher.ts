import { readFileSync, rmSync, statSync } from "node:fs"
import { resolve } from "node:path"

import { instanceDir } from "./paths"
import { processStart, UNREADABLE_START } from "./proc"
import { spawnText } from "./shell"

const pidFile = (name: string): string =>
  resolve(instanceDir(name), "watch.pid")

function instanceIn(afterVerb: string): string | null {
  const words = afterVerb.trim().split(/\s+/)
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? ""
    if (w === "-i" || w === "--instance") return words[i + 1] ?? null
    if (w.startsWith("--instance=")) return w.slice("--instance=".length)
  }
  return null
}

const WINVM_WATCH =
  /(?:^|[\s/])winvm(?:\.ts|-[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)?)?\s+watch(\s.*)?$/

function watchesInstance(command: string, name: string): boolean {
  const m = WINVM_WATCH.exec(command.trim())
  if (m === null) return false
  const rest = m[1] ?? ""
  if (/(?:^|\s)--(?:stop|status)(?:\s|$)/.test(rest)) return false
  return (instanceIn(rest) ?? "default") === name
}

interface OlderWatcher {
  readonly pid: number
  readonly start: string
}

export interface IdentitySeams {
  readonly startOf?: (pid: number) => string | null
  readonly commandOf?: (pid: number) => string
}

const commandOfPid = (pid: number): string =>
  spawnText("ps", ["-o", "command=", "-p", String(pid)]).stdout

function wrotePidFile(start: string, file: string): boolean {
  const started = Date.parse(`${start} UTC`)
  try {
    return !Number.isNaN(started) && started <= statSync(file).mtimeMs
  } catch {
    return false
  }
}

export function olderWatcher(
  name: string,
  seams: IdentitySeams = {},
): OlderWatcher | null {
  const startOf = seams.startOf ?? processStart
  const commandOf = seams.commandOf ?? commandOfPid
  const file = pidFile(name)
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10)
  } catch {
    return null
  }
  const start = Number.isInteger(pid) && pid > 1 ? startOf(pid) : null
  if (start === UNREADABLE_START) return null
  const command = start === null ? "" : commandOf(pid)
  if (start !== null && command.trim() === "") return null
  if (
    start !== null &&
    pid !== process.pid &&
    wrotePidFile(start, file) &&
    watchesInstance(command, name)
  )
    return { pid, start }
  rmSync(file, { force: true })
  return null
}

function savingIn(name: string, pid: number): boolean {
  try {
    const st = JSON.parse(
      readFileSync(resolve(instanceDir(name), "watch.json"), "utf8"),
    ) as { pid?: unknown; state?: unknown }
    return (
      st.pid === pid && (st.state === "autosaving" || st.state === "stowing")
    )
  } catch {
    return false
  }
}

export interface StopSeams extends IdentitySeams {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export async function stopOlderWatcher(
  name: string,
  seams: StopSeams = {},
): Promise<boolean> {
  const kill =
    seams.kill ??
    ((pid: number, signal: NodeJS.Signals): void =>
      void process.kill(pid, signal))
  const now = seams.now ?? Date.now
  const wait =
    seams.sleep ??
    (async (ms: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, ms))
    })
  const startOf = seams.startOf ?? processStart
  const w = olderWatcher(name, seams)
  if (w === null || w.pid === process.ppid) return false
  const gone = (): boolean => {
    const start = startOf(w.pid)
    return start === null || (start !== UNREADABLE_START && start !== w.start)
  }
  try {
    kill(w.pid, "SIGTERM")
  } catch {
    return false
  }
  const deadline = now() + (savingIn(name, w.pid) ? 10 * 60_000 : 10_000)
  while (now() < deadline) {
    if (gone()) break
    await wait(200)
  }
  if (startOf(w.pid) === w.start) {
    try {
      kill(w.pid, "SIGKILL")
    } catch {}
  }
  try {
    if (readFileSync(pidFile(name), "utf8").trim() === String(w.pid))
      rmSync(pidFile(name), { force: true })
  } catch {}
  return true
}
