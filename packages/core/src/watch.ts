/**
 * The per-instance watcher: notices when a guest is idle and saves it, stows it
 * after longer, and keeps its clock honest across host sleep.
 *
 *   winvm watch [-i name]        run in the foreground (what `start` launches, detached)
 *   winvm watch --stop           end it
 *
 * One process per instance, guarded by `watch.pid` (taken with O_EXCL, and
 * recognised as stale when its process is gone).
 *
 * The decisions are in idle.ts and are pure; this file only samples the world,
 * runs what was decided, and reports through two files in the instance dir:
 *
 *   watch.json   current state, rewritten atomically every tick (read by `status`/UI)
 *   watch.log    a timeline, one line per tick and per action
 *
 * ## Saving is saves.ts's job
 *
 * An autosave is `saves.createSave(kind "auto")` under `saves.withLock`, the
 * same path as `winvm save`; a lock held by another save or load means "skip
 * this round". Stow runs `winvm stow` as a child (argv in CLI, nowhere else).
 * Rotation deletes only kind "auto" saves.
 *
 * It follows QEMU being replaced (a `load` restarts it) rather than exiting,
 * and exits once QEMU is gone with no save/load holding the instance.
 *
 * ## A paused or asleep guest is left alone
 *
 * Its CPU reads as idle, but it is not idle: the user stopped it and only the
 * user resumes it. So while the vCPUs are stopped the watcher neither
 * autosaves nor stows it (a stow would quit QEMU under a paused guest, and
 * the next `start` would bring it back running), skips the clock (it cannot
 * answer), and does not count the time as idle: the idle clock starts over
 * when it is resumed, so a guest paused for hours is not stowed the moment it
 * runs again.
 */
import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Args } from "./args"
import { formatOffset, measureOffset, syncGuestClock } from "./clock"
import type { InstanceConfig } from "./config"
import { effectiveConfig } from "./config"
import * as finder from "./finder"
import type { Decision, SaveInfo, Settings, Timing } from "./idle"
import { DEFAULT_TIMING, DRIFT_TOLERANCE_MS, IdleMachine, autosaveName, savesToRotate } from "./idle"
import { isFrozenRunState } from "./frozen"
import type { Paths } from "./paths"
import { cliArgv, instanceDir, pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as qmp from "./qmp"
import * as saves from "./saves"

// ---------------------------------------------------------------------------
// Files

export interface WatchPaths {
  readonly pid: string
  readonly state: string
  readonly log: string
  /** Touched by `winvm exec` and friends; its mtime is the last command activity. */
  readonly activity: string
}

export function watchPathsFor(name: string): WatchPaths {
  const dir = instanceDir(name)
  return {
    pid: resolve(dir, "watch.pid"),
    state: resolve(dir, "watch.json"),
    log: resolve(dir, "watch.log"),
    activity: resolve(dir, "activity"),
  }
}

/** Record command activity, so the watcher does not call a guest in use idle. */
export function touchActivity(name: string): void {
  try {
    writeFileSync(watchPathsFor(name).activity, `${new Date().toISOString()}\n`)
  } catch {
    // An instance dir that does not exist has no watcher to tell.
  }
}

/**
 * Touch now and every 15 s until `work` settles — a long `exec` is activity for
 * its whole duration, not just its first tick.
 */
export async function whileActive<T>(name: string, work: Promise<T>): Promise<T> {
  touchActivity(name)
  const timer = setInterval(() => touchActivity(name), 15_000)
  try {
    return await work
  } finally {
    clearInterval(timer)
    touchActivity(name)
  }
}

/** What `watch.json` holds. Consumed by `status` and the web UI; keep the shape stable. */
export interface WatchState {
  readonly pid: number
  readonly startedAt: string
  readonly lastActivityAt: string
  readonly idleSeconds: number
  readonly autosave: { readonly enabled: boolean; readonly idleMinutes: number; readonly keep: number; readonly lastAt?: string }
  readonly stow: { readonly enabled: boolean; readonly idleMinutes: number; readonly lastAt?: string }
  readonly state: "watching" | "autosaving" | "stowing" | "stopped"
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${String(process.pid)}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, path)
}

export function readWatchState(name: string): WatchState | null {
  try {
    return JSON.parse(readFileSync(watchPathsFor(name).state, "utf8")) as WatchState
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// What the watcher does. Saving goes through saves.ts, exactly as `winvm save`
// does; stow is the `winvm stow` command, run as a child, whose argv lives in
// CLI below and nowhere else.


export const CLI = {
  stow: (instance: string): readonly string[] => ["stow", "-i", instance],
} as const

export type SaveOutcome = "saved" | "busy" | "failed"

export interface Actions {
  save(name: string): Promise<SaveOutcome>
  /** Delete these auto saves; false if the instance was busy and nothing was deleted. */
  deleteSaves(names: readonly string[]): Promise<boolean>
  stow(): Promise<boolean>
  syncClock(): Promise<string>
  /** Guest clock minus host clock, in ms; null if the agent did not answer. */
  drift(): Promise<number | null>
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** saves.withLock's refusal: another winvm is saving or loading this instance. */
const isBusy = (e: unknown): boolean => /is busy: another winvm/.test(errText(e))

async function runWinvm(argv: readonly string[], log: (s: string) => void): Promise<boolean> {
  log(`run: winvm ${argv.join(" ")}`)
  const started = Date.now()
  const code = await new Promise<number>((res) => {
    const child = spawn(process.execPath, [...cliArgv(...argv)], { stdio: ["ignore", "pipe", "pipe"], env: process.env })
    // Bounded, so a command that prints its usage (or worse) every time cannot grow the log without limit.
    let lines = 0
    const relay = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() === "") continue
        lines += 1
        if (lines <= 20) log(`  | ${line}`)
        else if (lines === 21) log("  | (further output not logged)")
      }
    }
    child.stdout.on("data", relay)
    child.stderr.on("data", relay)
    child.on("error", () => res(127))
    child.on("exit", (c) => res(c ?? 1))
  })
  log(`  -> exit ${String(code)} after ${String(Math.round((Date.now() - started) / 1000))} s`)
  return code === 0
}

/** Clock sync, only for a guest that is running (a paused one cannot answer). */
async function syncIfRunning(p: Paths): Promise<string> {
  try {
    if ((await qmp.status(p.qmp)) !== "running") return "skipped: guest is paused"
    const c = await syncGuestClock(p)
    return `was ${formatOffset(c.beforeOffsetMs)}, now ${formatOffset(c.afterOffsetMs)}`
  } catch (error) {
    return `failed: ${errText(error)}`
  }
}

export function realActions(instance: string, p: Paths, log: (s: string) => void): Actions {
  // Confirmed once per watcher: saving a guest that is still starting wedges it
  // on restore (see qga.waitReady). `start` launches the watcher only after the
  // guest is ready, but `winvm watch` can be run by hand at any time.
  let ready = false
  return {
    save: async (name) => {
      try {
        const state = await qmp.status(p.qmp)
        if (!ready && state === "running") {
          ready = await qga.waitReady(p.qga, 120_000)
          if (!ready) {
            log("autosave: guest is not ready (still starting?) — skipping this round")
            return "busy"
          }
        }
        const r = await saves.withLock(instance, async () => await saves.createSave(instance, { name, kind: "auto" }))
        const m = r.manifest
        log(
          `autosave: saved "${m.name}" in ${String(Math.round((m.saveMs ?? 0) / 100) / 10)} s, ` +
            `${saves.formatBytes(m.bytes)} on disk`,
        )
        if (r.resumed) {
          // The guest was stopped for the save; its clock stood still with it.
          if (await qga.waitResponsive(p.qga, 120_000)) log(`clock: after the save — ${await syncIfRunning(p)}`)
          else log("clock: the guest agent did not answer after the save; clock not synced")
        }
        return "saved"
      } catch (error) {
        if (isBusy(error)) {
          log(`autosave: ${errText(error)} — skipping this round`)
          return "busy"
        }
        log(`autosave: failed: ${errText(error)}`)
        return "failed"
      }
    },
    deleteSaves: async (names) => {
      if (names.length === 0) return true
      try {
        await saves.withLock(instance, async () => {
          for (const n of names) saves.removeSave(instance, n)
        })
        return true
      } catch (error) {
        log(`rotate: ${errText(error)} — will rotate after the next save`)
        return false
      }
    },
    stow: async () => await runWinvm(CLI.stow(instance), log),
    syncClock: async () => await syncIfRunning(p),
    drift: async () => {
      try {
        if ((await qmp.status(p.qmp)) !== "running") return null
        return (await measureOffset(p)).offsetMs
      } catch {
        return null
      }
    },
  }
}

/** Saves of this instance, as rotation needs them. Unreadable ones are left alone. */
function currentSaves(instance: string): readonly SaveInfo[] {
  return saves
    .listSaves(instance)
    .flatMap((l) => (l.manifest === null ? [] : [{ name: l.name, kind: l.manifest.kind, createdAt: l.manifest.createdAt }]))
}

const newestOfKind = (list: readonly SaveInfo[], kind: string): string | undefined =>
  list
    .filter((s) => s.kind === kind)
    .map((s) => s.createdAt)
    .toSorted()
    .at(-1)

/** Whether a save or load holds the instance — during a load, QEMU is down only because it is being replaced. */
function saveLockHeld(instance: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(resolve(saves.savesDir(instance), ".lock"), "utf8").trim(), 10)
    if (!Number.isFinite(pid)) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Sampling

/** `ps` TIME — `[[dd-]hh:]mm:ss[.ss]` — in seconds. */
export function parseCpuTime(s: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(s)
  if (m === null) return null
  const [, d, h, min, sec] = m
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec)
}

/** Total CPU seconds QEMU has used — guest vCPUs plus its own overhead. */
export function cpuSeconds(pid: number): number | null {
  const r = spawnSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" })
  return r.status === 0 ? parseCpuTime(r.stdout) : null
}

/** vCPU count, read off QEMU's own command line (`-smp N`). */
export function vcpusOf(pid: number): number {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  const m = /-smp\s+(?:cpus=)?(\d+)/.exec(r.stdout)
  return m?.[1] === undefined ? 4 : Number(m[1])
}

/** Whether the vCPUs are stopped (paused or asleep); false when the monitor does not answer. */
async function isFrozen(p: Paths): Promise<boolean> {
  try {
    const r = (await qmp.execute(p.qmp, "query-status", undefined, 5000)) as { status?: unknown } | undefined
    return isFrozenRunState(typeof r?.status === "string" ? r.status : null)
  } catch {
    return false
  }
}

async function vncClients(p: Paths): Promise<number | null> {
  try {
    const r = (await qmp.execute(p.qmp, "query-vnc", undefined, 5000)) as { clients?: unknown[] } | undefined
    return Array.isArray(r?.clients) ? r.clients.length : 0
  } catch {
    return null
  }
}

function activityAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The single-instance lock

function isWatcherProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // Guard against pid reuse after a crash: the pid must still be OUR kind of process.
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  return /winvm(\.ts)?\s+watch\b/.test(r.stdout)
}

/** The live watcher's pid, or null. Removes a stale pidfile. */
export function watcherPid(name: string): number | null {
  const f = watchPathsFor(name).pid
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(f, "utf8").trim(), 10)
  } catch {
    return null
  }
  if (Number.isFinite(pid) && isWatcherProcess(pid)) return pid
  rmSync(f, { force: true })
  return null
}

function acquireLock(name: string): number | null {
  const f = watchPathsFor(name).pid
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(f, "wx")
      writeFileSync(fd, `${String(process.pid)}\n`)
      closeSync(fd)
      return null
    } catch {
      const other = watcherPid(name)
      if (other !== null) return other
      // stale — watcherPid removed it; try once more
    }
  }
  return -1
}

function releaseLock(name: string): void {
  const f = watchPathsFor(name).pid
  try {
    if (readFileSync(f, "utf8").trim() === String(process.pid)) rmSync(f, { force: true })
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Launch and stop

/**
 * Start a detached watcher for an instance unless one is running or it is
 * disabled. Logs to `watch.log`. Returns its pid, or null if none was started.
 */
export function ensureWatcher(name: string): number | null {
  if (!effectiveConfig(name)["watch.enabled"]) return null
  const running = watcherPid(name)
  if (running !== null) return running
  const w = watchPathsFor(name)
  try {
    // One generation is plenty: the log is a timeline for whoever is debugging now.
    if (statSync(w.log).size > 1_000_000) renameSync(w.log, `${w.log}.1`)
  } catch {
    // no log yet
  }
  const log = openSync(w.log, "a")
  const child = spawn(process.execPath, [...cliArgv("watch", "-i", name)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  })
  closeSync(log)
  child.unref()
  return child.pid ?? null
}

/** After a start/load/recall: launch the watcher unless `--no-watch` or `watch.enabled=false`. */
export function startWatcherFor(name: string, args: Args): void {
  if (args.flags.has("no-watch")) return
  const pid = ensureWatcher(name)
  if (pid !== null) console.log(`watcher: pid ${String(pid)} · ${watchPathsFor(name).log}`)
}

/**
 * Whether a load or rewind should start the watcher once it is done, from the
 * state before it touched QEMU.
 *
 * Restoring a STOPPED instance is a start by another route, so it gets a
 * watcher the way `start` does. Restoring a RUNNING one leaves things as they
 * were: a guest running without a watcher is one somebody chose to run that way
 * — `start --no-watch`, or `watch --stop` — and starting one behind their back
 * is how it came to be autosaved and stowed anyway. A watcher that was running
 * needs nothing either way; it follows QEMU across the restore.
 */
export const watchAfterRestore = (wasRunning: boolean, hadWatcher: boolean): boolean => !wasRunning || hadWatcher

/**
 * Sample before a load or rewind; call the result once it has succeeded. Still
 * subject to `--no-watch` and `watch.enabled`, like any start.
 */
export function rewatchAfterRestore(name: string, args: Args): () => void {
  const again = watchAfterRestore(qemu.isRunning(pathsFor(name)), watcherPid(name) !== null)
  return () => {
    if (again) startWatcherFor(name, args)
  }
}

/**
 * End an instance's watcher, if any. A no-op when called from the watcher's own
 * child — that is the watcher running `winvm stow`, which must not kill the
 * process waiting on it.
 */
export async function stopWatcher(name: string): Promise<boolean> {
  const pid = watcherPid(name)
  if (pid === null || pid === process.ppid || pid === process.pid) return false
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return false
  }
  // A watcher mid-save finishes the save before it exits (see watch()); give it
  // the time a save takes rather than killing it halfway through one.
  const st = readWatchState(name)?.state
  const deadline = Date.now() + (st === "autosaving" || st === "stowing" ? 10 * 60_000 : 10_000)
  while (Date.now() < deadline) {
    if (!isWatcherProcess(pid)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // gone
  }
  rmSync(watchPathsFor(name).pid, { force: true })
  return true
}

// ---------------------------------------------------------------------------
// The loop

export interface WatchOptions {
  readonly timing?: Partial<Timing>
  readonly actions?: Actions
}

const settingsOf = (c: InstanceConfig): Settings => ({
  idleCpuPercent: c["watch.idleCpuPercent"],
  autosave: { enabled: c["autosave.enabled"], idleMinutes: c["autosave.idleMinutes"] },
  stow: { enabled: c["stow.enabled"], idleMinutes: c["stow.idleMinutes"] },
})

const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

export async function watch(name: string, o: WatchOptions = {}): Promise<number> {
  const p = pathsFor(name)
  const w = watchPathsFor(name)
  const timing: Timing = { ...DEFAULT_TIMING, ...o.timing }
  const log = (s: string): void => console.log(`${new Date().toISOString()} [${name}] ${s}`)

  if (!existsSync(p.meta)) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  const firstPid = qemu.pidOf(p)
  if (firstPid === null) {
    console.error(`::error::instance "${name}" is not running — nothing to watch`)
    return 1
  }
  if (!effectiveConfig(name)["watch.enabled"]) {
    console.error(`::error::watching is off for "${name}" — \`winvm config -i ${name} watch.enabled=true\``)
    return 1
  }
  const other = acquireLock(name)
  if (other !== null) {
    console.error(
      other > 0 ? `::error::instance "${name}" already has a watcher (pid ${String(other)})` : "::error::could not take watch.pid",
    )
    return 1
  }

  let qemuPid = firstPid
  const actions = o.actions ?? realActions(name, p, log)
  // An --ephemeral guest's disk writes go nowhere durable, so it cannot be saved:
  // watch it for the clock only.
  const ephemeral = saves.isEphemeral(p)
  const startedAt = new Date().toISOString()
  const machine = new IdleMachine(Date.now(), timing)
  let vcpus = vcpusOf(qemuPid)
  let state: WatchState["state"] = "watching"
  let cfg = effectiveConfig(name)
  const lastAt = { autosave: newestOfKind(currentSaves(name), "auto"), stow: newestOfKind(currentSaves(name), "stow") }

  const publish = (): void => {
    const s: WatchState = {
      pid: process.pid,
      startedAt,
      lastActivityAt: new Date(machine.idleSinceMs).toISOString(),
      idleSeconds: Math.round(machine.idleMs(Date.now()) / 1000),
      autosave: {
        enabled: cfg["autosave.enabled"],
        idleMinutes: cfg["autosave.idleMinutes"],
        keep: cfg["autosave.keep"],
        ...(lastAt.autosave === undefined ? {} : { lastAt: lastAt.autosave }),
      },
      stow: {
        enabled: cfg["stow.enabled"],
        idleMinutes: cfg["stow.idleMinutes"],
        ...(lastAt.stow === undefined ? {} : { lastAt: lastAt.stow }),
      },
      state,
    }
    try {
      writeAtomic(w.state, `${JSON.stringify(s, null, 2)}\n`)
    } catch {
      // The instance dir went away (destroy); the loop will notice QEMU is gone.
    }
  }

  /** The action in flight, if any. A signal waits for it rather than abandon a save halfway. */
  let busy: Promise<unknown> | null = null
  let exiting = false
  const finish = (why: string): void => {
    if (exiting) return
    exiting = true
    state = "stopped"
    publish()
    releaseLock(name)
    log(`watcher stopped: ${why}`)
  }
  process.on("exit", () => finish("exit"))
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (busy === null) {
        finish(sig)
        process.exit(0)
      }
      log(`${sig}: letting the ${state === "stowing" ? "stow" : "save"} in progress finish first`)
      void busy.finally(() => {
        finish(sig)
        process.exit(0)
      })
    })
  }

  log(
    `watching qemu pid ${String(qemuPid)} (${String(vcpus)} vCPUs), tick ${String(timing.tickMs / 1000)} s · ` +
      `autosave ${cfg["autosave.enabled"] ? `after ${String(cfg["autosave.idleMinutes"])} min, keep ${String(cfg["autosave.keep"])}` : "off"} · ` +
      `stow ${cfg["stow.enabled"] ? `after ${String(cfg["stow.idleMinutes"])} min` : "off"} · ` +
      `idle below ${String(cfg["watch.idleCpuPercent"])}% cpu${ephemeral ? " · EPHEMERAL: clock only" : ""}`,
  )
  publish()

  let prevCpu = { sec: cpuSeconds(qemuPid), at: Date.now() }
  const rebaseCpu = (): void => {
    prevCpu = { sec: cpuSeconds(qemuPid), at: Date.now() }
  }

  const rotate = async (): Promise<void> => {
    const victims = savesToRotate(currentSaves(name), cfg["autosave.keep"])
    if (victims.length === 0) return
    log(`rotate: keeping the newest ${String(cfg["autosave.keep"])} auto saves, deleting ${victims.join(", ")}`)
    await actions.deleteSaves(victims)
  }

  const syncClock = async (reason: string): Promise<void> => {
    log(`clock: ${reason} — ${await actions.syncClock()}`)
  }

  const run = async (d: Decision): Promise<"stowed" | null> => {
    switch (d.kind) {
      case "syncClock":
        await syncClock(d.reason === "wake" ? "host woke from sleep" : "host clock jumped")
        return null
      case "checkDrift": {
        const drift = await actions.drift()
        if (drift === null) log("clock: drift check got no answer from the guest agent")
        else if (Math.abs(drift) > DRIFT_TOLERANCE_MS) await syncClock(`guest is ${String(drift)} ms off`)
        else log(`clock: guest within ${String(drift)} ms`)
        return null
      }
      case "autosave": {
        state = "autosaving"
        publish()
        const saveName = autosaveName(Date.now())
        log(`autosave: idle ${String(Math.round(machine.idleMs(Date.now()) / 1000))} s — saving ${saveName}`)
        const outcome = await actions.save(saveName)
        if (outcome === "saved") {
          lastAt.autosave = new Date().toISOString()
          await rotate()
        } else if (outcome === "busy") {
          machine.autosaveSkipped()
        } else {
          log("autosave: not retrying until the guest has been active and idle again")
        }
        machine.actionDone(Date.now())
        rebaseCpu()
        state = "watching"
        return null
      }
      case "stow": {
        state = "stowing"
        publish()
        log(`stow: idle ${String(Math.round(machine.idleMs(Date.now()) / 1000))} s — stowing`)
        if (await actions.stow()) {
          lastAt.stow = new Date().toISOString()
          return "stowed"
        }
        log("stow: failed; back to watching")
        machine.stowFailed(Date.now())
        machine.actionDone(Date.now())
        rebaseCpu()
        state = "watching"
        return null
      }
    }
  }

  // Ticks are logged while the guest is active, on every change, and otherwise every 5 min.
  let lastSummary = ""
  let lastTickLogAt = 0
  for (;;) {
    await sleep(timing.tickMs)
    const livePid = qemu.pidOf(p)
    if (livePid !== qemuPid) {
      if (livePid === null) {
        // A load quits QEMU and starts another; only a QEMU gone with nobody
        // holding the instance means it has stopped for good.
        if (saveLockHeld(name)) continue
        // Its drives in Finder would hang whatever touches them now.
        finder.cleanStale(name)
        finish("qemu exited")
        return 0
      }
      log(`qemu was replaced (pid ${String(qemuPid)} -> ${String(livePid)}; a load or a rewind) — following it`)
      qemuPid = livePid
      vcpus = vcpusOf(livePid)
      machine.restarted(Date.now())
      rebaseCpu()
      publish()
      continue
    }
    cfg = effectiveConfig(name)
    if (!cfg["watch.enabled"]) {
      finish("watch.enabled is false")
      return 0
    }

    const nowCpu = cpuSeconds(qemuPid)
    const now = Date.now()
    const dt = (now - prevCpu.at) / 1000
    const cpu = nowCpu !== null && prevCpu.sec !== null && dt > 0 ? Math.max(0, (nowCpu - prevCpu.sec) / dt / vcpus) : null
    prevCpu = { sec: nowCpu, at: now }

    const settings = settingsOf(cfg)
    const decisions = machine.tick(
      { wallMs: now, cpu, activityAtMs: activityAt(w.activity), vncClients: await vncClients(p), frozen: await isFrozen(p) },
      ephemeral
        ? { ...settings, autosave: { ...settings.autosave, enabled: false }, stow: { ...settings.stow, enabled: false } }
        : settings,
    )
    const v = machine.lastVerdict
    const summary = `${v.quiet ? "quiet" : "active"} ${String(machine.autosaveArmed)}`
    if (!v.quiet || summary !== lastSummary || now - lastTickLogAt >= 5 * 60_000 || decisions.length > 0) {
      lastSummary = summary
      lastTickLogAt = now
      log(
      `tick: cpu ${cpu === null ? "?" : `${(cpu * 100).toFixed(1)}%`} ` +
        `(1-min avg ${v.cpuAvg === null ? "?" : `${(v.cpuAvg * 100).toFixed(1)}%`}) · ` +
        `${v.quiet ? "quiet" : `active: ${v.reasons.join(", ")}`} · ` +
        `idle ${String(Math.round(machine.idleMs(now) / 1000))} s` +
        `${machine.autosaveArmed ? "" : " · autosave taken this idle stretch"}`,
      )
    }

    for (const d of decisions) {
      const action = run(d)
      busy = action
      const outcome = await action
      busy = null
      if (outcome === "stowed") {
        finish("stowed")
        return 0
      }
    }
    publish()
  }
}
