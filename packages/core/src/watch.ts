import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

import type { Args } from "./args"
import { formatOffset, measureOffset, syncGuestClock } from "./clock"
import type { InstanceConfig } from "./config"
import { effectiveConfig } from "./config"
import { appendEntry, readSince, START } from "./eventlog"
import * as finder from "./finder"
import { isFrozenRunState } from "./frozen"
import { buildIdentity } from "./identity"
import type { Decision, SaveInfo, Settings, Timing } from "./idle"
import {
  autosaveName,
  DEFAULT_TIMING,
  DRIFT_TOLERANCE_MS,
  IdleMachine,
  savesToRotate,
  timingFrom,
  WATCH_TIMING_ENV,
} from "./idle"
import { servingHere } from "./kept"
import { olderWatcher, stopOlderWatcher } from "./olderwatcher"
import { askService } from "./opclient"
import { InstanceBusy, leaseHolder } from "./operation"
import type { OpHandler, Performed, ServiceOp } from "./ops"
import type { Paths } from "./paths"
import { instanceDir, pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as qmp from "./qmp"
import * as saves from "./saves"
import { readService } from "./servicectl"

export interface WatchPaths {
  readonly state: string
  readonly log: string
  readonly activity: string
  readonly on: string
}

export function watchPathsFor(name: string): WatchPaths {
  const dir = instanceDir(name)
  return {
    state: resolve(dir, "watch.json"),
    log: resolve(dir, "watch.log"),
    activity: resolve(dir, "activity"),
    on: resolve(dir, "watching.json"),
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
    readonly off?: string
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

function markedQemu(name: string): number | null {
  try {
    const q = (
      JSON.parse(readFileSync(watchPathsFor(name).on, "utf8")) as {
        qemu?: unknown
      }
    ).qemu
    return typeof q === "number" ? q : null
  } catch {
    return null
  }
}

const markedFor = (name: string, pid: number | null): boolean =>
  pid !== null && markedQemu(name) === pid

function mark(name: string, pid: number): boolean {
  try {
    writeAtomic(watchPathsFor(name).on, `${JSON.stringify({ qemu: pid })}\n`)
    return true
  } catch (error) {
    logTo(name)(`could not turn the watcher on: ${errText(error)}`)
    return false
  }
}

function unmark(name: string): boolean {
  const was = markedFor(name, qemu.pidOf(pathsFor(name)))
  try {
    rmSync(watchPathsFor(name).on, { force: true })
  } catch (error) {
    logTo(name)(`could not turn the watcher off: ${errText(error)}`)
  }
  return was
}

export const watching = (name: string): boolean =>
  markedFor(name, qemu.pidOf(pathsFor(name))) || olderWatcher(name) !== null

export function watchingNow(name: string, st: WatchState): boolean {
  if (st.state === "stopped" || st.pid <= 1) return false
  if (olderWatcher(name)?.pid === st.pid) return true
  const p = pathsFor(name)
  return readService(p)?.pid === st.pid && markedFor(name, qemu.pidOf(p))
}

export function ensureWatcher(name: string): boolean {
  if (!effectiveConfig(name)["watch.enabled"]) return false
  const pid = qemu.pidOf(pathsFor(name))
  return pid !== null && mark(name, pid)
}

const watcherLine = (name: string, service: number | undefined): string =>
  `watcher: in winvm's service${service === undefined ? "" : ` (pid ${String(service)})`} · ${watchPathsFor(name).log}`

export function startWatcherFor(name: string, args: Args): void {
  if (args.flags.has("no-watch") || !ensureWatcher(name)) return
  console.log(watcherLine(name, readService(pathsFor(name))?.pid))
}

interface Run {
  readonly halt: (why: string) => void
  readonly ended: Promise<void>
}

const runs = new Map<string, Run>()
const turnedOff = new Map<string, number>()

async function stopHere(name: string): Promise<boolean> {
  turnedOff.set(name, (turnedOff.get(name) ?? 0) + 1)
  const on = unmark(name)
  const run = runs.get(name)
  run?.halt("stopped")
  await run?.ended
  const older = await stopOlderWatcher(name)
  return on || older
}

const QUIESCE_MS = 11 * 60_000

function announceQuiesce(name: string): void {
  const st = readWatchState(name)
  if (st === null || readService(pathsFor(name))?.pid !== st.pid) return
  if (st.state === "autosaving" || st.state === "stowing")
    console.error(
      `instance "${name}": waiting for the ${st.state === "autosaving" ? "autosave" : "idle stow"} in progress to finish`,
    )
}

export async function stopWatcher(
  name: string,
  quiesceMs = QUIESCE_MS,
): Promise<boolean> {
  if (runs.has(name) || servingHere(pathsFor(name))) return await stopHere(name)
  announceQuiesce(name)
  const r = await askService(name, "/watch", { on: false }, quiesceMs)
  if (r.kind === "answered" && typeof r.body?.stopped === "boolean")
    return r.body.stopped
  if (r.kind === "unavailable" || (r.kind === "answered" && r.status !== 200))
    return await stopHere(name)
  throw new Error(
    `winvm's service for "${name}" did not say its watcher had stopped (${r.kind === "unanswered" ? r.why : "no answer"}), so it may still autosave or stow; try again`,
  )
}

export async function watchViaService(name: string): Promise<boolean> {
  const r = await askService(name, "/watch", { on: true })
  if (r.kind === "answered" && typeof r.body?.watching === "boolean") {
    if (r.body.watching)
      console.log(
        watcherLine(
          name,
          typeof r.body.pid === "number" ? r.body.pid : undefined,
        ),
      )
    return r.body.watching
  }
  if (r.kind === "unanswered")
    throw new Error(
      `winvm's service for "${name}" did not answer (${r.why}), so it may or may not watch the guest; \`winvm watch -i ${name} --status\` says which`,
    )
  return false
}

export const watchAfterRestore = (
  wasRunning: boolean,
  hadWatcher: boolean,
): boolean => !wasRunning || hadWatcher

export function rewatchAfterRestore(name: string, args: Args): () => void {
  const again = watchAfterRestore(
    qemu.isRunning(pathsFor(name)),
    watching(name),
  )
  return () => {
    if (again) startWatcherFor(name, args)
  }
}

export type SaveOutcome = "saved" | "busy" | "failed"

export interface Actions {
  save(name: string): Promise<SaveOutcome>
  deleteSaves(names: readonly string[]): Promise<boolean>
  stow(): Promise<StowOutcome>
  syncClock(): Promise<string>
  drift(): Promise<number | null>
}

const stopped = (signal: AbortSignal): boolean => signal.aborted

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

export type StowOutcome = "stowed" | "refused" | "failed"

export const stowOutcome = (code: number): StowOutcome =>
  code === 0 ? "stowed" : code === saves.STOW_REFUSED ? "refused" : "failed"

const settingsOf = (c: InstanceConfig): Settings => ({
  idleCpuPercent: c["watch.idleCpuPercent"],
  autosave: {
    enabled: c["autosave.enabled"],
    idleMinutes: c["autosave.idleMinutes"],
  },
  stow: { enabled: c["stow.enabled"], idleMinutes: c["stow.idleMinutes"] },
})

export interface IdleOptions {
  readonly ephemeral: boolean
  readonly stowRefused: boolean
}

export function idleSettings(settings: Settings, o: IdleOptions): Settings {
  if (o.ephemeral)
    return {
      ...settings,
      autosave: { ...settings.autosave, enabled: false },
      stow: { ...settings.stow, enabled: false },
    }
  return o.stowRefused
    ? { ...settings, stow: { ...settings.stow, enabled: false } }
    : settings
}

const STOW_REFUSED_OFF =
  "winvm refused a stow, because this winvm could not recall a stow of the QEMU that runs Windows; idle stows are off until QEMU restarts"

export function idleState(
  cfg: InstanceConfig,
  o: IdleOptions,
  lastAt: {
    readonly autosave?: string | undefined
    readonly stow?: string | undefined
  },
): Pick<WatchState, "autosave" | "stow"> {
  const effective = idleSettings(settingsOf(cfg), o)
  return {
    autosave: {
      enabled: effective.autosave.enabled,
      idleMinutes: cfg["autosave.idleMinutes"],
      keep: cfg["autosave.keep"],
      ...(lastAt.autosave === undefined ? {} : { lastAt: lastAt.autosave }),
    },
    stow: {
      enabled: effective.stow.enabled,
      idleMinutes: cfg["stow.idleMinutes"],
      ...(lastAt.stow === undefined ? {} : { lastAt: lastAt.stow }),
      ...(o.stowRefused && !o.ephemeral && cfg["stow.enabled"]
        ? { off: STOW_REFUSED_OFF }
        : {}),
    },
  }
}

export function noteStowRefused(
  already: boolean,
  log: (s: string) => void,
): true {
  if (already) return true
  log(
    "stow: refused, because this winvm could not recall a stow of the QEMU that runs Windows; idle stows are off until QEMU restarts, and Windows keeps running",
  )
  return true
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

export type Perform = (
  op: Extract<ServiceOp, "save" | "stow">,
  handler: OpHandler,
  args: readonly string[],
) => Promise<Performed>

export interface DutyHooks {
  readonly perform: Perform
  readonly stow: OpHandler
}

function whyNot(
  instance: string,
  r: Exclude<Performed, { readonly kind: "done" }>,
): string {
  if (r.kind === "busy") return new InstanceBusy(instance, r.holder).message
  if (r.kind === "failed") return r.error
  return r.reason === "host-end"
    ? "the Mac is shutting down"
    : "winvm's service is stopping"
}

export function serviceActions(
  instance: string,
  p: Paths,
  log: (s: string) => void,
  hooks: DutyHooks,
  signal: AbortSignal = new AbortController().signal,
): Actions {
  let ready = false
  return {
    save: async (name) => {
      try {
        const state = await qmp.status(p.qmp)
        if (!ready && state === "running") {
          ready = await qga.waitReady(p.qga, 120_000, { signal })
          if (!ready) {
            log(
              "autosave: guest is not ready (still starting?) — skipping this round",
            )
            return "busy"
          }
        }
      } catch (error) {
        log(`autosave: failed: ${errText(error)}`)
        return "failed"
      }
      if (stopped(signal)) return "busy"
      const made: { result: saves.CreateResult | null } = { result: null }
      const r = await hooks.perform(
        "save",
        {
          cancel: "cooperative",
          hostEnd: "cancel",
          run: async () => {
            made.result = await saves.createSave(instance, {
              name,
              kind: "auto",
            })
            return 0
          },
        },
        [],
      )
      if (r.kind === "busy" || r.kind === "closed") {
        log(`autosave: ${whyNot(instance, r)} — skipping this round`)
        return "busy"
      }
      if (r.kind === "failed" || made.result === null) {
        log(
          `autosave: failed: ${r.kind === "failed" ? r.error : `exit ${String(r.code)}`}`,
        )
        return "failed"
      }
      const m = made.result.manifest
      log(
        `autosave: saved "${m.name}" in ${String(Math.round((m.saveMs ?? 0) / 100) / 10)} s, ` +
          `${saves.formatBytes(m.bytes)} on disk`,
      )
      if (!made.result.resumed) return "saved"
      if (await qga.waitResponsive(p.qga, 120_000, { signal }))
        log(`clock: after the save — ${await syncIfRunning(p)}`)
      else if (!stopped(signal))
        log(
          "clock: the guest agent did not answer after the save; clock not synced",
        )
      return "saved"
    },
    deleteSaves: async (names) => {
      if (names.length === 0) return true
      const r = await hooks.perform(
        "save",
        {
          cancel: "never",
          run: async () => {
            for (const n of names) saves.removeSave(instance, n)
            return await Promise.resolve(0)
          },
        },
        [],
      )
      if (r.kind === "done") return true
      log(`rotate: ${whyNot(instance, r)} — will rotate after the next save`)
      return false
    },
    stow: async () => {
      log("run: stow, as winvm's own op in its service")
      const started = Date.now()
      const r = await hooks.perform("stow", hooks.stow, [])
      if ((r.kind === "done" || r.kind === "failed") && r.id !== undefined)
        relay(instance, r.id, log)
      log(
        `  -> ${r.kind === "done" ? `exit ${String(r.code)}` : whyNot(instance, r)} after ${String(Math.round((Date.now() - started) / 1000))} s`,
      )
      return stowOutcome(r.kind === "done" ? r.code : 1)
    },
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

const RELAYED_LINES = 20

function relay(instance: string, id: string, log: (s: string) => void): void {
  const mine = readSince(instance, START).entries.filter(
    (e) => e.kind === "op" && e.id === id,
  )
  const lines = mine
    .flatMap((e) => (e.kind === "op" && e.phase === "output" ? [e.text] : []))
    .join("")
    .split("\n")
    .filter((l) => l.trim() !== "")
  for (const l of lines.slice(0, RELAYED_LINES)) log(`  | ${l}`)
  if (lines.length > RELAYED_LINES) log("  | (further output not logged)")
  if (
    mine.some((e) => e.kind === "op" && e.phase === "end" && e.remount === true)
  )
    log(
      `the guest's drives were taken down and wait to be mounted again in your session — \`winvm files mount -i ${instance}\``,
    )
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

function cpuSeconds(pid: number): number | null {
  const r = spawnSync("ps", ["-o", "time=", "-p", String(pid)], {
    encoding: "utf8",
  })
  return r.status === 0 ? parseCpuTime(r.stdout) : null
}

function vcpusOf(pid: number): number {
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

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((r) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      r()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

function logTo(name: string): (s: string) => void {
  const file = watchPathsFor(name).log
  return (s) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} [${name}] ${s}\n`)
    } catch {}
  }
}

const LOG_MAX_BYTES = 1_000_000

function rotateLog(name: string): void {
  const file = watchPathsFor(name).log
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
  } catch {}
}

export interface WatchOptions {
  readonly timing?: Partial<Timing>
  readonly actions?: Actions
}

async function watchQemu(
  name: string,
  firstPid: number,
  actions: Actions,
  timing: Timing,
  signal: AbortSignal,
): Promise<void> {
  const p = pathsFor(name)
  const w = watchPathsFor(name)
  const log = logTo(name)
  let cfg = effectiveConfig(name)
  const ephemeral = saves.isEphemeral(p)
  const startedAt = new Date().toISOString()
  const machine = new IdleMachine(Date.now(), timing)
  let state: WatchState["state"] = "watching"
  let stowRefused = false
  const lastAt = {
    autosave: newestOfKind(currentSaves(name), "auto"),
    stow: newestOfKind(currentSaves(name), "stow"),
  }

  const publish = (): void => {
    const s: WatchState = {
      pid: process.pid,
      build: buildIdentity(),
      ...(process.env.WINVM_CLI === undefined || process.env.WINVM_CLI === ""
        ? {}
        : { cli: process.env.WINVM_CLI }),
      startedAt,
      lastActivityAt: new Date(machine.idleSinceMs).toISOString(),
      idleSeconds: Math.round(machine.idleMs(Date.now()) / 1000),
      ...idleState(cfg, { ephemeral, stowRefused }, lastAt),
      state,
    }
    try {
      writeAtomic(w.state, `${JSON.stringify(s, null, 2)}\n`)
    } catch {}
  }
  const finish = (why: string): void => {
    state = "stopped"
    publish()
    log(`watcher stopped: ${why}`)
  }

  let qemuPid = firstPid
  let vcpus = vcpusOf(qemuPid)
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
        const outcome = await actions.stow()
        if (outcome === "stowed") {
          lastAt.stow = new Date().toISOString()
          return "stowed"
        }
        if (outcome === "refused")
          stowRefused = noteStowRefused(stowRefused, log)
        else log("stow: failed; back to watching")
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
    await pause(timing.tickMs, signal)
    if (signal.aborted) {
      finish(String(signal.reason))
      return
    }
    const livePid = qemu.pidOf(p)
    if (livePid !== qemuPid) {
      if (livePid === null) {
        if (leaseHeld(name)) continue
        finder.cleanStale(name)
        finish("qemu exited")
        return
      }
      log(
        `qemu was replaced (pid ${String(qemuPid)} -> ${String(livePid)}; a load or a rewind) — following it`,
      )
      if (markedQemu(name) === qemuPid) mark(name, livePid)
      qemuPid = livePid
      vcpus = vcpusOf(livePid)
      stowRefused = false
      machine.restarted(Date.now())
      rebaseCpu()
      publish()
      continue
    }
    cfg = effectiveConfig(name)
    if (!cfg["watch.enabled"]) {
      unmark(name)
      finish("watch.enabled is false")
      return
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
      idleSettings(settings, { ephemeral, stowRefused }),
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
      if (stopped(signal)) break
      if ((await run(d)) === "stowed") {
        finish("stowed")
        return
      }
    }
    publish()
  }
}

export interface Duties {
  check(): void
  halt(why: string): Promise<void>
}

export function watchDuties(
  name: string,
  hooks: DutyHooks,
  o: WatchOptions = {},
): Duties {
  const p = pathsFor(name)
  const log = logTo(name)
  const timing: Timing = {
    ...DEFAULT_TIMING,
    ...timingFrom(process.env[WATCH_TIMING_ENV]),
    ...o.timing,
  }
  let halted = false
  let draining = false
  let current: Run | null = null

  const takeOver = async (older: number): Promise<void> => {
    const offs = turnedOff.get(name) ?? 0
    if (!(await stopOlderWatcher(name)) || halted) return
    if ((turnedOff.get(name) ?? 0) !== offs || !ensureWatcher(name)) return
    log(
      `an older winvm's watcher (pid ${String(older)}) has stopped; winvm's service watches "${name}" from now on`,
    )
    appendEntry(name, {
      kind: "service",
      what: "watcher taken over",
      pid: older,
    })
  }

  const begin = (pid: number): void => {
    rotateLog(name)
    const controller = new AbortController()
    const run: Run = {
      halt: (why) => {
        controller.abort(why)
      },
      ended: watchQemu(
        name,
        pid,
        o.actions ?? serviceActions(name, p, log, hooks, controller.signal),
        timing,
        controller.signal,
      )
        .catch((error: unknown) => {
          log(`watcher stopped: ${errText(error)}`)
        })
        .finally(() => {
          current = null
          runs.delete(name)
        }),
    }
    current = run
    runs.set(name, run)
  }

  return {
    check: () => {
      if (halted) return
      const older = draining ? null : olderWatcher(name)
      if (older !== null) {
        draining = true
        void takeOver(older.pid)
          .catch((error: unknown) => {
            log(
              `could not take over from an older winvm's watcher: ${errText(error)}`,
            )
          })
          .finally(() => {
            draining = false
          })
      }
      if (current !== null) {
        if (markedQemu(name) === null) current.halt("stopped")
        return
      }
      if (draining) return
      const pid = qemu.pidOf(p)
      if (pid === null) return
      if (markedFor(name, pid) && effectiveConfig(name)["watch.enabled"])
        begin(pid)
    },
    halt: async (why) => {
      halted = true
      const run = current
      run?.halt(why)
      await run?.ended
    },
  }
}
