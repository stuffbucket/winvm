import { spawn, spawnSync } from "node:child_process"
import { chmodSync, closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

import { commandInstance, winvmCommandAfter } from "./args"
import { buildIdentity } from "./identity"
import { cliArgv, managedEnv, type Paths } from "./paths"

export interface ServiceInfo {
  readonly pid: number
  readonly cli: string
  readonly version: string
  readonly startedAt: string
  /** The build that started it (identity.ts). Absent in a record written before generations were recorded. */
  readonly build?: string
}

export type Freshness = "current" | "stale" | "legacy"

/**
 * Whether a record was written by the build running now. A record with no
 * build predates generations and is "legacy": it may be live, but nothing says
 * which code it runs. Callers decide what to do with each; readService does not.
 */
export const serviceFreshness = (info: ServiceInfo, current: string = buildIdentity()): Freshness =>
  info.build === undefined || info.build === "" ? "legacy" : info.build === current ? "current" : "stale"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function livePidIn(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10)
    return Number.isFinite(pid) && alive(pid) ? pid : null
  } catch {
    return null
  }
}

export function recordedPid(p: Paths): number | null {
  return pidIn(readRecord(p))
}

/** The record's text exactly as it is on disk, or null. */
function readRecord(p: Paths): string | null {
  try {
    return readFileSync(p.service, "utf8")
  } catch {
    return null
  }
}

function pidIn(text: string | null): number | null {
  if (text === null) return null
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid
    return typeof pid === "number" ? pid : null
  } catch {
    return null
  }
}

/**
 * Whether the pid is `name`'s service: a `serve` run by the winvm CLI — its
 * entry, `winvm.ts` from source or the compiled `winvm`, right before the verb
 * — naming exactly this instance with `-i`/`--instance`. winvm always spawns it
 * so. A bare `… serve` (ollama's, hugo's, or a `serve` with no instance) is
 * never taken for one: a reused pid must not be signalled. Nor is this very
 * process, whatever a stale record says (only claim() may recognise itself).
 */
function isServiceFor(pid: number, name: string): boolean {
  if (pid === process.pid) return false
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  const after = winvmCommandAfter(r.stdout ?? "", "serve")
  return after !== null && commandInstance(after) === name
}

export function readService(p: Paths): ServiceInfo | null {
  try {
    const s = JSON.parse(readFileSync(p.service, "utf8")) as ServiceInfo
    return typeof s.pid === "number" && alive(s.pid) && isServiceFor(s.pid, basename(p.dir)) ? s : null
  } catch {
    return null
  }
}

/**
 * Remove a record judged rejected (or a service's, once stopped) — only while it
 * is still that same record. A service starting meanwhile may have claimed the
 * file with its own; that claim is put back, not lost. The record is moved
 * aside, compared, and linked back if it is not the one judged.
 */
export function dropServiceRecord(p: Paths, judged: string): boolean {
  const aside = `${p.service}.${String(process.pid)}.${String(Date.now())}.drop`
  try {
    renameSync(p.service, aside)
  } catch {
    return false
  }
  let moved: string | null = null
  try {
    moved = readFileSync(aside, "utf8")
  } catch {
    // vanished
  }
  if (moved !== judged) {
    try {
      linkSync(aside, p.service)
    } catch {
      // A newer claim is in place already.
    }
    rmSync(aside, { force: true })
    return false
  }
  rmSync(aside, { force: true })
  return true
}

const keepPath = (p: Paths): string => resolve(p.dir, "service.keep")

export function keepService(p: Paths): void {
  writeFileSync(keepPath(p), `${new Date().toISOString()}\n`)
}

export function keptWithin(p: Paths, ms: number): boolean {
  try {
    return Date.now() - statSync(keepPath(p)).mtimeMs < ms
  } catch {
    return false
  }
}

export function claim(p: Paths, name: string, info: ServiceInfo): void {
  const tmp = `${p.service}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, p.service)
        return
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      }
      const seen = readRecord(p)
      // Another service of this very process (tests run several in one) holds
      // it: that is the one place this process is recognised as a service.
      const holderPid = pidIn(seen)
      if (holderPid === process.pid) throw new Error(`another winvm service (pid ${String(holderPid)}) holds instance "${name}"`)
      const holder = readService(p)
      if (holder !== null) throw new Error(`another winvm service (pid ${String(holder.pid)}) holds instance "${name}"`)
      if (seen !== null) dropServiceRecord(p, seen)
    }
    throw new Error(`could not claim instance "${name}": ${p.service} keeps reappearing`)
  } finally {
    rmSync(tmp, { force: true })
  }
}

async function answers(control: string): Promise<boolean> {
  try {
    return (await fetch("http://localhost/status", { unix: control, signal: AbortSignal.timeout(1000) })).ok
  } catch {
    return false
  }
}

/** Process and clock access for stopService, so tests need neither real signals nor real waiting. */
export interface StopServiceSeams {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => void
  /** Whether the pid is still running at all (a zombie is not). */
  readonly running?: (pid: number) => boolean
  /** Whether the pid is still this instance's service (alive, and ` serve -i <name>`). */
  readonly isService?: (pid: number) => boolean
}

export function stopService(p: Paths, seams: StopServiceSeams = {}): void {
  const name = basename(p.dir)
  const kill = seams.kill ?? ((pid: number, signal: NodeJS.Signals): void => void process.kill(pid, signal))
  const now = seams.now ?? Date.now
  const sleep = seams.sleep ?? ((ms: number): void => { Bun.sleepSync(ms) })
  const running = seams.running ?? ((pid: number): boolean => alive(pid) && !exited(pid))
  const isService = seams.isService ?? ((pid: number): boolean => alive(pid) && isServiceFor(pid, name))
  // Only a pid the record names AND that is still this instance's service is ever signalled.
  const seen = readRecord(p)
  const pid = pidIn(seen)
  if (seen === null || pid === null || !isService(pid)) return
  try {
    kill(pid, "SIGTERM")
  } catch {
    return
  }
  const deadline = now() + 5000
  while (running(pid) && now() < deadline) sleep(50)
  // Checked again at the last moment: five seconds is long enough for the
  // service to have exited and its pid to belong to something else.
  if (running(pid) && isService(pid)) {
    try {
      kill(pid, "SIGKILL")
    } catch {
      // gone
    }
  }
  // Its record, unless a service started since has claimed the file with its own.
  dropServiceRecord(p, seen)
}

function exited(pid: number): boolean {
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  const stat = (r.stdout ?? "").trim()
  return stat === "" || stat.startsWith("Z")
}

export interface EnsureServiceOptions {
  /** Launches the service. Defaults to a detached `winvm serve`. */
  readonly start?: () => void
  /** How long to wait for the replacement to be current and answering. */
  readonly timeoutMs?: number
  /** The generation that counts as current. Defaults to this process's build. */
  readonly current?: string
}

export async function ensureService(name: string, p: Paths, o: EnsureServiceOptions = {}): Promise<ServiceInfo> {
  const current = o.current ?? buildIdentity()
  const seen = readRecord(p)
  const running = readService(p)
  if (running !== null && serviceFreshness(running, current) === "current") {
    keepService(p)
    return running
  }
  // readService vouches for the pid (alive, and a service for this instance), so a
  // stop signals only a real service. A record it rejects names a gone process or a
  // reused pid: drop that very record (not a newer claim) and signal nobody.
  if (running !== null) stopService(p)
  else if (seen !== null) dropServiceRecord(p, seen)
  keepService(p)
  const start =
    o.start ??
    ((): void => {
      const log = openSync(resolve(p.dir, "service.log"), "a")
      const child = spawn(process.execPath, [...cliArgv("serve", "-i", name)], {
        detached: true,
        stdio: ["ignore", log, log],
        env: managedEnv(),
      })
      closeSync(log)
      child.unref()
    })
  start()
  const deadline = Date.now() + (o.timeoutMs ?? 10_000)
  while (Date.now() < deadline) {
    const info = readService(p)
    if (info !== null && serviceFreshness(info, current) === "current" && (await answers(p.control))) return info
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`the control service for "${name}" did not start; see ${resolve(p.dir, "service.log")}`)
}
