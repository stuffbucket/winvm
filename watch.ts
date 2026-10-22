/**
 * The per-instance watcher: notices when a guest is idle and saves it, stows it
 * after longer, and keeps its clock honest across host sleep.
 *
 *   winvm watch [-i name]        run in the foreground (what `start` launches, detached)
 *   winvm watch --stop           end it
 *
 * One process per instance, guarded by `watch.pid` (taken with O_EXCL, and
 * recognised as stale when its process is gone). It exits when QEMU does.
 *
 * The decisions are in idle.ts and are pure; this file only samples the world,
 * runs what was decided, and reports through two files in the instance dir:
 *
 *   watch.json   current state, rewritten atomically every tick (read by `status`/UI)
 *   watch.log    a timeline, one line per tick and per action
 *
 * ## Saving is someone else's command
 *
 * The watcher never saves anything itself: it runs `winvm save` / `winvm stow`
 * as subprocesses, so a save from here is exactly a save from the shell. The
 * argv for those lives in CLI below and nowhere else.
 */
import { spawn, spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

import type { InstanceConfig } from "./config"
import { effectiveConfig } from "./config"
import type { Decision, SaveInfo, Settings, Timing } from "./idle"
import { DEFAULT_TIMING, DRIFT_TOLERANCE_MS, IdleMachine, autosaveName, savesToRotate } from "./idle"
import type { Paths } from "./paths"
import { home, instanceDir, pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as qmp from "./qmp"

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
// Saves (read-only here; written by `winvm save`)

export const savesDir = (instance: string): string => resolve(home(), "saves", instance)

export function listSaves(instance: string): readonly SaveInfo[] {
  const dir = savesDir(instance)
  if (!existsSync(dir)) return []
  const out: SaveInfo[] = []
  for (const entry of readdirSync(dir)) {
    try {
      const m = JSON.parse(readFileSync(resolve(dir, entry, "manifest.json"), "utf8")) as Partial<SaveInfo>
      if (typeof m.name === "string" && typeof m.kind === "string" && typeof m.createdAt === "string") {
        out.push({ name: m.name, kind: m.kind, createdAt: m.createdAt })
      }
    } catch {
      // A save being written has no manifest yet; skip it.
    }
  }
  return out
}

const newestOfKind = (saves: readonly SaveInfo[], kind: string): string | undefined =>
  saves
    .filter((s) => s.kind === kind)
    .map((s) => s.createdAt)
    .toSorted()
    .at(-1)

// ---------------------------------------------------------------------------
// The commands the watcher drives. THE ARGV LIVES HERE AND NOWHERE ELSE.

const WINVM = resolve(import.meta.dir, "winvm.ts")

export const CLI = {
  save: (instance: string, name: string): readonly string[] => ["save", name, "--kind", "auto", "-i", instance],
  deleteSave: (instance: string, name: string): readonly string[] => ["save", name, "--delete", "-i", instance],
  stow: (instance: string): readonly string[] => ["stow", "-i", instance],
} as const

/**
 * Bring the guest clock back to the host's. Delegates to clock.ts's
 * `syncGuestClock`, loaded dynamically so this file builds before that module
 * exists. THIS IS THE ONE PLACE THE CALL IS MADE.
 */
async function syncGuestClockOnce(p: Paths): Promise<string> {
  const specifier = "./clock.ts"
  let mod: { syncGuestClock?: (p: Paths) => Promise<unknown> }
  try {
    mod = (await import(specifier)) as typeof mod
  } catch {
    return "skipped: clock.ts not available"
  }
  if (typeof mod.syncGuestClock !== "function") return "skipped: clock.ts has no syncGuestClock"
  const r = await mod.syncGuestClock(p)
  return r === undefined ? "synced" : `synced: ${JSON.stringify(r)}`
}

export interface Actions {
  save(name: string): Promise<boolean>
  deleteSave(name: string): Promise<boolean>
  stow(): Promise<boolean>
  syncClock(): Promise<string>
  /** Guest clock minus host clock, in ms; null if the agent did not answer. */
  drift(): Promise<number | null>
}

async function runWinvm(argv: readonly string[], log: (s: string) => void): Promise<boolean> {
  log(`run: winvm ${argv.join(" ")}`)
  const started = Date.now()
  const code = await new Promise<number>((res) => {
    const child = spawn(process.execPath, [WINVM, ...argv], { stdio: ["ignore", "pipe", "pipe"], env: process.env })
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

export function realActions(instance: string, p: Paths, log: (s: string) => void): Actions {
  return {
    save: async (name) => await runWinvm(CLI.save(instance, name), log),
    deleteSave: async (name) => await runWinvm(CLI.deleteSave(instance, name), log),
    stow: async () => await runWinvm(CLI.stow(instance), log),
    syncClock: async () => await syncGuestClockOnce(p),
    drift: async () => await guestDriftMs(p),
  }
}

/**
 * Stand-ins for testing the watcher before the save commands exist, or without
 * waiting on real saves: a "save" writes only a manifest (no machine state —
 * nothing can be loaded from it), and "stow" is a plain `winvm stop`.
 */
export function stubActions(instance: string, p: Paths, log: (s: string) => void): Actions {
  return {
    save: async (name) => {
      const dir = resolve(savesDir(instance), name)
      mkdirSync(dir, { recursive: true })
      const manifest = {
        name,
        instance,
        kind: "auto",
        createdAt: new Date().toISOString(),
        bytes: 0,
        compat: "stub",
        image: "stub",
      }
      writeFileSync(resolve(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      log(`stub: would run winvm ${CLI.save(instance, name).join(" ")} — wrote a manifest only`)
      return true
    },
    deleteSave: async (name) => {
      log(`stub: would run winvm ${CLI.deleteSave(instance, name).join(" ")}`)
      rmSync(resolve(savesDir(instance), name), { recursive: true, force: true })
      return true
    },
    stow: async () => {
      log(`stub: would run winvm ${CLI.stow(instance).join(" ")} — running winvm stop instead`)
      return await runWinvm(["stop", "-i", instance], log)
    },
    syncClock: async () => await syncGuestClockOnce(p),
    drift: async () => await guestDriftMs(p),
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

async function vncClients(p: Paths): Promise<number | null> {
  try {
    const r = (await qmp.query(p.qmp, "query-vnc", undefined, 5000)) as { clients?: unknown[] } | undefined
    return Array.isArray(r?.clients) ? r.clients.length : 0
  } catch {
    return null
  }
}

/**
 * Guest clock minus host clock, via the agent's `guest-get-time` — a native
 * call, no PowerShell, a few ms. The round trip is halved off.
 *
 * TWO CLOCKS COUNT AS RIGHT. The guest runs with `-rtc base=localtime` and the
 * answer file's TimeZone is UTC, so out of the box Windows shows the host's
 * local wall time while its own "UTC" is off by the host's UTC offset
 * (measured: -25200 s here, PDT). Whether a sync keeps that convention or
 * moves the guest to true UTC is clock.ts's call; drift is measured against
 * whichever of the two the guest is nearer, so either convention reads as ~0.
 */
export async function guestDriftMs(p: Paths): Promise<number | null> {
  try {
    const before = Date.now()
    const r = await qga.call(p.qga, { execute: "guest-get-time" }, 5000)
    const after = Date.now()
    const ns = r["return"]
    if (typeof ns !== "number") return null
    const host = (before + after) / 2
    const utc = ns / 1e6 - host
    const local = utc + new Date(host).getTimezoneOffset() * 60_000
    return Math.round(Math.abs(local) < Math.abs(utc) ? local : utc)
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
  const child = spawn(process.execPath, [WINVM, "watch", "-i", name], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  })
  closeSync(log)
  child.unref()
  return child.pid ?? null
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
  readonly stub?: boolean
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
  const qemuPid = qemu.pidOf(p)
  if (qemuPid === null) {
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

  const actions = o.actions ?? (o.stub === true ? stubActions(name, p, log) : realActions(name, p, log))
  const startedAt = new Date().toISOString()
  const machine = new IdleMachine(Date.now(), timing)
  const vcpus = vcpusOf(qemuPid)
  let state: WatchState["state"] = "watching"
  let cfg = effectiveConfig(name)
  const lastAt = { autosave: newestOfKind(listSaves(name), "auto"), stow: newestOfKind(listSaves(name), "stow") }

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
      `idle below ${String(cfg["watch.idleCpuPercent"])}% cpu${o.stub === true ? " · STUB ACTIONS" : ""}`,
  )
  publish()

  let prevCpu = { sec: cpuSeconds(qemuPid), at: Date.now() }
  const rebaseCpu = (): void => {
    prevCpu = { sec: cpuSeconds(qemuPid), at: Date.now() }
  }

  const rotate = async (): Promise<void> => {
    for (const victim of savesToRotate(listSaves(name), cfg["autosave.keep"])) {
      log(`rotate: deleting ${victim}`)
      await actions.deleteSave(victim)
    }
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
        const ok = await actions.save(saveName)
        if (ok) {
          lastAt.autosave = new Date().toISOString()
          await rotate()
        } else {
          log("autosave: failed; not retrying until the guest has been active and idle again")
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
    if (qemu.pidOf(p) !== qemuPid) {
      finish("qemu exited")
      return 0
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

    const decisions = machine.tick(
      { wallMs: now, cpu, activityAtMs: activityAt(w.activity), vncClients: await vncClients(p) },
      settingsOf(cfg),
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
