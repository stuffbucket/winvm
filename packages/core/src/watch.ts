import { spawn, spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

import type { Args } from "./args"
import { commandInstance, winvmCommandAfter } from "./args"
import { formatOffset, measureOffset, syncGuestClock } from "./clock"
import type { InstanceConfig } from "./config"
import { effectiveConfig } from "./config"
import * as finder from "./finder"
import type { Decision, SaveInfo, Settings, Timing } from "./idle"
import {
  DEFAULT_TIMING,
  DRIFT_TOLERANCE_MS,
  IdleMachine,
  autosaveName,
  savesToRotate,
} from "./idle"
import { isFrozenRunState } from "./frozen"
import {
  AUTOMATIC_ENV,
  InstanceBusy,
  leaseHolder,
  withOperation,
} from "./operation"
import { buildIdentity } from "./identity"
import type { Paths } from "./paths"
import { cliArgv, instanceDir, managedEnv, pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as qmp from "./qmp"
import * as saves from "./saves"
import { spawnText } from "./shell"

export interface WatchPaths {
  readonly pid: string
  readonly state: string
  readonly log: string
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

export function touchActivity(name: string): void {
  try {
    writeFileSync(watchPathsFor(name).activity, `${new Date().toISOString()}\n`)
  } catch {}
}

export async function whileActive<T>(
  name: string,
  work: Promise<T>,
): Promise<T> {
  touchActivity(name)
  const timer = setInterval(() => {
    touchActivity(name)
  }, 15_000)
  try {
    return await work
  } finally {
    clearInterval(timer)
    touchActivity(name)
  }
}

export interface WatchState {
  readonly pid: number
  readonly build?: string
  readonly cli?: string
  readonly startedAt: string
  readonly lastActivityAt: string
  readonly idleSeconds: number
  readonly autosave: {
    readonly enabled: boolean
    readonly idleMinutes: number
    readonly keep: number
    readonly lastAt?: string
  }
  readonly stow: {
    readonly enabled: boolean
    readonly idleMinutes: number
    readonly lastAt?: string
  }
  readonly state: "watching" | "autosaving" | "stowing" | "stopped"
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${String(process.pid)}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, path)
}

export function readWatchState(name: string): WatchState | null {
  try {
    return JSON.parse(
      readFileSync(watchPathsFor(name).state, "utf8"),
    ) as WatchState
  } catch {
    return null
  }
}

export const CLI = {
  stow: (instance: string): readonly string[] => ["stow", "-i", instance],
} as const

export type SaveOutcome = "saved" | "busy" | "failed"

export interface Actions {
  save(name: string): Promise<SaveOutcome>
  deleteSaves(names: readonly string[]): Promise<boolean>
  stow(): Promise<boolean>
  syncClock(): Promise<string>
  drift(): Promise<number | null>
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

const isBusy = (e: unknown): boolean => e instanceof InstanceBusy

const automatically = async <T>(
  instance: string,
  run: () => T | Promise<T>,
): Promise<T> => await withOperation(instance, "save", run, { automatic: true })

async function runWinvm(
  argv: readonly string[],
  log: (s: string) => void,
): Promise<boolean> {
  log(`run: winvm ${argv.join(" ")}`)
  const started = Date.now()
  const code = await new Promise<number>((res) => {
    const child = spawn(process.execPath, [...cliArgv(...argv)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...managedEnv(), [AUTOMATIC_ENV]: "1" },
    })
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
    child.on("error", () => {
      res(127)
    })
    child.on("exit", (c) => {
      res(c ?? 1)
    })
  })
  log(
    `  -> exit ${String(code)} after ${String(Math.round((Date.now() - started) / 1000))} s`,
  )
  return code === 0
}

async function syncIfRunning(p: Paths): Promise<string> {
  try {
    if ((await qmp.status(p.qmp)) !== "running")
      return "skipped: guest is paused"
    const c = await syncGuestClock(p)
    return `was ${formatOffset(c.beforeOffsetMs)}, now ${formatOffset(c.afterOffsetMs)}`
  } catch (error) {
    return `failed: ${errText(error)}`
  }
}

export function realActions(
  instance: string,
  p: Paths,
  log: (s: string) => void,
): Actions {
  let ready = false
  return {
    save: async (name) => {
      try {
        const state = await qmp.status(p.qmp)
        if (!ready && state === "running") {
          ready = await qga.waitReady(p.qga, 120_000)
          if (!ready) {
            log(
              "autosave: guest is not ready (still starting?) — skipping this round",
            )
            return "busy"
          }
        }
        const r = await automatically(
          instance,
          async () => await saves.createSave(instance, { name, kind: "auto" }),
        )
        const m = r.manifest
        log(
          `autosave: saved "${m.name}" in ${String(Math.round((m.saveMs ?? 0) / 100) / 10)} s, ` +
            `${saves.formatBytes(m.bytes)} on disk`,
        )
        if (r.resumed) {
          if (await qga.waitResponsive(p.qga, 120_000))
            log(`clock: after the save — ${await syncIfRunning(p)}`)
          else
            log(
              "clock: the guest agent did not answer after the save; clock not synced",
            )
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
        await automatically(instance, () => {
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

function currentSaves(instance: string): readonly SaveInfo[] {
  return saves.listSaves(instance).flatMap((l) =>
    l.manifest === null
      ? []
      : [
          {
            name: l.name,
            kind: l.manifest.kind,
            createdAt: l.manifest.createdAt,
          },
        ],
  )
}

const newestOfKind = (
  list: readonly SaveInfo[],
  kind: string,
): string | undefined =>
  list
    .filter((s) => s.kind === kind)
    .map((s) => s.createdAt)
    .toSorted()
    .at(-1)

const leaseHeld = (instance: string): boolean => leaseHolder(instance) !== null

export function parseCpuTime(s: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(s)
  if (m === null) return null
  const [, d, h, min, sec] = m
  return (
    Number(d ?? 0) * 86_400 +
    Number(h ?? 0) * 3600 +
    Number(min) * 60 +
    Number(sec)
  )
}

export function cpuSeconds(pid: number): number | null {
  const r = spawnSync("ps", ["-o", "time=", "-p", String(pid)], {
    encoding: "utf8",
  })
  return r.status === 0 ? parseCpuTime(r.stdout) : null
}

export function vcpusOf(pid: number): number {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  })
  const m = /-smp\s+(?:cpus=)?(\d+)/.exec(r.stdout)
  return m?.[1] === undefined ? 4 : Number(m[1])
}

async function isFrozen(p: Paths): Promise<boolean> {
  try {
    const r = (await qmp.execute(p.qmp, "query-status", undefined, 5000)) as
      | { status?: unknown }
      | undefined
    return isFrozenRunState(typeof r?.status === "string" ? r.status : null)
  } catch {
    return false
  }
}

async function vncClients(p: Paths): Promise<number | null> {
  try {
    const r = (await qmp.execute(p.qmp, "query-vnc", undefined, 5000)) as
      | { clients?: unknown[] }
      | undefined
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

function isWatcherProcess(pid: number, name: string): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const r = spawnText("ps", ["-o", "command=", "-p", String(pid)])
  const rest = winvmCommandAfter(r.stdout, "watch")
  if (rest === null) return false
  if (/(?:^|\s)--(?:stop|status)(?:\s|$)/.test(rest)) return false
  return (commandInstance(rest) ?? "default") === name
}

export function watcherPid(
  name: string,
  isWatcher: (pid: number) => boolean = (pid) => isWatcherProcess(pid, name),
): number | null {
  const f = watchPathsFor(name).pid
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(f, "utf8").trim(), 10)
  } catch {
    return null
  }
  if (Number.isFinite(pid) && isWatcher(pid)) return pid
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
    }
  }
  return -1
}

function releaseLock(name: string): void {
  const f = watchPathsFor(name).pid
  try {
    if (readFileSync(f, "utf8").trim() === String(process.pid))
      rmSync(f, { force: true })
  } catch {}
}

export function ensureWatcher(name: string): number | null {
  if (!effectiveConfig(name)["watch.enabled"]) return null
  const running = watcherPid(name)
  if (running !== null) return running
  const w = watchPathsFor(name)
  try {
    if (statSync(w.log).size > 1_000_000) renameSync(w.log, `${w.log}.1`)
  } catch {}
  const log = openSync(w.log, "a")
  const child = spawn(process.execPath, [...cliArgv("watch", "-i", name)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: managedEnv(),
  })
  closeSync(log)
  child.unref()
  return child.pid ?? null
}

export function startWatcherFor(name: string, args: Args): void {
  if (args.flags.has("no-watch")) return
  const pid = ensureWatcher(name)
  if (pid !== null)
    console.log(`watcher: pid ${String(pid)} · ${watchPathsFor(name).log}`)
}

export const watchAfterRestore = (
  wasRunning: boolean,
  hadWatcher: boolean,
): boolean => !wasRunning || hadWatcher

export function rewatchAfterRestore(name: string, args: Args): () => void {
  const again = watchAfterRestore(
    qemu.isRunning(pathsFor(name)),
    watcherPid(name) !== null,
  )
  return () => {
    if (again) startWatcherFor(name, args)
  }
}

export interface WatcherRecord {
  readonly pid: number
  readonly build?: string
  readonly cli?: string
}

export function watcherRecord(
  name: string,
  isWatcher: (pid: number) => boolean = (pid) => isWatcherProcess(pid, name),
): WatcherRecord | null {
  const pid = watcherPid(name, isWatcher)
  if (pid === null) return null
  const st = readWatchState(name)
  if (st?.pid !== pid) return { pid }
  return {
    pid,
    ...(typeof st.build === "string" && st.build !== ""
      ? { build: st.build }
      : {}),
    ...(typeof st.cli === "string" && st.cli !== "" ? { cli: st.cli } : {}),
  }
}

export const watcherFreshness = (
  record: WatcherRecord,
  current: string = buildIdentity(),
): "current" | "stale" | "legacy" =>
  record.build === undefined || record.build === ""
    ? "legacy"
    : record.build === current
      ? "current"
      : "stale"

export interface StopSeams {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly isWatcher?: (pid: number) => boolean
}

export async function stopWatcher(
  name: string,
  seams: StopSeams = {},
): Promise<boolean> {
  const kill =
    seams.kill ??
    ((pid: number, signal: NodeJS.Signals): void =>
      void process.kill(pid, signal))
  const now = seams.now ?? Date.now
  const wait = seams.sleep ?? sleep
  const isWatcher =
    seams.isWatcher ?? ((p: number): boolean => isWatcherProcess(p, name))
  const pid = watcherPid(name, isWatcher)
  if (pid === null || pid === process.ppid || pid === process.pid) return false
  try {
    kill(pid, "SIGTERM")
  } catch {
    return false
  }
  const st = readWatchState(name)
  const saving =
    st?.pid === pid && (st.state === "autosaving" || st.state === "stowing")
  const deadline = now() + (saving ? 10 * 60_000 : 10_000)
  while (now() < deadline) {
    if (!isWatcher(pid)) return true
    await wait(200)
  }
  if (isWatcher(pid)) {
    try {
      kill(pid, "SIGKILL")
    } catch {}
  }
  const f = watchPathsFor(name).pid
  try {
    if (readFileSync(f, "utf8").trim() === String(pid))
      rmSync(f, { force: true })
  } catch {}
  return true
}

export interface WatchOptions {
  readonly timing?: Partial<Timing>
  readonly actions?: Actions
}

const settingsOf = (c: InstanceConfig): Settings => ({
  idleCpuPercent: c["watch.idleCpuPercent"],
  autosave: {
    enabled: c["autosave.enabled"],
    idleMinutes: c["autosave.idleMinutes"],
  },
  stow: { enabled: c["stow.enabled"], idleMinutes: c["stow.idleMinutes"] },
})

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

export async function watch(
  name: string,
  o: WatchOptions = {},
): Promise<number> {
  const p = pathsFor(name)
  const w = watchPathsFor(name)
  const timing: Timing = { ...DEFAULT_TIMING, ...o.timing }
  const log = (s: string): void => {
    console.log(`${new Date().toISOString()} [${name}] ${s}`)
  }

  if (!existsSync(p.meta)) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  const firstPid = qemu.pidOf(p)
  if (firstPid === null) {
    console.error(
      `::error::instance "${name}" is not running — nothing to watch`,
    )
    return 1
  }
  let cfg = effectiveConfig(name)
  if (!cfg["watch.enabled"]) {
    console.error(
      `::error::watching is off for "${name}" — \`winvm config -i ${name} watch.enabled=true\``,
    )
    return 1
  }
  const ephemeral = saves.isEphemeral(p)
  const startedAt = new Date().toISOString()
  const machine = new IdleMachine(Date.now(), timing)
  let state: WatchState["state"] = "watching"
  const lastAt = {
    autosave: newestOfKind(currentSaves(name), "auto"),
    stow: newestOfKind(currentSaves(name), "stow"),
  }

  const publish = (): void => {
    const s: WatchState = {
      pid: process.pid,
      build: buildIdentity(),
      ...(process.env.WINVM_CLI === undefined ||
      process.env.WINVM_CLI === ""
        ? {}
        : { cli: process.env.WINVM_CLI }),
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
    } catch {}
  }

  const other = acquireLock(name)
  if (other !== null) {
    console.error(
      other > 0
        ? `::error::instance "${name}" already has a watcher (pid ${String(other)})`
        : "::error::could not take watch.pid",
    )
    return 1
  }
  publish()

  let qemuPid = firstPid
  const actions = o.actions ?? realActions(name, p, log)
  let vcpus = vcpusOf(qemuPid)

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
  process.on("exit", () => {
    finish("exit")
  })
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (busy === null) {
        finish(sig)
        process.exit(0)
      }
      log(
        `${sig}: letting the ${state === "stowing" ? "stow" : "save"} in progress finish first`,
      )
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
    log(
      `rotate: keeping the newest ${String(cfg["autosave.keep"])} auto saves, deleting ${victims.join(", ")}`,
    )
    await actions.deleteSaves(victims)
  }

  const syncClock = async (reason: string): Promise<void> => {
    log(`clock: ${reason} — ${await actions.syncClock()}`)
  }

  const run = async (d: Decision): Promise<"stowed" | null> => {
    switch (d.kind) {
      case "syncClock":
        await syncClock(
          d.reason === "wake" ? "host woke from sleep" : "host clock jumped",
        )
        return null
      case "checkDrift": {
        const drift = await actions.drift()
        if (drift === null)
          log("clock: drift check got no answer from the guest agent")
        else if (Math.abs(drift) > DRIFT_TOLERANCE_MS)
          await syncClock(`guest is ${String(drift)} ms off`)
        else log(`clock: guest within ${String(drift)} ms`)
        return null
      }
      case "autosave": {
        state = "autosaving"
        publish()
        const saveName = autosaveName(Date.now())
        log(
          `autosave: idle ${String(Math.round(machine.idleMs(Date.now()) / 1000))} s — saving ${saveName}`,
        )
        const outcome = await actions.save(saveName)
        if (outcome === "saved") {
          lastAt.autosave = new Date().toISOString()
          await rotate()
        } else if (outcome === "busy") {
          machine.autosaveSkipped()
        } else {
          log(
            "autosave: not retrying until the guest has been active and idle again",
          )
        }
        machine.actionDone(Date.now())
        rebaseCpu()
        state = "watching"
        return null
      }
      case "stow": {
        state = "stowing"
        publish()
        log(
          `stow: idle ${String(Math.round(machine.idleMs(Date.now()) / 1000))} s — stowing`,
        )
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

  let lastSummary = ""
  let lastTickLogAt = 0
  for (;;) {
    await sleep(timing.tickMs)
    const livePid = qemu.pidOf(p)
    if (livePid !== qemuPid) {
      if (livePid === null) {
        if (leaseHeld(name)) continue
        finder.cleanStale(name)
        finish("qemu exited")
        return 0
      }
      log(
        `qemu was replaced (pid ${String(qemuPid)} -> ${String(livePid)}; a load or a rewind) — following it`,
      )
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
    const cpu =
      nowCpu !== null && prevCpu.sec !== null && dt > 0
        ? Math.max(0, (nowCpu - prevCpu.sec) / dt / vcpus)
        : null
    prevCpu = { sec: nowCpu, at: now }

    const settings = settingsOf(cfg)
    const decisions = machine.tick(
      {
        wallMs: now,
        cpu,
        activityAtMs: activityAt(w.activity),
        vncClients: await vncClients(p),
        frozen: await isFrozen(p),
      },
      ephemeral
        ? {
            ...settings,
            autosave: { ...settings.autosave, enabled: false },
            stow: { ...settings.stow, enabled: false },
          }
        : settings,
    )
    const v = machine.lastVerdict
    const summary = `${v.quiet ? "quiet" : "active"} ${String(machine.autosaveArmed)}`
    if (
      !v.quiet ||
      summary !== lastSummary ||
      now - lastTickLogAt >= 5 * 60_000 ||
      decisions.length > 0
    ) {
      lastSummary = summary
      lastTickLogAt = now
      log(
        `tick: cpu ${cpu === null ? "?" : `${(cpu * 100).toFixed(1)}%`} ` +
          `(1-min avg ${v.cpuAvg === null ? "?" : `${(v.cpuAvg * 100).toFixed(1)}%`}) · ` +
          `${v.quiet ? "quiet" : `active: ${v.reasons.join(", ")}`} · ` +
          `idle ${String(Math.round(machine.idleMs(now) / 1000))} s` +
          (machine.autosaveArmed ? "" : " · autosave taken this idle stretch"),
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
