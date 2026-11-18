import type { Args } from "./args"
import { instanceName } from "./args"
import { type Cursor, type Entry, type OpEntry, waitForEvent } from "./eventlog"
import * as finder from "./finder"
import { cursorOf } from "./follow"
import { frozenState } from "./frozen"
import {
  INTERRUPTED,
  InstanceBusy,
  type LeaseHolder,
  withOperation,
} from "./operation"
import { OPS_PROTOCOL, type ServiceOp } from "./ops"
import { pathsFor } from "./paths"
import { isSameProcess } from "./proc"

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export interface Accepted {
  readonly id: string
  readonly cursor: Cursor
  readonly servicePid: number
  readonly serviceStart: string | null
  readonly queued: boolean
}

type Sent =
  | ({ readonly kind: "accepted" } & Accepted)
  | { readonly kind: "busy"; readonly holder: LeaseHolder }
  | { readonly kind: "unavailable" }
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "unanswered"; readonly why: string }

const NOT_RECEIVED: ReadonlySet<string> = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ENOTSOCK",
  "ENOTDIR",
  "EACCES",
])

const SEND_TIMEOUT_MS = 5000
const LIVENESS_MS = 2000

function holderOf(v: unknown): LeaseHolder | null {
  if (!isObject(v)) return null
  const { operation, pid, startedAt, automatic } = v
  if (
    typeof operation !== "string" ||
    typeof pid !== "number" ||
    typeof startedAt !== "string" ||
    typeof automatic !== "boolean"
  )
    return null
  return { operation, pid, startedAt, automatic }
}

function acceptedOf(v: Json): Accepted | null {
  const cursor = cursorOf(v.cursor)
  const pidStart = typeof v.pidStart === "string" ? v.pidStart : null
  if (
    typeof v.id !== "string" ||
    typeof v.pid !== "number" ||
    !Number.isInteger(v.pid) ||
    v.pid <= 1 ||
    cursor === null
  )
    return null
  return {
    id: v.id,
    cursor,
    servicePid: v.pid,
    serviceStart: pidStart,
    queued: holderOf(v.queued) !== null,
  }
}

const why = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function post(
  name: string,
  path: string,
  body: Json,
): Promise<{ readonly status: number; readonly body: Json | null }> {
  const res = await fetch(`http://localhost${path}`, {
    unix: pathsFor(name).control,
    method: "POST",
    body: JSON.stringify({ protocol: OPS_PROTOCOL, ...body }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
  const parsed: unknown = await res.json().catch(() => null)
  return {
    status: res.status,
    body: isObject(parsed) && parsed.protocol === OPS_PROTOCOL ? parsed : null,
  }
}

async function send(name: string, body: Json): Promise<Sent> {
  let r: Awaited<ReturnType<typeof post>>
  try {
    r = await post(name, "/ops", body)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && NOT_RECEIVED.has(code))
      return { kind: "unavailable" }
    return { kind: "unanswered", why: why(error) }
  }
  if (r.status === 202 && r.body !== null) {
    const a = acceptedOf(r.body)
    if (a !== null) return { kind: "accepted", ...a }
  }
  if (r.status === 503 && r.body?.hostEnding === true)
    return { kind: "refused", why: "the Mac is shutting down" }
  const holder = r.status === 409 ? holderOf(r.body?.busy) : null
  if (holder !== null) return { kind: "busy", holder }
  if ([400, 404, 501, 503].includes(r.status)) return { kind: "unavailable" }
  return { kind: "unanswered", why: `HTTP ${String(r.status)}` }
}

export interface Io {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  readonly remount: (name: string) => Promise<void>
}

const ofOp =
  (id: string) =>
  (e: Entry): e is Extract<Entry, { kind: "op" }> =>
    e.kind === "op" && e.id === id && e.phase !== "begin"

export async function followOp(
  name: string,
  operation: string,
  a: Accepted,
  io: Io,
  signal: AbortSignal,
): Promise<number> {
  let since = a.cursor
  let gone = false
  let remounted = false
  const remount = async (): Promise<void> => {
    if (remounted) return
    remounted = true
    await io.remount(name)
  }
  for (;;) {
    const found = await waitForEvent(
      name,
      ofOp(a.id),
      gone ? Date.now() : Date.now() + LIVENESS_MS,
      { since, signal, pollMs: 100 },
    )
    if (found === null && gone) {
      io.err(
        `::error::winvm's service for "${name}" ended before ${operation} finished; \`winvm events -i ${name}\` shows how far it got\n`,
      )
      return 1
    }
    if (found === null) {
      gone = !isSameProcess(a.servicePid, a.serviceStart)
      continue
    }
    since = found.cursor
    const e = found.entry
    if (e.phase === "output") {
      ;(e.stream === "out" ? io.out : io.err)(e.text)
      continue
    }
    if (e.phase === "remount") {
      await remount()
      continue
    }
    if (
      e.phase === "end" &&
      e.remount === true &&
      e.error !== "host-end" &&
      e.error !== "killed"
    )
      await remount()
    return ended(operation, e, io)
  }
}

function ended(operation: string, e: OpEntry, io: Io): number {
  if (e.phase !== "end") return 1
  if (e.exitCode !== undefined) return e.exitCode
  io.err(
    e.error === "killed"
      ? `::error::${operation} was ended by \`winvm kill\` while it ran\n`
      : e.error === "host-end"
        ? `::error::${operation} was ended because the Mac is shutting down\n`
        : `error: ${e.error ?? "it failed"}\n`,
  )
  return 1
}

const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

export interface OpCall {
  readonly op: ServiceOp
  readonly args: Args
  readonly argv: readonly string[]
}

const stdio: Io = {
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
  remount: async (name) => {
    await remountHeld(name)
  },
}

const REMOUNT_WAIT_MS = 10_000

async function hostEnding(name: string): Promise<boolean> {
  try {
    const res = await fetch("http://localhost/status", {
      unix: pathsFor(name).control,
      signal: AbortSignal.timeout(2000),
    })
    const body: unknown = await res.json()
    return isObject(body) && body.hostEnding === true
  } catch {
    return false
  }
}

export async function remountHeld(
  name: string,
  mount: (name: string) => Promise<void> = finder.afterUp,
): Promise<void> {
  try {
    await withOperation(
      name,
      "remount",
      async () => {
        if (await hostEnding(name)) return
        if ((await frozenState(pathsFor(name))) !== null) return
        await mount(name)
      },
      {
        automatic: true,
        queue: true,
        waitMs: REMOUNT_WAIT_MS,
        onWait: () => undefined,
      },
    )
  } catch (error) {
    if (!(error instanceof InstanceBusy)) throw error
  }
}

export async function runOp(
  call: OpCall,
  here: () => Promise<number>,
  io: Io = stdio,
): Promise<number> {
  const name = instanceName(call.args)
  const interrupted = new AbortController()
  const handlers = INTERRUPTS.map((signal) => {
    const handler = (): void => {
      interrupted.abort(signal)
    }
    process.on(signal, handler)
    return [signal, handler] as const
  })
  const leave = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
  let accepted: Accepted | null = null
  try {
    const sent = await send(name, {
      op: call.op,
      args: [...call.argv],
      wait: call.args.flags.has("wait"),
    })
    if (interrupted.signal.aborted && sent.kind === "accepted") {
      detached(call.op, name, sent, io)
      return INTERRUPTED
    }
    if (interrupted.signal.aborted && sent.kind === "unavailable") {
      io.err(`${call.op} was not run\n`)
      return INTERRUPTED
    }
    if (interrupted.signal.aborted && sent.kind === "unanswered") {
      io.err(
        `${call.op} may have reached winvm's service; \`winvm events -i ${name}\` shows whether it began\n`,
      )
      return INTERRUPTED
    }
    switch (sent.kind) {
      case "unavailable":
        leave()
        return await here()
      case "busy":
        io.err(`::error::${new InstanceBusy(name, sent.holder).message}\n`)
        return 1
      case "refused":
        io.err(`::error::${sent.why}, so ${call.op} was not run\n`)
        return 1
      case "unanswered":
        if (call.op === "kill") {
          leave()
          return await here()
        }
        io.err(
          `::error::winvm's service for "${name}" did not answer (${sent.why}), so ${call.op} may or may not have begun; \`winvm events -i ${name}\` shows whether it did\n`,
        )
        return 1
      case "accepted":
        accepted = sent
        return await followOp(name, call.op, sent, io, interrupted.signal)
    }
  } catch (error) {
    if (!interrupted.signal.aborted || accepted === null) throw error
    detached(call.op, name, accepted, io)
    return INTERRUPTED
  } finally {
    leave()
  }
}

function detached(operation: string, name: string, a: Accepted, io: Io): void {
  io.err(
    `${operation} continues in winvm's service; follow it with \`winvm events -i ${name} --follow\`\n`,
  )
  if (a.queued)
    io.err(
      `  while it still waits for "${name}", \`winvm cancel -i ${name} --id ${a.id}\` takes it off the queue\n`,
    )
}

export async function cancelCmd(args: Args, io: Io = stdio): Promise<number> {
  const name = instanceName(args)
  const id = args.flags.get("id")
  let r: Awaited<ReturnType<typeof post>>
  try {
    r = await post(name, "/ops/cancel", id === undefined ? {} : { id })
  } catch {
    io.err(
      `::error::winvm's service for "${name}" is not running, so nothing was cancelled\n`,
    )
    return 1
  }
  const body = r.body
  if (body === null) {
    io.err(
      `::error::winvm's service for "${name}" is older than this winvm and runs no operations, so nothing was cancelled\n`,
    )
    return 1
  }
  const done = isObject(body.cancelled) ? body.cancelled : null
  if (done !== null) {
    io.out(`cancelled ${String(done.operation)} on "${name}"\n`)
    return 0
  }
  if (typeof body.unknown === "string") {
    io.err(
      `::error::winvm's service for "${name}" runs no op with id ${body.unknown}, so nothing was cancelled\n`,
    )
    return 1
  }
  const refused = isObject(body.refused) ? body.refused : null
  if (refused !== null) {
    io.err(`::error::${String(refused.reason)}\n`)
    return 1
  }
  io.err(
    `::error::nothing is running in winvm's service for "${name}", so nothing was cancelled\n`,
  )
  return 1
}
