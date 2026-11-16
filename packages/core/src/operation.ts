import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import type { Args } from "./args"
import { isValidInstanceName } from "./args"
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

const INTERNAL_OPERATIONS = ["reconcile", "destroy"] as const

export type LeaseOperation = VmOperation | (typeof INTERNAL_OPERATIONS)[number]

export interface OperationInfo {
  readonly operation: VmOperation
  readonly pid: number
  readonly startedAt: string
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
}

export interface LeaseSeams {
  readonly startOf?: (pid: number) => string | null
}

export interface LeaseOptions extends LeaseSeams {
  readonly automatic?: boolean
  readonly waitMs?: number
  readonly pollMs?: number
  readonly onWait?: (holder: LeaseHolder) => void
}

export const AUTOMATIC_ENV = "WINVM_AUTOMATIC"
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
  if (recover) takeOver(file, json)
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
    : { operation: r.operation, pid: r.pid, startedAt: r.startedAt }
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

function release(file: string, id: string): void {
  if (parseRecord(readOr(file, ""))?.id === id) rmSync(file, { force: true })
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

const waitsFor = (automatic: boolean, holder: LeaseHolder): boolean =>
  !automatic && holder.automatic

function announceWait(name: string): (holder: LeaseHolder) => void {
  return (holder) => {
    console.error(
      `instance "${name}": waiting for the ${holder.operation} winvm started by itself (pid ${String(holder.pid)}) to finish`,
    )
  }
}

const TAKE_ATTEMPTS = 50

async function acquire(
  name: string,
  operation: LeaseOperation,
  o: LeaseOptions,
): Promise<LeaseRecord | InstanceBusy> {
  const file = pathsFor(name).lease
  const automatic = o.automatic ?? process.env[AUTOMATIC_ENV] === "1"
  const record: LeaseRecord = {
    operation,
    id: randomUUID(),
    pid: process.pid,
    pidStart: ownStart(),
    startedAt: new Date().toISOString(),
    instance: name,
    automatic,
  }
  const deadline = Date.now() + (o.waitMs ?? AUTOMATIC_WAIT_MS)
  const onWait = o.onWait ?? announceWait(name)
  let announced = false
  for (let vanished = 0; vanished < TAKE_ATTEMPTS; ) {
    mkdirSync(dirname(file), { recursive: true })
    if (linkNew(file, JSON.stringify(record))) return record
    const holder = leaseHolder(name, o, true)
    if (holder === null) {
      vanished += 1
      continue
    }
    if (!waitsFor(automatic, holder) || Date.now() >= deadline)
      return new InstanceBusy(name, holder)
    if (!announced) onWait(holder)
    announced = true
    await sleep(o.pollMs ?? 200)
  }
  throw new Error(`could not take ${file}: it kept changing under this command`)
}

export async function withOperation<T>(
  name: string,
  operation: LeaseOperation,
  run: () => T | Promise<T>,
  o: LeaseOptions = {},
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
    return await run()
  }
  const file = pathsFor(name).lease
  const onExit = (): void => {
    release(file, got.id)
  }
  process.on("exit", onExit)
  try {
    return await held.run(
      new Map([...(held.getStore() ?? []), [name, got.id]]),
      run,
    )
  } finally {
    process.off("exit", onExit)
    release(file, got.id)
  }
}
