import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, chmodSync, closeSync, linkSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

import { commandInstance } from "./args"
import { QgaChannel, QmpChannel } from "./broker"
import { buildIdentity } from "./identity"
import { PACKAGE_DIR, cliArgv, cliEntry, home, managedEnv, pathsFor, type Paths } from "./paths"
import * as qga from "./qga"
import * as share from "./share"
import type { ChangeNotices } from "./sharewatch"

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

export interface WinvmEvent {
  readonly t: string
  readonly instance: string
  readonly kind: "state" | "warning" | "service"
  readonly [field: string]: unknown
}

export interface ServiceOptions {
  readonly exitAfterMs?: number
  readonly heartbeatMs?: number
  readonly checkMs?: number
}

export interface ServiceHandle {
  readonly done: Promise<void>
  subscribers(): number
  stop(): Promise<void>
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function livePidIn(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10)
    return Number.isFinite(pid) && alive(pid) ? pid : null
  } catch {
    return null
  }
}

function recordedPid(p: Paths): number | null {
  try {
    const pid = (JSON.parse(readFileSync(p.service, "utf8")) as { pid?: unknown }).pid
    return typeof pid === "number" ? pid : null
  } catch {
    return null
  }
}

/**
 * Whether the pid is `name`'s service: its command line is a `serve` for exactly
 * that instance. A `serve` naming no instance is "default"'s (WINVM_INSTANCE
 * cannot be seen from here; winvm always spawns it with `-i`).
 */
function isServiceFor(pid: number, name: string): boolean {
  if (pid === process.pid) return true
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  const m = /(?:^|\s)serve(\s.*)?$/.exec((r.stdout ?? "").trim())
  return m !== null && (commandInstance(m[1] ?? "") ?? "default") === name
}

export function readService(p: Paths): ServiceInfo | null {
  try {
    const s = JSON.parse(readFileSync(p.service, "utf8")) as ServiceInfo
    return typeof s.pid === "number" && alive(s.pid) && isServiceFor(s.pid, basename(p.dir)) ? s : null
  } catch {
    return null
  }
}

const keepPath = (p: Paths): string => resolve(p.dir, "service.keep")

export function keepService(p: Paths): void {
  writeFileSync(keepPath(p), `${new Date().toISOString()}\n`)
}

function keptWithin(p: Paths, ms: number): boolean {
  try {
    return Date.now() - statSync(keepPath(p)).mtimeMs < ms
  } catch {
    return false
  }
}

function claim(p: Paths, name: string, info: ServiceInfo): void {
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
      const holder = readService(p)
      if (holder !== null) throw new Error(`another winvm service (pid ${String(holder.pid)}) holds instance "${name}"`)
      rmSync(p.service, { force: true })
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
  const sleep = seams.sleep ?? ((ms: number): void => Bun.sleepSync(ms))
  const running = seams.running ?? ((pid: number): boolean => alive(pid) && !exited(pid))
  const isService = seams.isService ?? ((pid: number): boolean => alive(pid) && isServiceFor(pid, name))
  // Only a pid the record names AND that is still this instance's service is ever signalled.
  const pid = recordedPid(p)
  if (pid === null || !isService(pid)) return
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
  rmSync(p.service, { force: true })
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
  const cli = cliEntry()
  const current = o.current ?? buildIdentity()
  const running = readService(p)
  if (running !== null && running.cli === cli && serviceFreshness(running, current) === "current") {
    keepService(p)
    return running
  }
  // readService vouches for the pid (alive, and a service for this instance), so a
  // stop signals only a real service. A record it rejects names a gone process or a
  // reused pid: drop the file and signal nobody.
  if (running !== null) stopService(p)
  else rmSync(p.service, { force: true })
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
    if (info !== null && info.cli === cli && serviceFreshness(info, current) === "current" && (await answers(p.control))) return info
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`the control service for "${name}" did not start; see ${resolve(p.dir, "service.log")}`)
}

const coreVersion = (): string =>
  (JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }).version

const STATES: Readonly<Record<string, string>> = { STOP: "paused", RESUME: "running", SHUTDOWN: "stopped", RESET: "reset" }

/**
 * What the shared folder's change notices (sharewatch.ts) should watch now: the
 * folder the running daemon serves, and the drive it is in Windows. null while
 * no QEMU runs, nothing is shared, or the share is read-only (the guest cannot
 * touch anything there).
 */
export function noticeTarget(p: Paths, qemuRunning: boolean): { readonly root: string; readonly letter: string } | null {
  if (!qemuRunning) return null
  const serving = share.readServing(p)
  if (serving === null || serving.folder === null || serving.readonly) return null
  return { root: serving.folder, letter: share.readShare(p)?.letter ?? share.DEFAULT_LETTER }
}

export function stateEvent(e: Record<string, unknown>): Record<string, unknown> | null {
  const name = String(e["event"])
  const data = e["data"] as Record<string, unknown> | undefined
  const state = STATES[name]
  if (state !== undefined) return data === undefined ? { state } : { state, data }
  if (name === "MIGRATION") return { state: "migration", status: (data as { status?: string } | undefined)?.status }
  return null
}

export async function runService(name: string, o: ServiceOptions = {}): Promise<ServiceHandle> {
  const p = pathsFor(name)
  claim(p, name, {
    pid: process.pid,
    cli: process.env["WINVM_CLI"] ?? "",
    version: coreVersion(),
    startedAt: new Date().toISOString(),
    build: buildIdentity(),
  })
  const exitAfterMs = o.exitAfterMs ?? 10_000
  const checkMs = o.checkMs ?? 1000
  const enc = new TextEncoder()
  const subs = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let state = "unknown"

  const send = (c: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
    try {
      c.enqueue(enc.encode(text))
    } catch {
      subs.delete(c)
    }
  }
  const record = (kind: WinvmEvent["kind"], fields: Record<string, unknown>): void => {
    const event: WinvmEvent = { t: new Date().toISOString(), instance: name, kind, ...fields }
    const line = JSON.stringify(event)
    try {
      appendFileSync(p.events, `${line}\n`)
    } catch {
      return
    }
    for (const c of subs) send(c, `data: ${line}\n\n`)
  }

  const qmpChannel = new QmpChannel({
    listen: p.qmp,
    upstream: p.qmpQemu,
    onEvent: (e) => {
      const s = stateEvent(e)
      if (s === null) return
      state = String(s["state"])
      record("state", s)
    },
  })
  const askPortOpen = async (): Promise<boolean | null> => {
    try {
      const r = (await qmpChannel.request("query-chardev", undefined, 2000))["return"] as
        | { readonly label: string; readonly "frontend-open": boolean }[]
        | undefined
      return r?.find((c) => c.label === qga.CHARDEV)?.["frontend-open"] ?? null
    } catch {
      return null
    }
  }
  const qgaChannel = new QgaChannel({ listen: p.qga, upstream: p.qgaQemu, portOpen: askPortOpen })
  const handle = (req: Request): Response => {
    const url = new URL(req.url)
    if (url.pathname === "/events") {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
          subs.add(c)
          send(c, ": connected\n\n")
        },
        cancel() {
          if (controller !== undefined) subs.delete(controller)
        },
      })
      req.signal.addEventListener("abort", () => {
        if (controller !== undefined) subs.delete(controller)
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
    }
    if (url.pathname === "/status") {
      return Response.json({ state, qemuPid: livePidIn(p.pid), connected: qmpChannel.connected })
    }
    return new Response("not found", { status: 404 })
  }

  const owned = (): boolean => recordedPid(p) === process.pid
  const release = (): void => {
    if (!owned()) return
    rmSync(p.control, { force: true })
    rmSync(p.service, { force: true })
  }
  let server: ReturnType<typeof Bun.serve>
  try {
    await qmpChannel.start()
    await qgaChannel.start()
    rmSync(p.control, { force: true })
    server = Bun.serve({ unix: p.control, fetch: handle, idleTimeout: 0 } as unknown as Parameters<typeof Bun.serve>[0])
    chmodSync(p.control, 0o600)
  } catch (e) {
    await qmpChannel.stop()
    await qgaChannel.stop()
    release()
    throw e
  }
  const heartbeat = setInterval(() => {
    for (const c of subs) send(c, ": heartbeat\n\n")
  }, o.heartbeatMs ?? 15_000)

  record("service", { what: "started" })

  let finish: () => void = () => undefined
  const done = new Promise<void>((r) => {
    finish = r
  })
  let stopping = false
  let goneMs = 0
  const lock = resolve(home(), "saves", name, ".lock")

  // The shared folder's change notices, for as long as a guest with one runs.
  // Imported on first use: they need the agent's client, which needs qemu.ts.
  let notices: { readonly key: string; readonly n: ChangeNotices } | null = null
  let syncing = false
  const syncNotices = async (): Promise<void> => {
    if (syncing) return
    syncing = true
    try {
      const want = stopping ? null : noticeTarget(p, livePidIn(p.pid) !== null)
      const key = want === null ? "" : `${want.root}|${want.letter}`
      if (notices?.key === key) return
      if (notices !== null) await notices.n.stop()
      notices = null
      if (want === null) return
      const [{ ChangeNotices }, agent] = await Promise.all([import("./sharewatch"), import("./agent")])
      let client: Awaited<ReturnType<typeof agent.connect>> = null
      const n = new ChangeNotices({
        root: want.root,
        send: async (paths) => {
          client ??= await agent.connect(name, { timeoutMs: 1000 })
          if (client === null) return
          try {
            const r = await client.touch(`${want.letter}:\\`, paths)
            if (process.env["WINVM_SHARE_DEBUG"]) record("service", { what: "share notices sent", paths, ...r })
          } catch (error) {
            if (process.env["WINVM_SHARE_DEBUG"]) record("warning", { what: "share notices", error: String(error) })
            client = null
            throw error
          }
        },
      })
      n.start()
      notices = { key, n }
      record("service", { what: "share notices", root: want.root, letter: want.letter })
    } catch (error) {
      record("warning", { what: "share notices", error: error instanceof Error ? error.message : String(error) })
    } finally {
      syncing = false
    }
  }
  void syncNotices()

  const check = setInterval(() => {
    if (!owned()) {
      void stop()
      return
    }
    void syncNotices()
    if (livePidIn(p.pid) !== null || livePidIn(lock) !== null || keptWithin(p, exitAfterMs)) {
      goneMs = 0
      return
    }
    goneMs += checkMs
    if (goneMs >= exitAfterMs) void stop()
  }, checkMs)

  async function stop(): Promise<void> {
    if (stopping) return await done
    stopping = true
    clearInterval(check)
    clearInterval(heartbeat)
    for (const c of subs) {
      try {
        c.close()
      } catch {
        // already closed
      }
    }
    subs.clear()
    if (notices !== null) await notices.n.stop()
    notices = null
    void server.stop(true)
    await qmpChannel.stop()
    await qgaChannel.stop()
    release()
    record("service", { what: "stopped" })
    finish()
  }

  return { done, subscribers: () => subs.size, stop }
}
