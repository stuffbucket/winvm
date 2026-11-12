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
 *   1. a running watcher is stopped first, through its own save-aware shutdown,
 *      when the service under it is to be replaced or it is stale itself;
 *   2. a stale service is stopped and a current one started and confirmed
 *      answering — or, when the service is merely missing, one is started with
 *      the watcher left running;
 *   3. the watcher is started again, of this build — only if one was running
 *      before, and watching is still enabled.
 *
 * ## Which generations are replaced
 *
 * A record of this build is reused, whichever path started it. One with no
 * build (from before builds were recorded) is replaced. One of another build
 * started from this same CLI path is an update in place, and is replaced. One
 * of another build started from ANOTHER path is another install's live
 * generation — the app's bundled CLI and a source checkout, say — and is left
 * alone, service and watcher both: replacing it would only have the other
 * install replace it back, cutting off whatever each was doing.
 *
 * ## What it never does
 *
 * It never signals QEMU, swtpm or virtiofsd, and calls none of the teardown
 * helpers that do (qemu.stopSidecars, finder.cleanStale). QEMU's pidfile is
 * only read. The only processes signalled are the ones service.ts and watch.ts
 * vouch for, by their command lines, as this instance's service and watcher.
 *
 * It never interrupts a save: while a manual save holds the instance it
 * returns `deferred: "saving"` and touches nothing, and the next command
 * retries once the save is done. A watcher's own autosave or stow is either
 * waited out through the watcher's graceful shutdown (`start`), or — for the
 * automatic repair before any other command, which must answer promptly —
 * deferred without a signal (`waitForBusyWatcher: false`). Everything from
 * stopping a watcher to starting it again happens under the save lock, so no
 * save or load can start in between and leave the restored machine without
 * the watcher it had.
 *
 * It never runs inside the processes it manages: they are started with
 * WINVM_NO_RECONCILE=1 (paths.managedEnv), and `serve` and `watch` are not
 * verbs it runs before (shouldReconcileVerb).
 *
 * ## One at a time
 *
 * Callers are serialized by `reconcile.lock` in the instance directory, taken
 * atomically (a complete file linked into place, so never seen half-written)
 * and naming its holder by pid AND process start time (read with `ps` in the C
 * locale and UTC, so every caller reads it alike), so a pid reused after a
 * crash does not hold it forever. Whoever takes the lock looks at the records
 * again before doing anything: the caller it waited behind has usually done
 * the work already. While the holder waits on a watcher's autosave or stow it
 * says so in the lock, and other callers return `deferred` at once rather than
 * queue behind it. Waiting is bounded: a lock that cannot be read, created or
 * taken over is a "reconcile-lock" ManagementError, never a spin.
 *
 * ## A watcher owed
 *
 * Before a watcher is stopped, `watch.owed` records that one is owed to this
 * QEMU. It is a file of its own, not part of the lock, so it outlives a holder
 * killed part-way (the app's status call has a deadline) or one whose restart
 * failed, and no change of lock holder can lose it. Whoever next holds the lock
 * pays it — starts the watcher — or forgives it: once a current watcher is
 * running anyway (so a later `watch --stop` stays stopped), or once that QEMU
 * has gone (the next `start` decides about watching for itself).
 *
 * ## When it fails
 *
 * A service or watcher that cannot be replaced is a ManagementError, typed by
 * which, and always retryable: QEMU is still running, the stale record is gone
 * (not reported as a healthy service), and the next command tries again. A
 * service that keeps failing to start leaves a current watcher running
 * untouched rather than cycling it on every attempt.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { effectiveConfig } from "./config"
import { savingPath } from "./frozen"
import { buildIdentity } from "./identity"
import { NO_RECONCILE, cliEntry, pathsFor, type Paths } from "./paths"
import * as saves from "./saves"
import { ensureService, readService, type ServiceInfo } from "./service"
import { ensureWatcher, readWatchState, stopWatcher, watchPathsFor, watcherFreshness, watcherRecord, type WatcherRecord } from "./watch"

/**
 * Which management process could not be replaced, or "reconcile-lock" when
 * reconciliation could not even serialize itself (its lock file unreadable,
 * uncreatable, or stuck; or the save lock unusable): nothing was stopped then.
 */
export type ManagementFailureKind = "service-replace" | "watcher-replace" | "reconcile-lock"

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
  /**
   * Whether to wait out a watcher's autosave or stow (its graceful shutdown,
   * up to ten minutes) when it must be replaced. Default true, for `start`.
   * The automatic repair before every other command passes false: it returns
   * `deferred` at once, without signalling the watcher.
   */
  readonly waitForBusyWatcher?: boolean
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
 * already running); `mcp` and `cua` (servers other apps launch); and host-wide
 * verbs.
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

/**
 * The line the CLI prints after a reconciliation that replaced something, or
 * null for none — including when QEMU is no longer running by now, so it never
 * claims Windows kept running when it did not.
 */
export function reconcileNote(name: string, r: ReconcileResult, p: Paths = pathsFor(name)): string | null {
  if (!r.changed || r.deferred !== undefined || qemuPid(p) === null) return null
  return `note: "${name}"'s control service and watcher now run this build; Windows kept running`
}

// ---------------------------------------------------------------------------
// Processes

/**
 * `ps`, always in the C locale and UTC: its `lstart` is local time in the
 * caller's locale, so two winvms run from shells with different TZ or LANG
 * would otherwise disagree about one process's start — and take a live
 * holder's lock for an abandoned one.
 */
const ps = (field: string, pid: number): string =>
  (
    spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout ??
    ""
  ).trim()

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !ps("stat", pid).startsWith("Z")
}

/** When a process started: with its pid, it names one process for good. */
function startOf(pid: number): string | null {
  const s = ps("lstart", pid)
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
      return Number.parseInt(readFileSync(resolve(saves.savesDir(name), ".lock"), "utf8").trim(), 10)
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

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// The lock

interface LockBody {
  readonly pid: number
  readonly start: string | null
  readonly token: string
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

const lockError = (file: string, why: string, cause?: unknown): ManagementError =>
  new ManagementError(
    "reconcile-lock",
    `could not take ${file}: ${why}. Nothing was stopped and Windows is still running; run the command again to retry, ` +
      "or remove that file if no other winvm is running",
    cause === undefined ? undefined : { cause },
  )

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

  private owned(): boolean {
    try {
      return parseLock(readFileSync(this.file, "utf8"))?.token === this.body.token
    } catch {
      return false
    }
  }

  /** Say what this holder is waiting out, so other callers return at once. */
  waiting(on: "autosaving" | "stowing" | null): void {
    const next: LockBody = { pid: this.body.pid, start: this.body.start, token: this.body.token, ...(on === null ? {} : { waiting: on }) }
    this.body = next
    if (!this.owned()) return
    try {
      const tmp = `${this.file}.${String(process.pid)}.${randomUUID()}.tmp`
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (error) {
      throw lockError(this.file, `it could not be updated: ${errText(error)}`, error)
    }
  }

  release(): void {
    if (this.owned()) rmSync(this.file, { force: true })
  }
}

type Acquired = { readonly lock: ReconcileLock } | { readonly busy: LockBody }

/**
 * Take the lock, waiting up to `waitMs` behind a live holder. Every retry
 * backs off and counts against that deadline: past it, a live holder is left
 * to finish ("busy"), and a lock that could be neither read nor taken over is
 * a "reconcile-lock" ManagementError rather than a spin.
 */
async function acquire(file: string, waitMs: number): Promise<Acquired> {
  ownStart ??= startOf(process.pid)
  const body: LockBody = { pid: process.pid, start: ownStart, token: randomUUID() }
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
      // Gone between the two is a release: try again. Anything else is a problem.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problem = `it cannot be read: ${errText(error)}`
      continue
    }
    const holder = parseLock(seen)
    if (holder !== null && holds(holder)) {
      if (holder.waiting !== undefined) return { busy: holder }
      live = holder
      continue
    }
    // Its holder is gone (or the pid is another process's now): take it over.
    if (!takeOver(file, seen)) problem = "it was left by a winvm that has gone, and could not be taken over"
  }
}

// ---------------------------------------------------------------------------
// A watcher owed (see the module comment). Written and removed only by the
// holder of the lock.

const owedPath = (p: Paths): string => resolve(p.dir, "watch.owed")

/** The QEMU a watcher is owed to, or null when none is owed. */
function owedTo(p: Paths): number | null {
  try {
    const q = (JSON.parse(readFileSync(owedPath(p), "utf8")) as { qemu?: unknown }).qemu
    return typeof q === "number" ? q : -1
  } catch (error) {
    // A file that is there but unreadable is owed to nobody we can name: drop it.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : -1
  }
}

function owe(p: Paths, qemu: number): void {
  const tmp = `${owedPath(p)}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ qemu })}\n`)
  renameSync(tmp, owedPath(p))
}

const forgive = (p: Paths): void => rmSync(owedPath(p), { force: true })

// ---------------------------------------------------------------------------
// What is out of date

/**
 * A record's standing against this build: reuse it ("current"), replace it
 * ("rotate": no build at all, or another build from this same CLI path), or
 * leave it to the install it belongs to ("foreign": another build from another
 * path). A record whose path is unknown is taken for this one's.
 */
type Standing = "current" | "rotate" | "foreign"

function standing(build: string | undefined, cli: string | undefined, current: string, mine: string): Standing {
  if (build === undefined || build === "") return "rotate"
  if (build === current) return "current"
  return cli !== undefined && cli !== "" && cli !== mine ? "foreign" : "rotate"
}

interface Plan {
  readonly service: ServiceInfo | null
  /** "start" a missing service, "replace" a stale one, or leave it. */
  readonly serviceAction: "none" | "start" | "replace"
  readonly watcher: WatcherRecord | null
  /** The running watcher must be replaced. */
  readonly rotateWatcher: boolean
  /** No service of ours to manage at all: another install's generation runs here. */
  readonly foreign: boolean
}

function plan(name: string, p: Paths, current: string): Plan {
  const mine = cliEntry()
  const service = readService(p)
  const watcher = watcherRecord(name)
  // A QEMU started before the control service existed has no broker socket,
  // and a service would take its monitor socket from it: leave it be.
  const broker = existsSync(p.qmpQemu)
  const serviceStanding = service === null ? null : standing(service.build, service.cli, current, mine)
  if (broker && serviceStanding === "foreign") return { service, serviceAction: "none", watcher, rotateWatcher: false, foreign: true }
  const serviceAction = !broker ? "none" : service === null ? "start" : serviceStanding === "rotate" ? "replace" : "none"
  const rotateWatcher = watcher !== null && standing(watcher.build, watcher.cli, current, mine) === "rotate"
  return { service, serviceAction, watcher, rotateWatcher, foreign: false }
}

const hasWork = (pl: Plan): boolean => pl.serviceAction !== "none" || pl.rotateWatcher

const pids = (name: string, p: Paths): { servicePid: number | null; watcherPid: number | null } => ({
  servicePid: readService(p)?.pid ?? null,
  watcherPid: watcherRecord(name)?.pid ?? null,
})

/** The watcher's own save or stow in progress, by its watch.json — believed only when it names that watcher. */
function busyWith(name: string, w: WatcherRecord | null): "autosaving" | "stowing" | null {
  if (w === null) return null
  const st = readWatchState(name)
  return st !== null && st.pid === w.pid && (st.state === "autosaving" || st.state === "stowing") ? st.state : null
}

// ---------------------------------------------------------------------------
// Reconciling

/**
 * Bring `name`'s service and watcher up to this build, leaving QEMU running.
 * A no-op (and lock-free) when QEMU is not running, or nothing is out of date
 * and no watcher is owed.
 */
export async function reconcileManagement(name: string, p: Paths = pathsFor(name), o: ReconcileOptions = {}): Promise<ReconcileResult> {
  if (qemuPid(p) === null) return { changed: false, servicePid: null, watcherPid: null }
  const current = o.current ?? buildIdentity()
  // The common case — everything current — takes no lock and writes nothing.
  const first = plan(name, p, current)
  if (!hasWork(first) && !existsSync(owedPath(p))) {
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

/** A failure inside the save lock, carried out of it unchanged. */
class Failed {
  readonly error: ManagementError
  constructor(error: ManagementError) {
    this.error = error
  }
}

async function reconcileHeld(name: string, p: Paths, o: ReconcileOptions, current: string, lock: ReconcileLock): Promise<ReconcileResult> {
  // Again, now that it is ours alone: whoever held the lock before may have done it all.
  const qemu = qemuPid(p)
  const owed = owedTo(p)
  if (qemu === null) {
    // A watcher owed to a QEMU that has gone is owed no longer.
    forgive(p)
    return { changed: false, servicePid: null, watcherPid: null }
  }
  if (owed !== null && owed !== qemu) forgive(p)
  const pl = plan(name, p, current)
  if (pl.foreign) return { changed: false, ...pids(name, p) }
  // An owed watcher that runs, current, has been paid (a `start` or `watch`
  // brought it up): forget it, or a later deliberate `watch --stop` would be
  // undone by the next command.
  if (owed === qemu && pl.watcher !== null && !pl.rotateWatcher) forgive(p)
  const owesWatcher = owed === qemu && pl.watcher === null
  if (!hasWork(pl) && !owesWatcher) return { changed: false, ...pids(name, p) }

  // Will the running watcher have to stop? Before a service is replaced under
  // it, or when it is stale itself (after a missing service is started).
  const stopsWatcher = pl.watcher !== null && (pl.serviceAction === "replace" || pl.rotateWatcher)
  const busy = stopsWatcher ? busyWith(name, pl.watcher) : null
  // Anyone else's save is not interrupted at all.
  const saver = saverPid(name, p)
  if (busy === null && saver !== null && saver !== pl.watcher?.pid) return { changed: false, ...pids(name, p), deferred: "saving" }
  // The watcher's own: deferred without a word to it, unless this caller may wait.
  if (busy !== null && o.waitForBusyWatcher === false) return { changed: false, ...pids(name, p), deferred: busy }

  let changed = false
  let stopped = false
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
    // Its autosave or stow holds the save lock: let it finish through the
    // watcher's own shutdown (up to ten minutes), saying so in our lock.
    lock.waiting(busy)
    await stop()
    lock.waiting(null)
    // A stow it was finishing has quit QEMU: there is nothing left to manage.
    if (qemuPid(p) === null) {
      forgive(p)
      return { changed, ...pids(name, p), watcherPid: null, ...(busy === "stowing" ? { deferred: "stowing" as const } : {}) }
    }
  }

  // The rest under the save lock, as a save or load is: from stopping the
  // watcher to starting it again nothing can start a save or a load — not even
  // an older winvm that knows nothing of reconcile.lock.
  let outcome: ReconcileResult | Failed
  try {
    outcome = await saves.withLock(name, async (): Promise<ReconcileResult | Failed> => {
      try {
        if (qemuPid(p) !== qemu) {
          forgive(p)
          return { changed, ...pids(name, p) }
        }
        if (stopsWatcher && !stopped && pl.serviceAction === "replace") await stop()
        if (pl.serviceAction !== "none") {
          try {
            await ensureService(name, p, {
              current,
              ...(o.startService === undefined ? {} : { start: o.startService }),
              ...(o.serviceTimeoutMs === undefined ? {} : { timeoutMs: o.serviceTimeoutMs }),
            })
            changed = true
          } catch (error) {
            // A watcher stopped for this comes back; one left running stays untouched.
            if (stopped) await restoreWatcher(name, p, current, o).catch(() => undefined)
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
        if ((await restoreWatcher(name, p, current, o)) === "started") changed = true
        return { changed, ...pids(name, p) }
      } catch (error) {
        if (error instanceof ManagementError) return new Failed(error)
        throw error
      }
    })
  } catch (error) {
    if (/is busy: another winvm/.test(errText(error))) {
      // A save or load got there first. A watcher already stopped (above,
      // after its own save) comes back; nothing else was touched.
      if (stopped) await restoreWatcher(name, p, current, o).catch(() => undefined)
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

/**
 * Pay a watcher owed to this QEMU: start one, of this build, unless one runs
 * already or watching was turned off (either way the debt is settled).
 */
async function restoreWatcher(name: string, p: Paths, current: string, o: ReconcileOptions): Promise<"started" | "settled" | "none"> {
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
