import { AsyncLocalStorage } from "node:async_hooks"

export type OutputStream = "out" | "err"

export interface OpScope {
  readonly id: string
  readonly operation: string
  readonly signal: AbortSignal
  readonly write: (stream: OutputStream, text: string) => void
  readonly remount: () => void
  irreversibleAt: string | null
}

export class OpEnded extends Error {
  constructor(scope: OpScope) {
    const why: unknown = scope.signal.reason
    super(
      `${scope.operation} was ${why === "killed" ? "ended by winvm kill" : "cancelled"}, so it sends nothing more to QEMU or Windows`,
    )
    this.name = "OpEnded"
  }
}

const scopes = new AsyncLocalStorage<OpScope>()

export const runInOp = <T>(scope: OpScope, run: () => T): T =>
  scopes.run(scope, run)

export const currentOp = (): OpScope | null => scopes.getStore() ?? null

export function checkOp(): void {
  const scope = scopes.getStore()
  if (scope?.signal.aborted === true) throw new OpEnded(scope)
}

export function pointOfNoReturn(): void {
  const scope = scopes.getStore()
  if (scope === undefined) return
  checkOp()
  scope.irreversibleAt ??= new Date().toISOString()
}
