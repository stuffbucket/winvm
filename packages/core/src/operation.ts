import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import type { Args } from "./args"
import { isValidInstanceName } from "./args"
import { appendEntry, type OpIdentity, type OpOutcome } from "./eventlog"
import { linkNew, readOr, replaceWhole, takeOver } from "./exclusive"
import { pathsFor } from "./paths"
import { isSameProcess, ownStart, processStart } from "./proc"

export const VM_OPERATIONS = [
  "start",
  "stop",
  "reboot",
  "kill",
  "reset",
  "snapshot",
  "rewind",
  "save",
  "load",
  "pause",
  "resume",
  "sleep",
  "wake",
  "lock",
  "stow",
  "setup",
  "golden-create",
  "golden-reset",
] as const

export type VmOperation = (typeof VM_OPERATIONS)[number]

export const STOP_UNFINISHED = 3

const INTERNAL_OPERATIONS = [
  "reconcile",
  "destroy",
  "build",
  "remount",
] as const

export type LeaseOperation = VmOperation | (typeof INTERNAL_OPERATIONS)[number]

export interface OperationInfo {
  readonly operation: VmOperation
  readonly pid: number
  readonly startedAt: string
  readonly id?: string
}

export interface LeaseHolder {
  readonly operation: string
  readonly pid: number
  readonly startedAt: string
  readonly automatic: boolean
}

interface LeaseRecord extends LeaseHolder {
  readonly id: string
  readonly pidStart: string | null
  readonly instance: string
  readonly savingRunning?: true
  readonly irreversibleAt?: string
}

export interface LeaseSeams {
  readonly startOf?: (pid: number) => string | null
}

export interface LeaseOptions extends LeaseSeams {
  readonly automatic?: boolean
  readonly id?: string
  readonly queue?: boolean
  readonly signal?: AbortSignal
  readonly waitMs?: number
  readonly pollMs?: number
  readonly onWait?: (holder: LeaseHolder) => void
}

export const AUTOMATIC_FLAG = "automatic"
export const AUTOMATIC_WAIT_MS = 10 * 60_000

const isVmOperation = (v: unknown): v is VmOperation =>
  typeof v === "string" && (VM_OPERATIONS as readonly string[]).includes(v)

const GOLDEN_ACTION: Readonly<Record<string, VmOperation>> = {
  create: "golden-create",
  reset: "golden-reset",
}

export function operationFor(
  sub: string | undefined,
  args: Args,
): LeaseOperation | null {
  const action = args.positional[0]
  if (sub === "golden")
    return action === undefined ? null : (GOLDEN_ACTION[action] ?? null)
  if (sub === "share") return action === "install" ? "setup" : null
  if (sub === "destroy") return "destroy"
  if (sub === "setup" || sub === "golden-create" || sub === "golden-reset")
    return null
  return isVmOperation(sub) ? sub : null
}

const CREATES: readonly LeaseOperation[] = ["start", "load", "golden-create"]

const isPlainName = (name: string): boolean =>
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\0")

function leaseable(name: string, operation: LeaseOperation): boolean {
  if (!isPlainName(name)) return false
  return (
    existsSync(pathsFor(name).meta) ||
    (CREATES.includes(operation) && isValidInstanceName(name))
  )
}

const held = new AsyncLocalStorage<ReadonlyMap<string, string>>()

const heldHere = (name: string): string | undefined =>
  held.getStore()?.get(name)

export interface HeldLease {
  readonly instance: string
  readonly id: string
}

const issued = new WeakSet<HeldLease>()

export function heldLease(name: string): HeldLease | null {
  const id = heldHere(name)
  if (id === undefined) return null
  const lease: HeldLease = Object.freeze({ instance: name, id })
  issued.add(lease)
  return lease
}

export function holdsLease(lease: HeldLease): boolean {
  if (!issued.has(lease) || heldHere(lease.instance) !== lease.id) return false
  return (
    parseRecord(readOr(pathsFor(lease.instance).lease, ""))?.id === lease.id
  )
}

export class LeaseNotHeld extends Error {
  constructor(name: string, what: string) {
    super(
      `${what} needs the lease on instance "${name}", and this command does not hold it`,
    )
    this.name = "LeaseNotHeld"
  }
}

export class InstanceBusy extends Error {
  readonly holder: LeaseHolder

  constructor(name: string, holder: LeaseHolder) {
    super(
      `instance "${name}" is busy: ${holder.operation} (pid ${String(holder.pid)}${holder.automatic ? ", started by winvm itself" : ""}) ` +
        `since ${holder.startedAt}; try again once it finishes`,
    )
    this.name = "InstanceBusy"
    this.holder = holder
  }
}

const text = (v: unknown, fallback: string): string =>
  typeof v === "string" ? v : fallback

function parseRecord(json: string): LeaseRecord | null {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const pid = r.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null
  return {
    operation: text(r.operation, "unknown"),
    id: text(r.id, ""),
    pid,
    pidStart: typeof r.pidStart === "string" ? r.pidStart : null,
    startedAt: text(r.startedAt, ""),
    instance: text(r.instance, ""),
    automatic: r.automatic === true,
    ...(r.savingRunning === true ? { savingRunning: true as const } : {}),
    ...(typeof r.irreversibleAt === "string"
      ? { irreversibleAt: r.irreversibleAt }
      : {}),
  }
}

const identityOf = (r: LeaseRecord, leased: boolean): OpIdentity => ({
  id: r.id,
  operation: r.operation,
  pid: r.pid,
  startedAt: r.startedAt,
  automatic: r.automatic,
  leased,
})

function recordBegin(name: string, who: OpIdentity): void {
  appendEntry(name, { kind: "op", phase: "begin", ...who })
}

function recordEnd(name: string, who: OpIdentity, outcome: OpOutcome): void {
  appendEntry(name, {
    kind: "op",
    phase: "end",
    ...who,
    endedAt: new Date().toISOString(),
    ...outcome,
  })
}

const exited = (code: number): OpOutcome => ({ ok: code === 0, exitCode: code })

const settled = (result: unknown): OpOutcome =>
  typeof result === "number" && Number.isInteger(result)
    ? exited(result)
    : { ok: true }

const failed = (error: unknown): OpOutcome => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
})

const noMark = (): Pick<OpOutcome, "irreversibleAt"> => ({})

async function recorded<T>(
  name: string,
  who: OpIdentity,
  run: () => T | Promise<T>,
  outcome: (result: T) => OpOutcome = settled,
  markOf: () => Pick<OpOutcome, "irreversibleAt"> = noMark,
): Promise<T> {
  recordBegin(name, who)
  try {
    const result = await run()
    recordEnd(name, who, { ...outcome(result), ...markOf() })
    return result
  } catch (error) {
    recordEnd(name, who, { ...failed(error), ...markOf() })
    throw error
  }
}

function readLease(
  name: string,
  seams: LeaseSeams = {},
  recover = false,
): LeaseRecord | null {
  if (!isPlainName(name)) return null
  const file = pathsFor(name).lease
  const json = readOr(file, null)
  if (json === null) return null
  const r = parseRecord(json)
  if (
    r !== null &&
    isSameProcess(r.pid, r.pidStart, seams.startOf ?? processStart)
  )
    return r
  if (recover && takeOver(file, json) && r !== null)
    recordEnd(name, identityOf(r, true), {
      ok: false,
      abandoned: true,
      error: `pid ${String(r.pid)} went away without letting go of the instance`,
      ...(r.irreversibleAt === undefined
        ? {}
        : { irreversibleAt: r.irreversibleAt }),
    })
  return null
}

const holderOf = (r: LeaseRecord): LeaseHolder => ({
  operation: r.operation,
  pid: r.pid,
  startedAt: r.startedAt,
  automatic: r.automatic,
})

export function readOperation(
  name: string,
  seams: LeaseSeams = {},
): OperationInfo | null {
  const r = readLease(name, seams)
  return r === null || !isVmOperation(r.operation)
    ? null
    : {
        operation: r.operation,
        pid: r.pid,
        startedAt: r.startedAt,
        ...(r.id === "" ? {} : { id: r.id }),
      }
}

export function leaseHolder(
  name: string,
  seams: LeaseSeams = {},
  recover = false,
): LeaseHolder | null {
  const r = readLease(name, seams, recover)
  return r === null || r.id === heldHere(name) ? null : holderOf(r)
}

export const savingRunning = (name: string, seams: LeaseSeams = {}): boolean =>
  readLease(name, seams)?.savingRunning === true

function rewriteOwn(
  name: string,
  change: (r: LeaseRecord) => LeaseRecord,
): void {
  const id = heldHere(name)
  if (id === undefined) return
  const file = pathsFor(name).lease
  const current = parseRecord(readOr(file, ""))
  if (current?.id === id) replaceWhole(file, JSON.stringify(change(current)))
}

export const markSavingRunning = (name: string): void => {
  rewriteOwn(name, (r) => ({ ...r, savingRunning: true }))
}

export const clearSavingRunning = (name: string): void => {
  rewriteOwn(name, ({ savingRunning: _, ...rest }) => rest)
}

interface Mark {
  readonly at: string
  readonly recovery: readonly string[]
}

const marks = new Map<string, Mark>()
const listening = new Map<string, LeaseOperation>()
const taken = new Map<string, AbortController>()

const tolerated = (f: () => void): void => {
  try {
    f()
  } catch {}
}

export function irreversible(
  name: string,
  recovery: readonly string[],
): () => void {
  if (heldHere(name) === undefined) return () => undefined
  const mark: Mark = { at: new Date().toISOString(), recovery }
  marks.set(name, mark)
  tolerated(() => {
    rewriteOwn(name, (r) => ({ ...r, irreversibleAt: mark.at }))
  })
  return () => {
    if (marks.get(name) !== mark) return
    marks.delete(name)
    tolerated(() => {
      rewriteOwn(name, ({ irreversibleAt: _, ...rest }) => rest)
    })
  }
}

export function irreversibleSince(
  name: string,
  seams: LeaseSeams = {},
): string | null {
  const r = readLease(name, seams)
  return r?.irreversibleAt ?? null
}

export function abandonedStop(
  name: string,
  seams: LeaseSeams = {},
): { readonly at: string } | null {
  if (!isPlainName(name)) return null
  const json = readOr(pathsFor(name).lease, null)
  const r = json === null ? null : parseRecord(json)
  if (r === null || r.irreversibleAt === undefined) return null
  return isSameProcess(r.pid, r.pidStart, seams.startOf ?? processStart)
    ? null
    : { at: r.irreversibleAt }
}

export interface Interrupts {
  readonly signal: AbortSignal
  readonly release: () => void
}

export function takeInterrupts(
  name: string,
  operation: LeaseOperation,
): Interrupts {
  if (heldHere(name) === undefined || listening.get(name) !== operation)
    return { signal: new AbortController().signal, release: () => undefined }
  const controller = new AbortController()
  taken.set(name, controller)
  return {
    signal: controller.signal,
    release: () => {
      if (taken.get(name) === controller) taken.delete(name)
    },
  }
}

export const interruptedAfterRequest = (
  operation: string,
  signal: string,
): string =>
  `::error::${operation} interrupted by ${signal} after it asked Windows to shut down, and did not finish.`

const markOf = (name: string): Pick<OpOutcome, "irreversibleAt"> => {
  const mark = marks.get(name)
  return mark === undefined ? {} : { irreversibleAt: mark.at }
}

const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const
export const INTERRUPTED = 130

function release(file: string, id: string): void {
  if (parseRecord(readOr(file, ""))?.id === id) rmSync(file, { force: true })
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

const automaticOf = (o: LeaseOptions): boolean => o.automatic === true

const waitsFor = (o: LeaseOptions, holder: LeaseHolder): boolean =>
  o.queue === true || (!automaticOf(o) && holder.automatic)

export const waitNote = (name: string, holder: LeaseHolder): string =>
  `instance "${name}": waiting for the ${holder.operation}${holder.automatic ? " winvm started by itself" : ""} (pid ${String(holder.pid)}) to finish`

function announceWait(name: string): (holder: LeaseHolder) => void {
  return (holder) => {
    console.error(waitNote(name, holder))
  }
}

const TAKE_ATTEMPTS = 50

export const automaticFrom = (args: Args): boolean =>
  args.flags.has(AUTOMATIC_FLAG)

const ownRecord = (
  name: string,
  operation: LeaseOperation,
  o: LeaseOptions,
): LeaseRecord => ({
  operation,
  id: o.id ?? randomUUID(),
  pid: process.pid,
  pidStart: ownStart(),
  startedAt: new Date().toISOString(),
  instance: name,
  automatic: automaticOf(o),
})

async function acquire(
  name: string,
  operation: LeaseOperation,
  o: LeaseOptions,
): Promise<LeaseRecord | InstanceBusy> {
  const file = pathsFor(name).lease
  const record = ownRecord(name, operation, o)
  const deadline = Date.now() + (o.waitMs ?? AUTOMATIC_WAIT_MS)
  const onWait = o.onWait ?? announceWait(name)
  let announced = false
  for (let vanished = 0; vanished < TAKE_ATTEMPTS; ) {
    o.signal?.throwIfAborted()
    mkdirSync(dirname(file), { recursive: true })
    if (linkNew(file, JSON.stringify(record))) return record
    const holder = leaseHolder(name, o, true)
    if (holder === null) {
      vanished += 1
      continue
    }
    if (!waitsFor(o, holder) || Date.now() >= deadline)
      return new InstanceBusy(name, holder)
    if (!announced) onWait(holder)
    announced = true
    await sleep(o.pollMs ?? 200)
  }
  throw new Error(`could not take ${file}: it kept changing under this command`)
}

export interface OperationOptions<T> extends LeaseOptions {
  readonly outcome?: (result: T) => OpOutcome
  readonly interruptible?: true
}

export async function withOperation<T>(
  name: string,
  operation: LeaseOperation,
  run: () => T | Promise<T>,
  o: OperationOptions<T> = {},
): Promise<T> {
  if (heldHere(name) !== undefined || !leaseable(name, operation))
    return await run()
  const got = await acquire(
    name,
    operation,
    operation === "kill" ? { ...o, waitMs: 0 } : o,
  )
  if (got instanceof InstanceBusy) {
    if (operation !== "kill") throw got
    console.error(
      `note: ${got.holder.operation} (pid ${String(got.holder.pid)}) holds "${name}"; killing it anyway`,
    )
    const own = ownRecord(name, operation, o)
    return await recorded(name, identityOf(own, false), run, o.outcome)
  }
  const file = pathsFor(name).lease
  const who = identityOf(got, true)
  let ended = false
  const end = (outcome: OpOutcome): void => {
    if (!ended) recordEnd(name, who, { ...outcome, ...markOf(name) })
    ended = true
    release(file, got.id)
  }
  const onExit = (code: number): void => {
    end(exited(code))
  }
  const say = (...lines: readonly string[]): void => {
    tolerated(() => {
      for (const line of lines) console.error(line)
    })
  }
  const handlers = INTERRUPTS.map((signal) => {
    const handler = (): void => {
      const mark = marks.get(name)
      if (mark !== undefined) {
        end(exited(STOP_UNFINISHED))
        say(
          interruptedAfterRequest(who.operation, signal),
          ...mark.recovery.map((line) => `  ${line}`),
        )
        process.exit(INTERRUPTED)
      }
      const rollback = taken.get(name)
      if (rollback === undefined) {
        if (process.listenerCount(signal) > 1) return
        leaveInterrupts()
        process.kill(process.pid, signal)
        return
      }
      if (rollback.signal.aborted) {
        end(exited(INTERRUPTED))
        say(
          `::error::${who.operation} interrupted again by ${signal}; exiting at once, and what it took down may not have been put back`,
        )
        process.exit(INTERRUPTED)
      }
      rollback.abort(signal)
      say(
        `::error::${who.operation} interrupted by ${signal}: finishing the current step, then putting everything back. Interrupt again to exit at once.`,
      )
    }
    return [signal, handler] as const
  })
  const leaveInterrupts = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
  process.on("exit", onExit)
  if (o.interruptible === true) {
    listening.set(name, operation)
    for (const [signal, handler] of handlers) process.on(signal, handler)
  }
  try {
    return await recorded(
      name,
      who,
      async () => {
        try {
          return await held.run(
            new Map([...(held.getStore() ?? []), [name, got.id]]),
            run,
          )
        } finally {
          ended = true
        }
      },
      o.outcome,
      () => markOf(name),
    )
  } finally {
    leaveInterrupts()
    process.off("exit", onExit)
    marks.delete(name)
    listening.delete(name)
    taken.delete(name)
    release(file, got.id)
  }
}
