import { AsyncLocalStorage } from "node:async_hooks"

export type OutputStream = "out" | "err"

export interface OpScope {
  readonly id: string
  readonly operation: string
  readonly signal: AbortSignal
  readonly cancelled: AbortSignal
  readonly write: (stream: OutputStream, text: string) => void
  readonly remount: () => void
  irreversibleAt: string | null
  calls: number
}

const ENDED_BY: Readonly<Record<string, string>> = {
  killed: "ended by winvm kill",
  "host-end": "ended because the Mac is shutting down",
  stopping: "ended because winvm's service stopped",
  "qemu-gone": "ended because QEMU is not running",
}

export class OpEnded extends Error {
  constructor(scope: OpScope) {
    const why: unknown = scope.signal.reason
    super(
      `${scope.operation} was ${(typeof why === "string" ? ENDED_BY[why] : undefined) ?? "cancelled"}, so it sends nothing more to QEMU or Windows`,
    )
    this.name = "OpEnded"
  }
}

export const CANCEL_REASON = "winvm cancel"

export class OpCancelled extends Error {
  constructor(scope: OpScope) {
    const why: unknown = scope.cancelled.reason
    super(
      `${scope.operation} was cancelled (${typeof why === "string" ? why : CANCEL_REASON}) before its point of no return; what it had begun was put back`,
    )
    this.name = "OpCancelled"
  }
}

const scopes = new AsyncLocalStorage<OpScope>()

export const runInOp = <T>(scope: OpScope, run: () => T): T =>
  scopes.run(scope, run)

export const currentOp = (): OpScope | null => scopes.getStore() ?? null

export const outsideOp = <T>(run: () => T): T => scopes.exit(run)

export function checkOp(): void {
  const scope = scopes.getStore()
  if (scope?.signal.aborted === true) throw new OpEnded(scope)
}

export async function fenced<T>(call: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore()
  if (scope === undefined) return await call()
  checkOp()
  scope.calls += 1
  try {
    return await call()
  } finally {
    scope.calls -= 1
  }
}

export function checkCancelled(): void {
  const scope = scopes.getStore()
  if (scope?.cancelled.aborted === true) throw new OpCancelled(scope)
}

export function pointOfNoReturn(): void {
  const scope = scopes.getStore()
  if (scope === undefined) return
  checkOp()
  checkCancelled()
  scope.irreversibleAt ??= new Date().toISOString()
}
