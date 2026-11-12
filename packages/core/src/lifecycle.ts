/**
 * Bringing an instance's management processes — the control service
 * (service.ts) and the watcher (watch.ts) — up to the build running now, while
 * Windows keeps running.
 *
 * Both are detached, so they outlive the CLI that started them, and an update
 * of winvm leaves them running the old code. Every ordinary command for a
 * running instance therefore checks them first (the CLI calls
 * reconcileManagement; `status --json` is how the app gets here as it starts),
 * and replaces what is not of this build:
 *
 *   1. a running watcher is stopped first, through its own save-aware shutdown:
 *      one mid-autosave or mid-stow finishes that before it exits;
 *   2. a stale (or missing) service is stopped and a current one started and
 *      confirmed answering;
 *   3. the watcher is started again, of this build — only if one was running
 *      before, and watching is still enabled.
 *
 * ## What it never does
 *
 * It never signals QEMU, swtpm or virtiofsd, and calls none of the teardown
 * helpers that do (qemu.stopSidecars, finder.cleanStale). QEMU's pidfile is
 * only read. The only processes signalled are the ones service.ts and watch.ts
 * vouch for, by their command lines, as this instance's service and watcher.
 *
 * It never interrupts a save someone else is making: while a manual save holds
 * the instance, it returns `deferred: "saving"` and touches nothing, and the
 * next command retries once the save is done.
 *
 * It never runs inside the processes it manages: they are started with
 * WINVM_NO_RECONCILE=1 (paths.managedEnv), and `serve` and `watch` are not
 * verbs it runs before (shouldReconcileVerb).
 *
 * ## One at a time
 *
 * Callers are serialized by `reconcile.lock` in the instance directory, taken
 * atomically (a complete file linked into place, so never seen half-written)
 * and naming its holder by pid AND process start time, so a pid reused after a
 * crash does not hold it forever. Whoever takes the lock looks at the records
 * again before doing anything: the caller it waited behind has usually done
 * the work already. While the holder waits on a watcher's autosave or stow it
 * says so in the lock, and other callers return `deferred` at once rather than
 * queue behind it.
 *
 * A holder killed part-way (the app's status call has a deadline) leaves the
 * lock behind with what it still owed: `restoreWatcher` when it had stopped a
 * watcher and not yet started its replacement. Whoever takes over that lock
 * finishes the job.
 *
 * ## When it fails
 *
 * A service or watcher that cannot be replaced is a ManagementError, typed by
 * which, and always retryable: QEMU is still running, the stale record is gone
 * (not reported as a healthy service), and the next command tries again.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { effectiveConfig } from "./config"
import { savingPath } from "./frozen"
import { buildIdentity } from "./identity"
import { NO_RECONCILE, cliEntry, pathsFor, type Paths } from "./paths"
import { savesDir } from "./saves"
import { ensureService, readService, serviceFreshness, type ServiceInfo } from "./service"
import { ensureWatcher, readWatchState, stopWatcher, watcherFreshness, watcherRecord, type WatcherRecord } from "./watch"

export type ManagementFailureKind = "service-replace" | "watcher-replace"

/** A management process that could not be replaced. Windows is still running; running the command again retries. */
export class ManagementError extends Error {
  readonly kind: ManagementFailureKind
  readonly retryable = true

  constructor(kind: ManagementFailureKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ManagementError"
    this.kind = kind
  }
}

export type ReconcileResult = {
  /** Whether any process was stopped or started. */
  readonly changed: boolean
  readonly servicePid: number | null
  readonly watcherPid: number | null
  /** Left for a later command, because of a save in progress: someone's ("saving"), or the watcher's own. */
  readonly deferred?: "saving" | "autosaving" | "stowing"
}

/** Seams for tests; every one defaults to the real thing. */
export interface ReconcileOptions {
  /** The generation that counts as current. Defaults to this process's build. */
  readonly current?: string
  /** Launches the service. Defaults to a detached `winvm serve`. */
  readonly startService?: () => void
  readonly serviceTimeoutMs?: number
  /** Launches the watcher, returning its pid. Defaults to a detached `winvm watch`. */
  readonly startWatcher?: () => number | null
  readonly watcherTimeoutMs?: number
  /** How long to wait behind another reconciliation before leaving it to that one. */
  readonly lockWaitMs?: number
}

// ---------------------------------------------------------------------------
// Which commands reconcile

/**
 * The verbs that check management processes first: an instance's read and
 * management verbs, the ones that keep QEMU running.
 *
 * Not here, on purpose: `serve` and `watch` (the processes being managed);
 * `stop`, `kill`, `destroy`, `reset` and `stow` (they end what would be
 * replaced); `build`, `setup`, `adopt`, `create`, `run` and `test` (they make
 * their own instances); `start` (it reconciles itself, once it knows QEMU is
 * already running); `mcp` and `cua` (servers other apps launch, often from a
 * different install, which would replace this one's service back and forth);
 * and host-wide verbs.
 */
const RECONCILING_VERBS: ReadonlySet<string> = new Set([
  // reading
  "status", "info", "saves", "snapshots", "config", "diagnose", "screenshot", "toasts", "ocr",
  // the guest
  "exec", "agent", "put", "get", "dir", "mkdir", "mv", "cp", "rm", "files", "launch", "ui", "terminal", "smoke",
  "webview", "type", "key", "click", "move", "scroll", "display", "open", "web", "clock", "reboot",
  // managing a running instance
  "save", "load", "snapshot", "rewind", "golden", "share", "pause", "resume", "wake", "sleep", "lock",
])

export function shouldReconcileVerb(verb: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NO_RECONCILE] !== "1" && RECONCILING_VERBS.has(verb)
}

// ---------------------------------------------------------------------------
// Processes

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("Z")
}

/** When a process started, as ps prints it: with its pid, it names one process for good. */
function startOf(pid: number): string | null {
  const s = (spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim()
  return s === "" ? null : s
}

let ownStart: string | null | undefined

/** QEMU's pid, from its pidfile, if it is running. Only reads: never removes the file, never signals. */
function qemuPid(p: Paths): number | null {
  try {
    const pid = Number.parseInt(readFileSync(p.pid, "utf8").trim(), 10)
    if (!Number.isFinite(pid)) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/** The live pid a save mark names, if any: the save lock (saves.withLock) or saving.json (frozen.ts). */
function saverPid(name: string, p: Paths): number | null {
  const fromLock = (): number | null => {
    try {
      return Number.parseInt(readFileSync(resolve(savesDir(name), ".lock"), "utf8").trim(), 10)
    } catch {
      return null
    }
  }
  const fromMark = (): number | null => {
    try {
      const pid = (JSON.parse(readFileSync(savingPath(p), "utf8")) as { pid?: unknown }).pid
      return typeof pid === "number" ? pid : null
    } catch {
      return null
    }
  }
  for (const pid of [fromLock(), fromMark()]) if (pid !== null && Number.isFinite(pid) && alive(pid)) return pid
  return null
}

// ---------------------------------------------------------------------------
// The lock

interface LockBody {
  readonly pid: number
  readonly start: string | null
  readonly token: string
  /** A watcher this holder stopped and has not yet started again: whoever takes over owes it. */
  readonly restoreWatcher?: boolean
  /** The watcher save or stow the holder is waiting out: others need not wait too. */
  readonly waiting?: "autosaving" | "stowing"
}

function parseLock(text: string): LockBody | null {
  try {
    const b = JSON.parse(text) as Partial<LockBody>
    return typeof b.pid === "number" && typeof b.token === "string" ? (b as LockBody) : null
  } catch {
    return null
  }
}

const holds = (b: LockBody): boolean => alive(b.pid) && (b.start === null || startOf(b.pid) === b.start)

/** A lock is there and nobody holds it: its holder died, perhaps owing a watcher. */
function abandoned(file: string): boolean {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return false
  }
  const b = parseLock(text)
  return b === null || !holds(b)
}

/** Put a complete file in place only if none is there: never a moment with a partial one. */
function linkNew(file: string, text: string): boolean {
  const tmp = `${file}.${String(process.pid)}.${randomUUID()}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    linkSync(tmp, file)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false
    throw e
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Remove a lock judged abandoned — exactly that one. It is moved aside first
 * and compared with what was judged: if another caller took the lock over in
 * between, that holder's lock is linked back rather than lost.
 */
function takeOver(file: string, judged: string): boolean {
  const aside = `${file}.${String(process.pid)}.${randomUUID()}.stale`
  try {
    renameSync(file, aside)
  } catch {
    return false
  }
  let moved = ""
  try {
    moved = readFileSync(aside, "utf8")
  } catch {
    // vanished: treat as not ours to remove
  }
  if (moved !== judged) {
    try {
      linkSync(aside, file)
    } catch {
      // Someone holds the lock again already.
    }
    rmSync(aside, { force: true })
    return false
  }
  rmSync(aside, { force: true })
  return true
}

class ReconcileLock {
  private body: LockBody
  private readonly file: string

  constructor(file: string, body: LockBody) {
    this.file = file
    this.body = body
  }

  get restoreWatcher(): boolean {
    return this.body.restoreWatcher === true
  }

  private owned(): boolean {
    try {
      return parseLock(readFileSync(this.file, "utf8"))?.token === this.body.token
    } catch {
      return false
    }
  }

  /** Record what a successor would need to know, if this holder dies now. */
  note(fields: { readonly restoreWatcher?: boolean; readonly waiting?: "autosaving" | "stowing" | undefined }): void {
    const next: LockBody = { ...this.body, ...fields }
    if (next.waiting === undefined) delete (next as { waiting?: unknown }).waiting
    this.body = next
    if (!this.owned()) return
    const tmp = `${this.file}.${String(process.pid)}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  release(): void {
    if (this.owned()) rmSync(this.file, { force: true })
  }
}

type Acquired = { readonly lock: ReconcileLock } | { readonly busy: LockBody }

async function acquire(file: string, waitMs: number): Promise<Acquired> {
  ownStart ??= startOf(process.pid)
  const token = randomUUID()
  let restoreWatcher = false
  const deadline = Date.now() + waitMs
  for (;;) {
    const body: LockBody = { pid: process.pid, start: ownStart, token, ...(restoreWatcher ? { restoreWatcher } : {}) }
    if (linkNew(file, JSON.stringify(body))) return { lock: new ReconcileLock(file, body) }
    let seen: string
    try {
      seen = readFileSync(file, "utf8")
    } catch {
      continue // released between the two: try again
    }
    const holder = parseLock(seen)
    if (holder !== null && holds(holder)) {
      if (holder.waiting !== undefined || Date.now() >= deadline) return { busy: holder }
      await new Promise((r) => setTimeout(r, 50))
      continue
    }
    // Its holder is gone (or the pid is another process's now): take it over, and what it owed.
    if (takeOver(file, seen) && holder?.restoreWatcher === true) restoreWatcher = true
  }
}

// ---------------------------------------------------------------------------
// Reconciling

interface Survey {
  readonly service: ServiceInfo | null
  /** The service is missing or not of this build, and this QEMU is one that has a service. */
  readonly serviceWork: boolean
  readonly watcher: WatcherRecord | null
  readonly watcherWork: boolean
}

function survey(name: string, p: Paths, current: string): Survey {
  const service = readService(p)
  // A QEMU started before the control service existed has no broker socket,
  // and a service would take its monitor socket from it: leave it be.
  const serviceWork =
    existsSync(p.qmpQemu) && (service === null || service.cli !== cliEntry() || serviceFreshness(service, current) !== "current")
  const watcher = watcherRecord(name)
  const watcherWork = watcher !== null && watcherFreshness(watcher, current) !== "current"
  return { service, serviceWork, watcher, watcherWork }
}

const pids = (name: string, p: Paths): { servicePid: number | null; watcherPid: number | null } => ({
  servicePid: readService(p)?.pid ?? null,
  watcherPid: watcherRecord(name)?.pid ?? null,
})

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Bring `name`'s service and watcher up to this build, leaving QEMU running.
 * A no-op (and lock-free) when QEMU is not running or both are current.
 */
export async function reconcileManagement(name: string, p: Paths = pathsFor(name), o: ReconcileOptions = {}): Promise<ReconcileResult> {
  if (qemuPid(p) === null) return { changed: false, servicePid: null, watcherPid: null }
  const current = o.current ?? buildIdentity()
  // The common case — everything current — takes no lock and writes nothing,
  // unless a reconciliation died holding the lock: that one may owe a watcher.
  const first = survey(name, p, current)
  if (!first.serviceWork && !first.watcherWork && !abandoned(p.reconcile)) {
    return { changed: false, servicePid: first.service?.pid ?? null, watcherPid: first.watcher?.pid ?? null }
  }
  const got = await acquire(p.reconcile, o.lockWaitMs ?? 60_000)
  if ("busy" in got) {
    return { changed: false, ...pids(name, p), ...(got.busy.waiting === undefined ? {} : { deferred: got.busy.waiting }) }
  }
  try {
    return await reconcileHeld(name, p, o, current, got.lock)
  } finally {
    got.lock.release()
  }
}

async function reconcileHeld(name: string, p: Paths, o: ReconcileOptions, current: string, lock: ReconcileLock): Promise<ReconcileResult> {
  // Again, now that it is ours alone: whoever held the lock before may have done it all.
  if (qemuPid(p) === null) return { changed: false, servicePid: null, watcherPid: null }
  const s = survey(name, p, current)
  const owedWatcher = lock.restoreWatcher && s.watcher === null
  if (!s.serviceWork && !s.watcherWork && !owedWatcher) return { changed: false, ...pids(name, p) }

  // The watcher's own save or stow is waited out through its shutdown; anyone
  // else's save is not interrupted at all.
  const st = s.watcher === null ? null : readWatchState(name)
  const watcherBusy = st !== null && st.pid === s.watcher?.pid && (st.state === "autosaving" || st.state === "stowing") ? st.state : null
  const saver = saverPid(name, p)
  if (watcherBusy === null && saver !== null && saver !== s.watcher?.pid) {
    return { changed: false, ...pids(name, p), deferred: "saving" }
  }

  const hadWatcher = s.watcher !== null || lock.restoreWatcher
  let changed = false
  if (s.watcher !== null && (s.serviceWork || s.watcherWork)) {
    lock.note({ restoreWatcher: true, waiting: watcherBusy ?? undefined })
    await stopWatcher(name)
    lock.note({ waiting: undefined })
    changed = true
    if (watcherRecord(name) !== null) {
      throw new ManagementError(
        "watcher-replace",
        `could not stop the watcher of "${name}" to replace it. Windows is still running; run the command again to retry`,
      )
    }
    // A stow it was finishing has quit QEMU: there is nothing left to manage.
    if (qemuPid(p) === null) {
      return { changed, ...pids(name, p), watcherPid: null, ...(watcherBusy === "stowing" ? { deferred: "stowing" as const } : {}) }
    }
    // A save started while the watcher was finishing: leave the service to the next command.
    if (saverPid(name, p) !== null) {
      await restoreWatcher(name, current, o, lock).catch(() => undefined)
      return { changed, ...pids(name, p), deferred: "saving" }
    }
  }

  if (s.serviceWork) {
    try {
      await ensureService(name, p, {
        current,
        ...(o.startService === undefined ? {} : { start: o.startService }),
        ...(o.serviceTimeoutMs === undefined ? {} : { timeoutMs: o.serviceTimeoutMs }),
      })
      changed = true
    } catch (error) {
      // The user's watcher comes back regardless; it does what it can without a service.
      if (hadWatcher) await restoreWatcher(name, current, o, lock).catch(() => undefined)
      throw new ManagementError(
        "service-replace",
        `could not start a current control service for "${name}": ${errText(error)}. ` +
          `Windows is still running; run the command again to retry (see ${resolve(p.dir, "service.log")})`,
        { cause: error },
      )
    }
  }

  if (hadWatcher && (await restoreWatcher(name, current, o, lock))) changed = true
  return { changed, ...pids(name, p) }
}

/** Start the watcher again, of this build, unless one runs or watching was turned off. Whether one was started. */
async function restoreWatcher(name: string, current: string, o: ReconcileOptions, lock: ReconcileLock): Promise<boolean> {
  if (watcherRecord(name) !== null || !effectiveConfig(name)["watch.enabled"]) {
    lock.note({ restoreWatcher: false })
    return false
  }
  const failed = (why: string, cause?: unknown): ManagementError =>
    new ManagementError(
      "watcher-replace",
      `could not restart the watcher of "${name}": ${why}. Windows is still running; ` +
        `run the command again to retry, or \`winvm watch -i ${name}\` (see ${resolve(pathsFor(name).dir, "watch.log")})`,
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
      lock.note({ restoreWatcher: false })
      return true
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw failed("it did not report this build in time")
}
