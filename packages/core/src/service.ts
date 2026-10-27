import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

import { QgaChannel, QmpChannel } from "./broker"
import { PACKAGE_DIR, cliEntry, home, pathsFor, type Paths } from "./paths"
import * as qga from "./qga"

export interface ServiceInfo {
  readonly pid: number
  readonly port: number
  readonly token: string
  readonly cli: string
  readonly version: string
  readonly startedAt: string
}

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

function isServiceFor(pid: number, name: string): boolean {
  if (pid === process.pid) return true
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  return (r.stdout ?? "").includes(` serve -i ${name}`)
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

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${String(process.pid)}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

export function stopService(p: Paths): void {
  const info = readService(p)
  if (info === null) return
  try {
    process.kill(info.pid, "SIGTERM")
  } catch {
    return
  }
  const running = (): boolean => alive(info.pid) && !exited(info.pid)
  const deadline = Date.now() + 5000
  while (running() && Date.now() < deadline) Bun.sleepSync(50)
  if (running()) process.kill(info.pid, "SIGKILL")
  rmSync(p.service, { force: true })
}

function exited(pid: number): boolean {
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  const stat = (r.stdout ?? "").trim()
  return stat === "" || stat.startsWith("Z")
}

export async function ensureService(name: string, p: Paths): Promise<ServiceInfo> {
  const cli = cliEntry()
  const running = readService(p)
  if (running !== null && running.cli === cli) {
    keepService(p)
    return running
  }
  if (running !== null) stopService(p)
  rmSync(p.service, { force: true })
  keepService(p)
  const log = openSync(resolve(p.dir, "service.log"), "a")
  const child = spawn(process.execPath, [cli, "serve", "-i", name], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, WINVM_SERVICE_TOKEN: randomBytes(24).toString("base64url") },
  })
  closeSync(log)
  child.unref()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const info = readService(p)
    if (info !== null && info.cli === cli && existsSync(p.qmp) && existsSync(p.qga)) return info
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`the control service for "${name}" did not start; see ${resolve(p.dir, "service.log")}`)
}

const coreVersion = (): string =>
  (JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }).version

const STATES: Readonly<Record<string, string>> = { STOP: "paused", RESUME: "running", SHUTDOWN: "stopped", RESET: "reset" }

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
  const token = process.env["WINVM_SERVICE_TOKEN"] ?? randomBytes(24).toString("base64url")
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

  let portOpen: boolean | null = null
  const qmpChannel = new QmpChannel({
    listen: p.qmp,
    upstream: p.qmpQemu,
    onConnect: () => {
      portOpen = null
    },
    onEvent: (e) => {
      if (e["event"] === "RESET" || e["event"] === "SHUTDOWN" || e["event"] === "VSERPORT_CHANGE") portOpen = null
      const s = stateEvent(e)
      if (s === null) return
      state = String(s["state"])
      record("state", s)
    },
  })
  const askPortOpen = async (): Promise<boolean | null> => {
    if (portOpen === true) return true
    try {
      const r = (await qmpChannel.request("query-chardev", undefined, 2000))["return"] as
        | { readonly label: string; readonly "frontend-open": boolean }[]
        | undefined
      portOpen = r?.find((c) => c.label === qga.CHARDEV)?.["frontend-open"] ?? null
    } catch {
      portOpen = null
    }
    return portOpen
  }
  const qgaChannel = new QgaChannel({
    listen: p.qga,
    upstream: p.qgaQemu,
    portOpen: askPortOpen,
    onRefused: () => {
      portOpen = null
    },
  })
  await qmpChannel.start()
  await qgaChannel.start()

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.searchParams.get("key") !== token && req.headers.get("x-winvm-token") !== token) {
        return new Response("unauthorized", { status: 401 })
      }
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
    },
  })
  const heartbeat = setInterval(() => {
    for (const c of subs) send(c, ": heartbeat\n\n")
  }, o.heartbeatMs ?? 15_000)

  const info: ServiceInfo = {
    pid: process.pid,
    port: server.port ?? 0,
    token,
    cli: process.env["WINVM_CLI"] ?? "",
    version: coreVersion(),
    startedAt: new Date().toISOString(),
  }
  writeAtomic(p.service, `${JSON.stringify(info, null, 2)}\n`)
  record("service", { what: "started" })

  let finish: () => void = () => undefined
  const done = new Promise<void>((r) => {
    finish = r
  })
  let stopping = false
  let goneMs = 0
  const lock = resolve(home(), "saves", name, ".lock")
  const check = setInterval(() => {
    if (recordedPid(p) !== process.pid) {
      void stop()
      return
    }
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
    void server.stop(true)
    await qmpChannel.stop()
    await qgaChannel.stop()
    if (recordedPid(p) === process.pid) rmSync(p.service, { force: true })
    record("service", { what: "stopped" })
    finish()
  }

  return { done, subscribers: () => subs.size, stop }
}
