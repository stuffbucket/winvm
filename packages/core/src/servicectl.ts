import { spawn } from "node:child_process"
import {
  chmodSync,
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

import { buildIdentity } from "./identity"
import { KEEPER_PROTOCOL, keeperRequest } from "./keeper"
import {
  callerUmask,
  type KeeperHello,
  keeperHello,
  keeperSocket,
  keptEnv,
} from "./kept"
import { cliArgv, managedEnv, type Paths } from "./paths"
import { isAlive, processStart, UNREADABLE_START } from "./proc"

export interface ServiceInfo {
  readonly pid: number
  readonly cli: string
  readonly version: string
  readonly startedAt: string
  readonly build?: string
}

export type Freshness = "current" | "stale" | "legacy"

export const serviceFreshness = (
  info: ServiceInfo,
  current: string = buildIdentity(),
): Freshness =>
  info.build === undefined || info.build === ""
    ? "legacy"
    : info.build === current
      ? "current"
      : "stale"

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

export function wroteRecord(
  info: Pick<ServiceInfo, "pid" | "startedAt">,
  startOf: (pid: number) => string | null = processStart,
): boolean {
  if (info.pid === process.pid) return false
  const claimed = Date.parse(info.startedAt)
  const start = startOf(info.pid)
  if (start === null || start === UNREADABLE_START || Number.isNaN(claimed))
    return false
  const started = Date.parse(`${start} UTC`)
  return !Number.isNaN(started) && started <= claimed
}

function parseRecord(text: string | null): ServiceInfo | null {
  if (text === null) return null
  try {
    const s = JSON.parse(text) as Partial<ServiceInfo>
    return typeof s.pid === "number" && typeof s.startedAt === "string"
      ? (s as ServiceInfo)
      : null
  } catch {
    return null
  }
}

export function readService(p: Paths): ServiceInfo | null {
  const s = parseRecord(readRecord(p))
  return s !== null && wroteRecord(s) ? s : null
}

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
  } catch {}
  if (moved !== judged) {
    try {
      linkSync(aside, p.service)
    } catch {}
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
      const holderPid = pidIn(seen)
      if (holderPid === process.pid)
        throw new Error(
          `another winvm service (pid ${String(holderPid)}) holds instance "${name}"`,
        )
      const holder = readService(p)
      if (holder !== null)
        throw new Error(
          `another winvm service (pid ${String(holder.pid)}) holds instance "${name}"`,
        )
      if (seen !== null) dropServiceRecord(p, seen)
    }
    throw new Error(
      `could not claim instance "${name}": ${p.service} keeps reappearing`,
    )
  } finally {
    rmSync(tmp, { force: true })
  }
}

async function answers(control: string): Promise<boolean> {
  try {
    return (
      await fetch("http://localhost/status", {
        unix: control,
        signal: AbortSignal.timeout(1000),
      })
    ).ok
  } catch {
    return false
  }
}

export interface StopServiceSeams {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => void
  readonly running?: (pid: number) => boolean
  readonly isService?: (info: ServiceInfo) => boolean
}

export function stopService(p: Paths, seams: StopServiceSeams = {}): void {
  const kill =
    seams.kill ??
    ((pid: number, signal: NodeJS.Signals): void =>
      void process.kill(pid, signal))
  const now = seams.now ?? Date.now
  const sleep =
    seams.sleep ??
    ((ms: number): void => {
      Bun.sleepSync(ms)
    })
  const running = seams.running ?? isAlive
  const isService =
    seams.isService ?? ((info: ServiceInfo) => wroteRecord(info))
  const seen = readRecord(p)
  const info = parseRecord(seen)
  if (seen === null || info === null || !isService(info)) return
  try {
    kill(info.pid, "SIGUSR2")
  } catch {
    return
  }
  const deadline = now() + 5000
  while (running(info.pid) && now() < deadline) sleep(50)
  if (running(info.pid) && isService(info)) {
    try {
      kill(info.pid, "SIGKILL")
    } catch {}
  }
  dropServiceRecord(p, seen)
}

export interface EnsureServiceOptions {
  readonly start?: () => void
  readonly timeoutMs?: number
  readonly current?: string
}

async function untilAnswering(
  name: string,
  p: Paths,
  current: string,
  timeoutMs: number,
): Promise<ServiceInfo> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = readService(p)
    if (
      info !== null &&
      serviceFreshness(info, current) === "current" &&
      (await answers(p.control))
    )
      return info
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(
    `the control service for "${name}" did not start; see ${resolve(p.dir, "service.log")}`,
  )
}

async function keptService(
  name: string,
  p: Paths,
  hello: KeeperHello,
  current: string,
  timeoutMs: number,
): Promise<ServiceInfo> {
  const running = readService(p)
  const kept = hello.service
  const ours = running !== null && kept?.pid === running.pid
  const orphaned = kept?.adopted ?? false
  if (ours && !orphaned && serviceFreshness(running, current) === "current") {
    keepService(p)
    return running
  }
  if (ours && orphaned)
    await keeperRequest(keeperSocket(p), { op: "service-stop" })
  if (running !== null && !ours) stopService(p)
  else if (running === null && hello.service === null) {
    const seen = readRecord(p)
    if (seen !== null) dropServiceRecord(p, seen)
  }
  keepService(p)
  const answer = await keeperRequest(keeperSocket(p), {
    op: "service",
    service: {
      argv: [process.execPath, ...cliArgv("serve", "-i", name)],
      env: keptEnv(managedEnv()),
      log: resolve(p.dir, "service.log"),
      umask: callerUmask(),
      build: current,
      control: p.control,
    },
  })
  if (answer.ok !== true)
    throw new Error(
      `winvm's keeper did not start the control service for "${name}": ${typeof answer.error === "string" ? answer.error : "no reason given"}`,
    )
  return await untilAnswering(name, p, current, timeoutMs)
}

function ownService(p: Paths): ServiceInfo | null {
  const seen = readRecord(p)
  if (seen === null || pidIn(seen) !== process.pid) return null
  try {
    return JSON.parse(seen) as ServiceInfo
  } catch {
    return null
  }
}

export async function ensureService(
  name: string,
  p: Paths,
  o: EnsureServiceOptions = {},
): Promise<ServiceInfo> {
  const own = ownService(p)
  if (own !== null) return own
  const current = o.current ?? buildIdentity()
  const hello = await keeperHello(p)
  if (hello?.hostEnding === true)
    throw new Error(
      `winvm's keeper for "${name}" is ending its session (the Mac is shutting down or you logged out), so its control service is left as it is`,
    )
  if (
    o.start === undefined &&
    hello !== null &&
    hello.protocol >= KEEPER_PROTOCOL
  )
    return await keptService(name, p, hello, current, o.timeoutMs ?? 10_000)
  const seen = readRecord(p)
  const running = readService(p)
  if (running !== null && serviceFreshness(running, current) === "current") {
    keepService(p)
    return running
  }
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
  return await untilAnswering(name, p, current, o.timeoutMs ?? 10_000)
}
