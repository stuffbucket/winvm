import { appendFileSync, chmodSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"

import * as agent from "./agent"
import { QgaChannel, QmpChannel } from "./broker"
import { buildIdentity } from "./identity"
import { leaseHolder } from "./operation"
import { PACKAGE_DIR, pathsFor, type Paths } from "./paths"
import * as qga from "./qga"
import { claim, keptWithin, livePidIn, recordedPid } from "./servicectl"
import * as share from "./share"
import { ChangeNotices } from "./sharewatch"

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

const coreVersion = (): string =>
  (JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }).version

const STATES: Readonly<Record<string, string>> = { STOP: "paused", RESUME: "running", SHUTDOWN: "stopped", RESET: "reset" }

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
    if (livePidIn(p.pid) !== null || leaseHolder(name) !== null || keptWithin(p, exitAfterMs)) {
      goneMs = 0
      return
    }
    goneMs += checkMs
    if (goneMs >= exitAfterMs) void stop()
  }, checkMs)

  async function stop(): Promise<void> {
    if (stopping) {
      await done
      return
    }
    stopping = true
    clearInterval(check)
    clearInterval(heartbeat)
    for (const c of subs) {
      try {
        c.close()
      } catch {
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
