import { chmodSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"

import * as agent from "./agent"
import { QgaChannel, QmpChannel } from "./broker"
import {
  appendEntry,
  DEFAULT_MAX_BYTES,
  type EntryFields,
  qmpFields,
  rotateEvents,
  syncFields,
} from "./eventlog"
import { hostEnd } from "./hostend"
import { buildIdentity } from "./identity"
import { leaseHolder } from "./operation"
import {
  captureOutput,
  type OpHandlers,
  OpQueue,
  type Reply,
  readOpRequest,
  reply,
} from "./ops"
import { SERVICE_HANDLERS, STOW_HANDLER } from "./opverbs"
import { PACKAGE_DIR, type Paths, pathsFor } from "./paths"
import { ownStart } from "./proc"
import * as qga from "./qga"
import { claim, keptWithin, livePidIn, recordedPid } from "./servicectl"
import * as share from "./share"
import { ChangeNotices } from "./sharewatch"
import { type WatchOptions, watchDuties } from "./watch"

export interface ServiceOptions {
  readonly exitAfterMs?: number
  readonly heartbeatMs?: number
  readonly checkMs?: number
  readonly eventsMaxBytes?: number
  readonly hostEnd?: (name: string, deadlineMs: number) => Promise<unknown>
  readonly handlers?: OpHandlers
  readonly watch?: WatchOptions
}

export interface ServiceHandle {
  readonly done: Promise<void>
  subscribers(): number
  stop(): Promise<void>
}

export const KEEPER_PID_ENV = "WINVM_KEEPER_PID"

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export interface SignalSeams {
  readonly keeperPid?: string | undefined
  readonly parent?: () => number
  readonly on?: (signal: NodeJS.Signals, handler: () => void) => void
}

export function serviceSignals(
  name: string,
  stop: () => void,
  o: SignalSeams = {},
): void {
  const keeperPid = "keeperPid" in o ? o.keeperPid : process.env[KEEPER_PID_ENV]
  const parent = o.parent ?? ((): number => process.ppid)
  const on =
    o.on ??
    ((signal: NodeJS.Signals, handler: () => void): void => {
      process.on(signal, handler)
    })
  const kept = (): boolean =>
    keeperPid !== undefined &&
    keeperPid !== "" &&
    String(parent()) === keeperPid
  for (const signal of SHUTDOWN_SIGNALS)
    on(signal, () => {
      if (!kept()) {
        stop()
        return
      }
      appendEntry(name, { kind: "service", what: "signal ignored", signal })
    })
  on("SIGUSR2", stop)
}

const coreVersion = (): string =>
  (
    JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8")) as {
      version: string
    }
  ).version

const RUN_STATE_AFTER: Readonly<Record<string, string>> = {
  STOP: "paused",
  RESUME: "running",
  SHUTDOWN: "shutdown",
  SUSPEND: "suspended",
  WAKEUP: "running",
  GUEST_PANICKED: "guest-panicked",
}

const UNKNOWN = "unknown"

export function noticeTarget(
  p: Paths,
  qemuRunning: boolean,
): { readonly root: string; readonly letter: string } | null {
  if (!qemuRunning) return null
  const serving = share.readServing(p)
  if (serving === null || serving.folder === null || serving.readonly)
    return null
  return {
    root: serving.folder,
    letter: share.readShare(p)?.letter ?? share.DEFAULT_LETTER,
  }
}

export async function runService(
  name: string,
  o: ServiceOptions = {},
): Promise<ServiceHandle> {
  const p = pathsFor(name)
  claim(p, name, {
    pid: process.pid,
    cli: process.env.WINVM_CLI ?? "",
    version: coreVersion(),
    startedAt: new Date().toISOString(),
    build: buildIdentity(),
  })
  const exitAfterMs = o.exitAfterMs ?? 10_000
  const checkMs = o.checkMs ?? 1000
  const eventsMaxBytes = o.eventsMaxBytes ?? DEFAULT_MAX_BYTES
  const enc = new TextEncoder()
  const subs = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let state = UNKNOWN

  const send = (
    c: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): void => {
    try {
      c.enqueue(enc.encode(text))
    } catch {
      subs.delete(c)
    }
  }
  const record = (fields: EntryFields): void => {
    const line = appendEntry(name, fields)
    if (line === null) return
    for (const c of subs) send(c, `data: ${line}\n\n`)
  }
  const rotate = (): void => {
    rotateEvents(name, eventsMaxBytes, () => leaseHolder(name) === null)
  }
  const nudge = (): void => {
    for (const c of subs) send(c, ": op\n\n")
  }
  captureOutput()
  const queue = new OpQueue(name, o.handlers ?? SERVICE_HANDLERS, {
    record,
    nudge,
    killed: () => {
      void stop()
    },
  })

  const duties = watchDuties(
    name,
    {
      perform: async (op, handler, args) =>
        await queue.perform(op, handler, args),
      stow: STOW_HANDLER,
    },
    o.watch,
  )

  const qmpChannel = new QmpChannel({
    listen: p.qmp,
    upstream: p.qmpQemu,
    onEvent: (e) => {
      const fields = qmpFields(e)
      state = RUN_STATE_AFTER[fields.event] ?? state
      record(fields)
    },
    onSync: (reply) => {
      const fields = syncFields(reply)
      state = fields.status ?? UNKNOWN
      record(fields)
    },
    onLost: (reason) => {
      state = UNKNOWN
      record({ kind: "disconnected", reason })
    },
  })
  const askPortOpen = async (): Promise<boolean | null> => {
    try {
      const r = (await qmpChannel.request("query-chardev", undefined, 2000))
        .return as
        | { readonly label: string; readonly "frontend-open": boolean }[]
        | undefined
      return r?.find((c) => c.label === qga.CHARDEV)?.["frontend-open"] ?? null
    } catch {
      return null
    }
  }
  const qgaChannel = new QgaChannel({
    listen: p.qga,
    upstream: p.qgaQemu,
    portOpen: askPortOpen,
  })
  let hostEnding: Promise<unknown> | null = null
  let stopping = false
  const beginHostEnd = async (req: Request): Promise<Response> => {
    let body: unknown = null
    try {
      body = await req.json()
    } catch {}
    const deadlineMs =
      typeof body === "object" && body !== null
        ? (body as { deadlineMs?: unknown }).deadlineMs
        : undefined
    if (typeof deadlineMs !== "number")
      return new Response("deadlineMs is required", { status: 400 })
    if (hostEnding !== null)
      return new Response("already ending", { status: 409 })
    const endHost = o.hostEnd ?? hostEnd
    void duties.halt("the Mac is shutting down")
    hostEnding = (async (): Promise<unknown> => {
      await queue.close("host-end")
      return await endHost(name, deadlineMs)
    })().catch((error: unknown) => {
      record({
        kind: "warning",
        what: "host-end",
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return new Response(null, { status: 202 })
  }
  const answer = (r: Reply): Response =>
    Response.json(r.body, { status: r.status })
  const submitOp = async (req: Request): Promise<Response> => {
    if (hostEnding !== null)
      return answer(
        reply(503, { error: "the Mac is shutting down", hostEnding: true }),
      )
    if (stopping)
      return answer(reply(503, { error: "the service is stopping" }))
    const parsed = readOpRequest(
      await req.json().catch(() => null),
      o.handlers ?? SERVICE_HANDLERS,
    )
    if ("status" in parsed) return answer(parsed)
    const s = await queue.submit(parsed)
    if (s.kind === "busy") return answer(reply(409, { busy: s.holder }))
    if (s.kind === "failed") return answer(reply(503, { error: s.error }))
    if (s.kind === "closed")
      return answer(
        reply(
          503,
          s.reason === "host-end"
            ? { error: "the Mac is shutting down", hostEnding: true }
            : { error: "the service is stopping" },
        ),
      )
    return answer(
      reply(202, {
        id: s.id,
        cursor: s.cursor,
        pid: process.pid,
        pidStart: ownStart(),
        queued: s.queued,
      }),
    )
  }
  const cancelOp = async (req: Request): Promise<Response> => {
    const body: unknown = await req.json().catch(() => null)
    const id =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { id?: unknown }).id === "string"
        ? (body as { id: string }).id
        : null
    const c = queue.cancel(id)
    if (c.kind === "none") return answer(reply(404, { none: true }))
    if (c.kind === "unknown") return answer(reply(404, { unknown: c.id }))
    const { kind, ...what } = c
    return answer(reply(kind === "cancelled" ? 200 : 409, { [kind]: what }))
  }
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (url.pathname === "/host-ending" && req.method === "POST")
      return await beginHostEnd(req)
    if (url.pathname === "/ops" && req.method === "POST")
      return await submitOp(req)
    if (url.pathname === "/ops/cancel" && req.method === "POST")
      return await cancelOp(req)
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
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        },
      })
    }
    if (url.pathname === "/status") {
      return Response.json({
        state,
        qemuPid: livePidIn(p.pid),
        connected: qmpChannel.connected,
        hostEnding: hostEnding !== null,
      })
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
    server = Bun.serve({
      unix: p.control,
      fetch: handle,
      idleTimeout: 0,
    } as unknown as Parameters<typeof Bun.serve>[0])
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

  rotate()
  record({ kind: "service", what: "started" })

  let finish: () => void = () => undefined
  const done = new Promise<void>((r) => {
    finish = r
  })
  let goneMs = 0
  let qemuGoneMs = 0

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
            if (process.env.WINVM_SHARE_DEBUG)
              record({
                ...r,
                kind: "service",
                what: "share notices sent",
                paths,
              })
          } catch (error) {
            if (process.env.WINVM_SHARE_DEBUG)
              record({
                kind: "warning",
                what: "share notices",
                error: String(error),
              })
            client = null
            throw error
          }
        },
      })
      n.start()
      notices = { key, n }
      record({
        kind: "service",
        what: "share notices",
        root: want.root,
        letter: want.letter,
      })
    } catch (error) {
      record({
        kind: "warning",
        what: "share notices",
        error: error instanceof Error ? error.message : String(error),
      })
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
    rotate()
    duties.check()
    qemuGoneMs = livePidIn(p.pid) === null ? qemuGoneMs + checkMs : 0
    if (qemuGoneMs >= exitAfterMs) queue.endQueued()
    if (
      livePidIn(p.pid) !== null ||
      !queue.idle() ||
      leaseHolder(name) !== null ||
      keptWithin(p, exitAfterMs)
    ) {
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
    if (hostEnding !== null) await hostEnding
    await duties.halt("winvm's service stopped")
    await queue.close("stopping")
    clearInterval(check)
    clearInterval(heartbeat)
    for (const c of subs) {
      try {
        c.close()
      } catch {}
    }
    subs.clear()
    if (notices !== null) await notices.n.stop()
    notices = null
    void server.stop(true)
    await qmpChannel.stop()
    await qgaChannel.stop()
    release()
    record({ kind: "service", what: "stopped" })
    finish()
  }

  return { done, subscribers: () => subs.size, stop }
}
