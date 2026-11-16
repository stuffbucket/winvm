import { randomUUID } from "node:crypto"
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

import { effectiveConfig } from "./config"
import { linkNew, takeOver } from "./exclusive"
import { buildIdentity } from "./identity"
import { InstanceBusy, leaseHolder, withOperation } from "./operation"
import { NO_RECONCILE, cliEntry, pathsFor, type Paths } from "./paths"
import { isSameProcess, ownStart } from "./proc"
import { pidOf as qemuPid } from "./qemu"
import { ensureService, readService, type ServiceInfo } from "./servicectl"
import {
  ensureWatcher,
  readWatchState,
  stopWatcher,
  watchPathsFor,
  watcherFreshness,
  watcherRecord,
  type WatcherRecord,
} from "./watch"

export type ManagementFailureKind =
  | "service-replace"
  | "watcher-replace"
  | "reconcile-lock"

export class ManagementError extends Error {
  readonly kind: ManagementFailureKind
  readonly retryable = true

  constructor(
    kind: ManagementFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ManagementError"
    this.kind = kind
  }
}

export type ReconcileResult = {
  readonly changed: boolean
  readonly servicePid: number | null
  readonly watcherPid: number | null
  readonly deferred?: "saving" | "autosaving" | "stowing"
}

export interface ReconcileOptions {
  readonly current?: string
  readonly startService?: () => void
  readonly serviceTimeoutMs?: number
  readonly startWatcher?: () => number | null
  readonly watcherTimeoutMs?: number
  readonly lockWaitMs?: number
  readonly waitForBusyWatcher?: boolean
}

const RECONCILING_VERBS: ReadonlySet<string> = new Set([
  "status",
  "info",
  "saves",
  "snapshots",
  "config",
  "diagnose",
  "screenshot",
  "toasts",
  "ocr",
  "exec",
  "agent",
  "put",
  "get",
  "dir",
  "mkdir",
  "mv",
  "cp",
  "rm",
  "files",
  "launch",
  "ui",
  "terminal",
  "smoke",
  "webview",
  "type",
  "key",
  "click",
  "move",
  "scroll",
  "display",
  "open",
  "web",
  "clock",
  "reboot",
  "save",
  "load",
  "snapshot",
  "rewind",
  "golden",
  "share",
  "pause",
  "resume",
  "wake",
  "sleep",
  "lock",
])

export function shouldReconcileVerb(
  verb: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[NO_RECONCILE] !== "1" && RECONCILING_VERBS.has(verb)
}

export function reconcileNote(
  name: string,
  r: ReconcileResult,
  p: Paths = pathsFor(name),
): string | null {
  if (!r.changed || r.deferred !== undefined || qemuPid(p) === null) return null
  const managed = [
    r.servicePid === null ? null : "control service",
    r.watcherPid === null ? null : "watcher",
  ].filter((part): part is string => part !== null)
  const update =
    managed.length === 0
      ? "obsolete management processes were stopped"
      : `${managed.join(" and ")} ${managed.length === 1 ? "now runs" : "now run"} this build`
  return `note: "${name}"'s ${update}; Windows kept running`
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

interface LockBody {
  readonly pid: number
  readonly start: string | null
  readonly token: string
  readonly waiting?: "autosaving" | "stowing"
}

function parseLock(text: string): LockBody | null {
  try {
    const b = JSON.parse(text) as Partial<LockBody>
    return typeof b.pid === "number" && typeof b.token === "string"
      ? (b as LockBody)
      : null
  } catch {
    return null
  }
}

const holds = (b: LockBody): boolean => isSameProcess(b.pid, b.start)

const lockError = (
  file: string,
  why: string,
  cause?: unknown,
): ManagementError =>
  new ManagementError(
    "reconcile-lock",
    `could not take ${file}: ${why}. Nothing was stopped and Windows is still running; run the command again to retry, ` +
      "or remove that file if no other winvm is running",
    cause === undefined ? undefined : { cause },
  )

class ReconcileLock {
  private body: LockBody
  private readonly file: string

  constructor(file: string, body: LockBody) {
    this.file = file
    this.body = body
  }

  private owned(): boolean {
    try {
      return (
        parseLock(readFileSync(this.file, "utf8"))?.token === this.body.token
      )
    } catch {
      return false
    }
  }

  waiting(on: "autosaving" | "stowing" | null): void {
    const next: LockBody = {
      pid: this.body.pid,
      start: this.body.start,
      token: this.body.token,
      ...(on === null ? {} : { waiting: on }),
    }
    this.body = next
    if (!this.owned()) return
    try {
      const tmp = `${this.file}.${String(process.pid)}.${randomUUID()}.tmp`
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      throw lockError(
        this.file,
        `it could not be updated: ${errText(error)}`,
        error,
      )
    }
  }

  release(): void {
    if (this.owned()) rmSync(this.file, { force: true })
  }
}

type Acquired = { readonly lock: ReconcileLock } | { readonly busy: LockBody }

async function acquire(file: string, waitMs: number): Promise<Acquired> {
  const body: LockBody = {
    pid: process.pid,
    start: ownStart(),
    token: randomUUID(),
  }
  const deadline = Date.now() + waitMs
  let live: LockBody | null = null
  let problem = "it kept changing under this command"
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      if (Date.now() >= deadline) {
        if (live !== null) return { busy: live }
        throw lockError(file, problem)
      }
      await sleep(Math.min(25 * attempt, 200))
    }
    let linked: boolean
    try {
      linked = linkNew(file, JSON.stringify(body))
    } catch (error) {
      throw lockError(file, `it could not be created: ${errText(error)}`, error)
    }
    if (linked) return { lock: new ReconcileLock(file, body) }
    live = null
    let seen: string
    try {
      seen = readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        problem = `it cannot be read: ${errText(error)}`
      continue
    }
    const holder = parseLock(seen)
    if (holder !== null && holds(holder)) {
      if (holder.waiting !== undefined) return { busy: holder }
      live = holder
      continue
    }
    if (!takeOver(file, seen))
      problem =
        "it was left by a winvm that has gone, and could not be taken over"
  }
}

const owedPath = (p: Paths): string => resolve(p.dir, "watch.owed")

function owedTo(p: Paths): number | null {
  try {
    const q = (
      JSON.parse(readFileSync(owedPath(p), "utf8")) as { qemu?: unknown }
    ).qemu
    return typeof q === "number" ? q : -1
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : -1
  }
}

function owe(p: Paths, qemu: number): void {
  const tmp = `${owedPath(p)}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ qemu })}\n`)
  renameSync(tmp, owedPath(p))
}

const forgive = (p: Paths): void => {
  rmSync(owedPath(p), { force: true })
}

type Standing = "current" | "rotate" | "foreign"

function standing(
  build: string | undefined,
  cli: string | undefined,
  current: string,
  mine: string,
): Standing {
  if (build === undefined || build === "") return "rotate"
  if (build === current) return "current"
  return cli !== undefined && cli !== "" && cli !== mine ? "foreign" : "rotate"
}

interface Plan {
  readonly service: ServiceInfo | null
  readonly serviceAction: "none" | "start" | "replace"
  readonly watcher: WatcherRecord | null
  readonly rotateWatcher: boolean
  readonly foreign: boolean
}

function plan(name: string, p: Paths, current: string): Plan {
  const mine = cliEntry()
  const service = readService(p)
  const watcher = watcherRecord(name)
  const broker = existsSync(p.qmpQemu)
  const serviceStanding =
    service === null
      ? null
      : standing(service.build, service.cli, current, mine)
  if (broker && serviceStanding === "foreign")
    return {
      service,
      serviceAction: "none",
      watcher,
      rotateWatcher: false,
      foreign: true,
    }
  const serviceAction = !broker
    ? "none"
    : service === null
      ? "start"
      : serviceStanding === "rotate"
        ? "replace"
        : "none"
  const rotateWatcher =
    watcher !== null &&
    standing(watcher.build, watcher.cli, current, mine) === "rotate"
  return { service, serviceAction, watcher, rotateWatcher, foreign: false }
}

const hasWork = (pl: Plan): boolean =>
  pl.serviceAction !== "none" || pl.rotateWatcher

const pids = (
  name: string,
  p: Paths,
): { servicePid: number | null; watcherPid: number | null } => ({
  servicePid: readService(p)?.pid ?? null,
  watcherPid: watcherRecord(name)?.pid ?? null,
})

function busyWith(
  name: string,
  w: WatcherRecord | null,
): "autosaving" | "stowing" | null {
  if (w === null) return null
  const st = readWatchState(name)
  return st !== null &&
    st.pid === w.pid &&
    (st.state === "autosaving" || st.state === "stowing")
    ? st.state
    : null
}

export async function reconcileManagement(
  name: string,
  p: Paths = pathsFor(name),
  o: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (qemuPid(p) === null)
    return { changed: false, servicePid: null, watcherPid: null }
  const current = o.current ?? buildIdentity()
  const first = plan(name, p, current)
  if (!hasWork(first) && !existsSync(owedPath(p))) {
    return {
      changed: false,
      servicePid: first.service?.pid ?? null,
      watcherPid: first.watcher?.pid ?? null,
    }
  }
  const got = await acquire(p.reconcile, o.lockWaitMs ?? 60_000)
  if ("busy" in got) {
    return {
      changed: false,
      ...pids(name, p),
      ...(got.busy.waiting === undefined ? {} : { deferred: got.busy.waiting }),
    }
  }
  try {
    return await reconcileHeld(name, p, o, current, got.lock)
  } finally {
    got.lock.release()
  }
}

class Failed {
  readonly error: ManagementError
  constructor(error: ManagementError) {
    this.error = error
  }
}

async function reconcileHeld(
  name: string,
  p: Paths,
  o: ReconcileOptions,
  current: string,
  lock: ReconcileLock,
): Promise<ReconcileResult> {
  const qemu = qemuPid(p)
  const owed = owedTo(p)
  if (qemu === null) {
    forgive(p)
    return { changed: false, servicePid: null, watcherPid: null }
  }
  if (owed !== null && owed !== qemu) forgive(p)
  const pl = plan(name, p, current)
  if (pl.foreign) return { changed: false, ...pids(name, p) }
  if (owed === qemu && pl.watcher !== null && !pl.rotateWatcher) forgive(p)
  const owesWatcher = owed === qemu && pl.watcher === null
  if (!hasWork(pl) && !owesWatcher) return { changed: false, ...pids(name, p) }

  const stopsWatcher =
    pl.watcher !== null && (pl.serviceAction === "replace" || pl.rotateWatcher)
  const busy = stopsWatcher ? busyWith(name, pl.watcher) : null
  const holder = leaseHolder(name)
  if (busy === null && holder !== null && holder.pid !== pl.watcher?.pid)
    return { changed: false, ...pids(name, p), deferred: "saving" }
  if (busy !== null && o.waitForBusyWatcher === false)
    return { changed: false, ...pids(name, p), deferred: busy }

  let changed = false
  let stopped = false as boolean
  const stop = async (): Promise<void> => {
    owe(p, qemu)
    await stopWatcher(name)
    stopped = true
    changed = true
    if (watcherRecord(name) !== null) {
      throw new ManagementError(
        "watcher-replace",
        `could not stop the watcher of "${name}" to replace it. Windows is still running; run the command again to retry`,
      )
    }
  }

  if (busy !== null) {
    lock.waiting(busy)
    await stop()
    lock.waiting(null)
    if (qemuPid(p) === null) {
      forgive(p)
      return {
        changed,
        ...pids(name, p),
        watcherPid: null,
        ...(busy === "stowing" ? { deferred: "stowing" as const } : {}),
      }
    }
  }

  let outcome: ReconcileResult | Failed
  try {
    outcome = await withOperation(
      name,
      "reconcile",
      async (): Promise<ReconcileResult | Failed> => {
        try {
          if (qemuPid(p) !== qemu) {
            forgive(p)
            return { changed, ...pids(name, p) }
          }
          if (stopsWatcher && !stopped && pl.serviceAction === "replace")
            await stop()
          if (pl.serviceAction !== "none") {
            try {
              await ensureService(name, p, {
                current,
                ...(o.startService === undefined
                  ? {}
                  : { start: o.startService }),
                ...(o.serviceTimeoutMs === undefined
                  ? {}
                  : { timeoutMs: o.serviceTimeoutMs }),
              })
              changed = true
            } catch (error) {
              if (stopped)
                await restoreWatcher(name, p, current, o).catch(() => undefined)
              return new Failed(
                new ManagementError(
                  "service-replace",
                  `could not start a current control service for "${name}": ${errText(error)}. ` +
                    `Windows is still running; run the command again to retry (see ${resolve(p.dir, "service.log")})`,
                  { cause: error },
                ),
              )
            }
          }
          if (pl.rotateWatcher && !stopped) await stop()
          if ((await restoreWatcher(name, p, current, o)) === "started")
            changed = true
          return { changed, ...pids(name, p) }
        } catch (error) {
          if (error instanceof ManagementError) return new Failed(error)
          throw error
        }
      },
      { automatic: true },
    )
  } catch (error) {
    if (error instanceof InstanceBusy) {
      if (stopped)
        await restoreWatcher(name, p, current, o).catch(() => undefined)
      return { changed, ...pids(name, p), deferred: "saving" }
    }
    throw new ManagementError(
      "reconcile-lock",
      `could not reconcile the control service and watcher of "${name}": ${errText(error)}. ` +
        "Windows is still running; run the command again to retry",
      { cause: error },
    )
  }
  if (outcome instanceof Failed) throw outcome.error
  return outcome
}

async function restoreWatcher(
  name: string,
  p: Paths,
  current: string,
  o: ReconcileOptions,
): Promise<"started" | "settled" | "none"> {
  const q = qemuPid(p)
  if (q === null || owedTo(p) !== q) return "none"
  if (watcherRecord(name) !== null || !effectiveConfig(name)["watch.enabled"]) {
    forgive(p)
    return "settled"
  }
  const failed = (why: string, cause?: unknown): ManagementError =>
    new ManagementError(
      "watcher-replace",
      `could not restart the watcher of "${name}": ${why}. Windows is still running; ` +
        `run the command again to retry, or \`winvm watch -i ${name}\` (see ${watchPathsFor(name).log})`,
      cause === undefined ? undefined : { cause },
    )
  const start = o.startWatcher ?? ((): number | null => ensureWatcher(name))
  try {
    start()
  } catch (error) {
    throw failed(errText(error), error)
  }
  const deadline = Date.now() + (o.watcherTimeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    const w = watcherRecord(name)
    if (w !== null && watcherFreshness(w, current) === "current") {
      forgive(p)
      return "started"
    }
    await sleep(100)
  }
  throw failed("it did not report this build in time")
}
