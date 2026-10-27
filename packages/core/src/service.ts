import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { QgaChannel, QmpChannel } from "./broker"
import { PACKAGE_DIR, home, pathsFor, type Paths } from "./paths"
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

export function readService(p: Paths): ServiceInfo | null {
  try {
    const s = JSON.parse(readFileSync(p.service, "utf8")) as ServiceInfo
    return typeof s.pid === "number" && alive(s.pid) ? s : null
  } catch {
    return null
  }
}

const coreVersion = (): string =>
  (JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }).version

const STATES: Readonly<Record<string, string>> = { STOP: "paused", RESUME: "running", SHUTDOWN: "stopped", RESET: "reset" }

export function stateEvent(e: Record<string, unknown>): Record<string, unknown> | null {
  const name = String(e["event"])
  const state = STATES[name]
  if (state !== undefined) return { state }
  if (name === "MIGRATION") return { state: "migration", status: (e["data"] as { status?: string } | undefined)?.status }
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
    appendFileSync(p.events, `${line}\n`)
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
  const qgaChannel = new QgaChannel({ listen: p.qga, upstream: p.qgaQemu, portOpen: async () => await qga.portOpen(p.qga) })
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
  writeFileSync(p.service, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
  chmodSync(p.service, 0o600)
  record("service", { what: "started" })

  let finish: () => void = () => undefined
  const done = new Promise<void>((r) => {
    finish = r
  })
  let stopping = false
  let goneMs = 0
  const lock = resolve(home(), "saves", name, ".lock")
  const check = setInterval(() => {
    if (livePidIn(p.pid) !== null || livePidIn(lock) !== null) {
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
    if (readService(p)?.pid === process.pid) rmSync(p.service, { force: true })
    record("service", { what: "stopped" })
    finish()
  }

  return { done, subscribers: () => subs.size, stop }
}
