import { randomUUID } from "node:crypto"
import { format } from "node:util"

import { type Args, parseArgs } from "./args"
import {
  appendEntry,
  type Cursor,
  type EntryFields,
  endCursor,
} from "./eventlog"
import {
  currentOp,
  OpEnded,
  type OpScope,
  type OutputStream,
  outsideOp,
  runInOp,
} from "./opcontext"
import {
  automaticFrom,
  INTERRUPTED,
  InstanceBusy,
  type LeaseHolder,
  type VmOperation,
  waitNote,
  withOperation,
} from "./operation"

export const OPS_PROTOCOL = 1

export const SERVICE_OPS = [
  "pause",
  "resume",
  "wake",
  "sleep",
  "lock",
  "reboot",
  "kill",
] as const satisfies readonly VmOperation[]

export type ServiceOp = (typeof SERVICE_OPS)[number]

export const isServiceOp = (v: unknown): v is ServiceOp =>
  typeof v === "string" && (SERVICE_OPS as readonly string[]).includes(v)

export interface OpHandler {
  readonly run: (args: Args) => Promise<number>
  readonly cancel: "never" | "before-request"
}

export type OpHandlers = Readonly<Partial<Record<ServiceOp, OpHandler>>>

export interface OpRequest {
  readonly op: ServiceOp
  readonly args: readonly string[]
  readonly wait: boolean
}

type Json = Record<string, unknown>

export interface Reply {
  readonly status: number
  readonly body: Json
}

export const reply = (status: number, body: Json): Reply => ({
  status,
  body: { protocol: OPS_PROTOCOL, ...body },
})

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export function readOpRequest(
  body: unknown,
  handlers: OpHandlers,
): OpRequest | Reply {
  if (!isObject(body)) return reply(400, { error: "the body is not an op" })
  if (body.protocol !== OPS_PROTOCOL)
    return reply(400, {
      error: `this service speaks op protocol ${String(OPS_PROTOCOL)}`,
    })
  const op = body.op
  if (!isServiceOp(op) || handlers[op] === undefined)
    return reply(501, {
      error: `this service does not run ${String(op)}`,
      ops: SERVICE_OPS.filter((o) => handlers[o] !== undefined),
    })
  const args = body.args
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string"))
    return reply(400, { error: "args must be a list of words" })
  return { op, args, wait: body.wait === true }
}

const CHUNK = 1024
const KILLED = "killed"
const CANCELLED = "cancelled"
const HOST_END = "host-end"
const STOPPING = "stopping"
export const HOST_END_GRACE_MS = 5000

export type Closing = typeof HOST_END | typeof STOPPING

const DID_NOT_RUN: Readonly<Record<string, string>> = {
  [KILLED]: "winvm kill ended QEMU",
  [HOST_END]: "the Mac is shutting down",
  [STOPPING]: "winvm's service stopped",
}

interface Running {
  readonly scope: OpScope
  readonly controller: AbortController
  readonly cancel: OpHandler["cancel"]
  readonly startedAt: string
  held: boolean
  ended: Promise<void>
}

export type Cancelled =
  | {
      readonly kind: "cancelled"
      readonly id: string
      readonly operation: string
    }
  | {
      readonly kind: "refused"
      readonly id: string
      readonly operation: string
      readonly reason: string
    }
  | { readonly kind: "none" }

const decoders = new WeakMap<OpScope, Record<OutputStream, TextDecoder>>()

function textOf(op: OpScope, stream: OutputStream, chunk: unknown): string {
  if (typeof chunk === "string") return chunk
  if (!(chunk instanceof Uint8Array)) return String(chunk)
  let own = decoders.get(op)
  if (own === undefined) {
    own = { out: new TextDecoder(), err: new TextDecoder() }
    decoders.set(op, own)
  }
  return own[stream].decode(chunk, { stream: true })
}

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff

let captured = false

type Write = (chunk: unknown, ...rest: unknown[]) => boolean

function routeWrites(target: NodeJS.WriteStream, stream: OutputStream): void {
  const original = target.write.bind(target) as Write
  const routed: Write = (chunk, ...rest) => {
    const op = currentOp()
    if (op === null) return original(chunk, ...rest)
    const text = textOf(op, stream, chunk)
    if (text !== "") op.write(stream, text)
    const done = rest.find((r) => typeof r === "function")
    if (typeof done === "function")
      queueMicrotask(() => {
        ;(done as () => void)()
      })
    return true
  }
  target.write = routed
}

type ConsoleMethod = "log" | "info" | "debug" | "warn" | "error"

function routeConsole(method: ConsoleMethod, stream: OutputStream): void {
  const original = console[method].bind(console)
  console[method] = (...data: unknown[]): void => {
    const op = currentOp()
    if (op === null) original(...data)
    else op.write(stream, `${format(...data)}\n`)
  }
}

function toServiceLog(stream: OutputStream, text: string): void {
  outsideOp(() => {
    ;(stream === "out" ? process.stdout : process.stderr).write(text)
  })
}

export function captureOutput(): void {
  if (captured) return
  captured = true
  routeConsole("log", "out")
  routeConsole("info", "out")
  routeConsole("debug", "out")
  routeConsole("warn", "err")
  routeConsole("error", "err")
  routeWrites(process.stdout, "out")
  routeWrites(process.stderr, "err")
}

export type Submitted =
  | {
      readonly kind: "accepted"
      readonly id: string
      readonly cursor: Cursor
      readonly queued: LeaseHolder | null
    }
  | { readonly kind: "busy"; readonly holder: LeaseHolder }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "closed"; readonly reason: Closing }

function atSafePoint(scope: OpScope, then: () => void): void {
  const by = Date.now() + HOST_END_GRACE_MS
  const look = (): void => {
    if (scope.calls === 0 || Date.now() >= by) then()
    else setTimeout(look, 20)
  }
  look()
}

export interface QueueHooks {
  readonly record: (fields: EntryFields) => void
  readonly nudge: () => void
  readonly killed: () => void
}

export class OpQueue {
  private readonly ops = new Map<string, Running>()
  private readonly name: string
  private readonly handlers: OpHandlers
  private readonly hooks: QueueHooks
  private closed: Closing | null = null

  constructor(name: string, handlers: OpHandlers, hooks: QueueHooks) {
    this.name = name
    this.handlers = handlers
    this.hooks = hooks
  }

  idle(): boolean {
    return this.ops.size === 0
  }

  async drain(): Promise<void> {
    while (this.ops.size > 0)
      await Promise.all([...this.ops.values()].map((r) => r.ended))
  }

  async close(reason: Closing): Promise<void> {
    this.closed ??= reason
    for (const r of this.ops.values())
      if (r.scope.operation !== "kill" && (reason === HOST_END || !r.held))
        r.controller.abort(reason)
    await this.drain()
  }

  async submit(req: OpRequest): Promise<Submitted> {
    if (this.closed !== null) return { kind: "closed", reason: this.closed }
    const handler = this.handlers[req.op]
    if (handler === undefined) throw new Error(`no handler for ${req.op}`)
    const id = randomUUID()
    const cursor = endCursor(this.name)
    const controller = new AbortController()
    let owesRemount = false
    let over = false
    const scope: OpScope = {
      id,
      operation: req.op,
      signal: controller.signal,
      write: (stream, text) => {
        if (controller.signal.aborted || over) toServiceLog(stream, text)
        else this.output(id, req.op, stream, text)
      },
      remount: () => {
        if (owesRemount) return
        owesRemount = true
        this.hooks.record({
          kind: "op",
          phase: "remount",
          id,
          operation: req.op,
        })
      },
      irreversibleAt: null,
      calls: 0,
    }
    const running: Running = {
      scope,
      controller,
      cancel: handler.cancel,
      startedAt: new Date().toISOString(),
      held: false,
      ended: Promise.resolve(),
    }
    let decide: (s: Submitted) => void = () => undefined
    const decided = new Promise<Submitted>((r) => {
      decide = r
    })
    let accepted = false
    const accept = (queued: LeaseHolder | null): void => {
      if (accepted) return
      accepted = true
      this.ops.set(id, running)
      decide({ kind: "accepted", id, cursor, queued })
    }
    const args = parseArgs([...req.args, "--instance", this.name])
    let killedQemu = false
    running.ended = runInOp(scope, async () => {
      try {
        await withOperation(
          this.name,
          req.op,
          async () => {
            running.held = true
            accept(null)
            this.hooks.nudge()
            const code = await this.raced(scope, handler.run(args))
            if (req.op === "kill" && code === 0) {
              killedQemu = true
              this.preempt(id)
            }
            return code
          },
          {
            id,
            outcome: (code: number) => ({
              ok: code === 0,
              exitCode: code,
              ...(owesRemount ? { remount: true as const } : {}),
            }),
            automatic: automaticFrom(args),
            queue: req.wait,
            signal: controller.signal,
            onWait: (holder) => {
              accept(holder)
              console.error(waitNote(this.name, holder))
            },
          },
        )
      } catch (error) {
        if (!accepted) {
          decide(
            error instanceof InstanceBusy
              ? { kind: "busy", holder: error.holder }
              : {
                  kind: "failed",
                  error: error instanceof Error ? error.message : String(error),
                },
          )
          return
        }
        if (!running.held) this.endUnheld(running, args, error)
      } finally {
        over = true
        this.ops.delete(id)
        this.hooks.nudge()
      }
      if (killedQemu)
        outsideOp(() => {
          this.hooks.killed()
        })
    })
    return await decided
  }

  cancel(id: string | null): Cancelled {
    const all = [...this.ops.values()].filter(
      (r) => r.scope.operation !== "kill",
    )
    const target =
      id === null ? (all.find((r) => r.held) ?? all[0]) : this.ops.get(id)
    if (target === undefined) return { kind: "none" }
    const { scope } = target
    const named = { id: scope.id, operation: scope.operation }
    if (!target.held || target.scope.signal.aborted) {
      target.controller.abort(CANCELLED)
      return { kind: "cancelled", ...named }
    }
    if (target.cancel === "never")
      return {
        kind: "refused",
        ...named,
        reason: `${scope.operation} can't be cancelled once it has begun; it ends on its own`,
      }
    if (scope.irreversibleAt !== null)
      return {
        kind: "refused",
        ...named,
        reason: `${scope.operation} is past its point of no return (since ${scope.irreversibleAt}), so it was not cancelled`,
      }
    target.controller.abort(CANCELLED)
    return { kind: "cancelled", ...named }
  }

  private preempt(killer: string): void {
    for (const [id, r] of this.ops)
      if (id !== killer && r.scope.operation !== "kill")
        r.controller.abort(KILLED)
  }

  private async raced(scope: OpScope, work: Promise<number>): Promise<number> {
    work.catch(() => undefined)
    return await new Promise<number>((resolve, reject) => {
      const stop = (): void => {
        if (scope.signal.reason === KILLED) {
          reject(new Error(KILLED))
          return
        }
        if (scope.signal.reason === HOST_END) {
          atSafePoint(scope, () => {
            reject(new Error(HOST_END))
          })
          return
        }
        this.output(
          scope.id,
          scope.operation,
          "err",
          `::error::${scope.operation} was cancelled (winvm cancel) before its point of no return; it changed nothing more\n`,
        )
        resolve(INTERRUPTED)
      }
      if (scope.signal.aborted) {
        stop()
        return
      }
      scope.signal.addEventListener("abort", stop, { once: true })
      work
        .then(
          (code) => {
            if (scope.signal.reason === HOST_END && code !== 0)
              reject(new Error(HOST_END))
            else resolve(code)
          },
          (error: unknown) => {
            reject(
              error instanceof Error && !(error instanceof OpEnded)
                ? error
                : new Error(
                    error instanceof OpEnded
                      ? String(scope.signal.reason)
                      : String(error),
                  ),
            )
          },
        )
        .finally(() => {
          scope.signal.removeEventListener("abort", stop)
        })
    })
  }

  private endUnheld(running: Running, args: Args, error: unknown): void {
    const { scope } = running
    const why: unknown = scope.signal.aborted ? scope.signal.reason : null
    const killed = why === KILLED
    const cancelled = why === CANCELLED
    const ended = typeof why === "string" ? DID_NOT_RUN[why] : undefined
    const message = cancelled
      ? `${scope.operation} was cancelled (winvm cancel) before it began; nothing was done`
      : ended !== undefined
        ? `${scope.operation} did not run: ${ended}`
        : error instanceof Error
          ? error.message
          : String(error)
    if (!killed)
      this.output(scope.id, scope.operation, "err", `::error::${message}\n`)
    appendEntry(this.name, {
      kind: "op",
      phase: "end",
      id: scope.id,
      operation: scope.operation,
      pid: process.pid,
      startedAt: running.startedAt,
      automatic: automaticFrom(args),
      leased: false,
      endedAt: new Date().toISOString(),
      ok: false,
      ...(killed
        ? { error: KILLED }
        : {
            exitCode: cancelled ? INTERRUPTED : 1,
            error: ended ?? message,
          }),
    })
  }

  private output(
    id: string,
    operation: string,
    stream: OutputStream,
    text: string,
  ): void {
    for (let at = 0; at < text.length; ) {
      let end = Math.min(at + CHUNK, text.length)
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)))
        end -= 1
      this.hooks.record({
        kind: "op",
        phase: "output",
        id,
        operation,
        stream,
        text: text.slice(at, end),
      })
      at = end
    }
  }
}
