import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { connect } from "node:net"
import { resolve } from "node:path"
import type { ClosePolicy } from "./config"
import { effectiveConfig } from "./config"
import { describeDisplay, readDisplay, runningDisplay } from "./display"
import { readSince, START } from "./eventlog"
import { frozenFrom, markedAsleep } from "./frozen"
import { type HostPoweredOff, hostPoweredOff } from "./hostoff"
import {
  type KeeperStanding,
  keeperDir,
  keeperFallback,
  keeperHello,
  keeperStanding,
  keeperUse,
  type Protection,
} from "./kept"
import { qmpCommand } from "./monitor"
import type { OperationInfo } from "./operation"
import {
  abandonedStop,
  readOperation,
  STOP_UNFINISHED,
  savingRunning,
} from "./operation"
import type { Paths } from "./paths"
import {
  home,
  instanceDir,
  listInstances,
  pathsFor,
  readImageMeta,
  readMeta,
} from "./paths"
import * as qemu from "./qemu"
import { type Management, managementOf } from "./reconcile"
import { readService } from "./servicectl"
import { spawnText } from "./shell"
import * as timemachine from "./timemachine"
import { vncPort, websocketPort } from "./vnc"

export type State =
  | "running"
  | "paused"
  | "asleep"
  | "stopped"
  | "stowed"
  | "missing"

export interface SaveInfo {
  readonly name: string
  readonly kind: string
  readonly createdAt: string
  readonly bytes: number | null
  readonly note?: string
}

export interface WatchInfo {
  readonly alive: boolean
  readonly pid: number | null
  readonly state: string
  readonly idleSeconds: number | null
  readonly lastActivityAt: string | null
  readonly autosave: {
    readonly enabled: boolean
    readonly idleMinutes: number | null
    readonly keep: number | null
    readonly lastAt: string | null
  } | null
  readonly stow: {
    readonly enabled: boolean
    readonly idleMinutes: number | null
    readonly lastAt: string | null
  } | null
}

export interface GuestInfo {
  readonly agent: "ok" | "silent"
  readonly agentVersion: string | null
  readonly os: string | null
  readonly clockOffsetMs: number | null
}

export interface InstanceStatus {
  readonly name: string
  readonly title: string | null
  readonly closePolicy: ClosePolicy
  readonly state: State
  readonly vmStatus: string | null
  readonly image: string | null
  readonly snapshotsCapable: boolean | null
  readonly pid: number | null
  readonly uptimeSeconds: number | null
  readonly cpus: number | null
  readonly memoryMiB: number | null
  readonly display: number | null
  readonly screen: string | null
  readonly vncPort: number | null
  readonly websocketPort: number | null
  readonly overlayBytes: number | null
  readonly guest: GuestInfo | null
  readonly saves: {
    readonly count: number
    readonly bytes: number
    readonly latest: SaveInfo | null
    readonly latestBaseline: SaveInfo | null
  }
  readonly watcher: WatchInfo | null
  readonly service: { readonly pid: number } | null
  readonly serviceExpected: boolean
  readonly management: Management
  readonly operation: OperationInfo | null
  readonly stopUnfinished: StopUnfinished | null
  readonly hostPoweredOff: HostPoweredOff | null
  readonly keeper: KeeperStanding | null
  readonly notes: readonly string[]
}

export interface StopUnfinished {
  readonly at: string
}

const RESTORING: ReadonlySet<string> = new Set([
  "start",
  "stop",
  "kill",
  "reset",
  "rewind",
  "load",
  "stow",
  "golden-reset",
])

export function unfinishedStop(name: string): StopUnfinished | null {
  let found: StopUnfinished | null = null
  let lastClear = ""
  for (const e of readSince(name, START).entries) {
    if (e.kind === "op" && e.phase === "end") {
      if (
        !e.ok &&
        (e.irreversibleAt !== undefined ||
          (e.operation === "stop" && e.exitCode === STOP_UNFINISHED))
      )
        found = { at: e.endedAt }
      else if (e.ok && RESTORING.has(e.operation)) {
        found = null
        lastClear = e.t
      }
    } else if (
      (e.kind === "qmp" && e.event === "SHUTDOWN") ||
      (e.kind === "disconnected" && e.reason === "qemu-closed")
    ) {
      found = null
      lastClear = e.t
    }
  }
  const killed = abandonedStop(name)
  return killed !== null && killed.at > lastClear ? killed : found
}

function hostPowerNote(name: string, off: HostPoweredOff): string {
  const again = `\`winvm start -i ${name}\` starts it again`
  if (off.cause === "qemu-gone")
    return (
      `QEMU is gone (last seen ${off.at}) without recording a shutdown, and no winvm stop or kill ended it: ` +
      "the host (a restart or logout), a crash or another tool ended it, and anything unsaved in Windows is lost; " +
      again
    )
  if (off.cause === "host-shutdown")
    return `Windows shut down cleanly when the Mac shut down at ${off.at}: winvm's keeper pressed its power button; ${again}`
  if (off.cause === "host-quit" || off.cause === "host-kill")
    return (
      `the Mac shut down at ${off.at} and Windows did not finish shutting down in time, so winvm's keeper ${off.cause === "host-quit" ? "quit" : "killed"} QEMU: ` +
      `Windows did not shut down cleanly and anything unsaved in it is lost; ${again}`
    )
  const who = off.detail === null ? "" : ` (${off.detail})`
  return (
    `the host powered Windows off at ${off.at}: QEMU was signalled${who}, ` +
    `so Windows did not shut down by itself and anything unsaved in it is lost; ${again}`
  )
}

export const savesDir = (instance: string): string =>
  resolve(home(), "saves", instance)
export const watchPath = (instance: string): string =>
  resolve(instanceDir(instance), "watch.json")

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function readSaves(instance: string): readonly SaveInfo[] {
  let names: string[]
  try {
    names = readdirSync(savesDir(instance))
  } catch {
    return []
  }
  const out: SaveInfo[] = []
  for (const dir of names) {
    const m = readJson(resolve(savesDir(instance), dir, "manifest.json"))
    if (m === null) continue
    const note = str(m.note)
    out.push({
      name: str(m.name) ?? dir,
      kind: str(m.kind) ?? "manual",
      createdAt: str(m.createdAt) ?? "",
      bytes: num(m.bytes),
      ...(note === null ? {} : { note }),
    })
  }
  return sortSaves(out)
}

export function sortSaves(saves: readonly SaveInfo[]): readonly SaveInfo[] {
  return [...saves].sort(
    (a, b) => Date.parse(b.createdAt || "0") - Date.parse(a.createdAt || "0"),
  )
}

function serviceOf(p: Paths): { pid: number } | null {
  const s = readService(p)
  return s === null ? null : { pid: s.pid }
}

const pidAlive = (pid: number | null): boolean => {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function parseWatch(
  raw: Record<string, unknown> | null,
  alive: (pid: number | null) => boolean,
): WatchInfo | null {
  if (raw === null) return null
  const pid = num(raw.pid)
  const a = rec(raw.autosave)
  const s = rec(raw.stow)
  return {
    alive: alive(pid),
    pid,
    state: str(raw.state) ?? "unknown",
    idleSeconds: num(raw.idleSeconds),
    lastActivityAt: str(raw.lastActivityAt),
    autosave:
      a !== null
        ? {
            enabled: a.enabled === true,
            idleMinutes: num(a.idleMinutes),
            keep: num(a.keep),
            lastAt: str(a.lastAt),
          }
        : null,
    stow:
      s !== null
        ? {
            enabled: s.enabled === true,
            idleMinutes: num(s.idleMinutes),
            lastAt: str(s.lastAt),
          }
        : null,
  }
}

export const readWatch = (instance: string): WatchInfo | null =>
  parseWatch(readJson(watchPath(instance)), pidAlive)

export function parseEtime(s: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(s)
  if (m === null) return null
  const [, d, h, mm, ss] = m
  return (
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(mm) * 60 +
    Number(ss)
  )
}

export function parseHardware(argv: readonly string[]): {
  cpus: number | null
  memoryMiB: number | null
} {
  let cpus: number | null = null
  let memoryMiB: number | null = null
  for (let i = 0; i < argv.length - 1; i += 1) {
    const v = argv[i + 1] ?? ""
    if (argv[i] === "-smp")
      cpus =
        Number.parseInt(v.split(",")[0]?.replace(/^cpus=/, "") ?? "", 10) ||
        null
    if (argv[i] === "-m") {
      const mm = /^(?:size=)?(\d+)([MG]?)/i.exec(v)
      if (mm !== null)
        memoryMiB = Number(mm[1]) * (mm[2]?.toUpperCase() === "G" ? 1024 : 1)
    }
  }
  return { cpus, memoryMiB }
}

const psField = (pid: number, field: string): string =>
  spawnText("ps", ["-ww", "-o", `${field}=`, "-p", String(pid)]).stdout.trim()

function hardwareFor(
  name: string,
  p: Paths,
  pid: number | null,
): Pick<InstanceStatus, "cpus" | "memoryMiB" | "screen"> {
  if (pid !== null) {
    const cmd = psField(pid, "command")
    if (cmd !== "") {
      const live = runningDisplay(pid)
      return {
        ...parseHardware(cmd.split(/\s+/)),
        screen: live === null ? null : describeDisplay(live),
      }
    }
  }
  const screen = describeDisplay(readDisplay(p))
  const meta = readMeta(name)
  if (meta === null) return { cpus: null, memoryMiB: null, screen }
  try {
    return {
      ...parseHardware(
        qemu.qemuArgs(name, p, meta, {
          installMedia: false,
          ephemeral: false,
          virtioBoot: false,
        }),
      ),
      screen,
    }
  } catch {
    return { cpus: null, memoryMiB: null, screen }
  }
}

function allocatedBytes(path: string): number | null {
  try {
    const s = statSync(path)
    return s.blocks * 512
  } catch {
    return null
  }
}

export async function probeGuest(
  sockPath: string,
  timeoutMs = 4000,
): Promise<GuestInfo> {
  const silent: GuestInfo = {
    agent: "silent",
    agentVersion: null,
    os: null,
    clockOffsetMs: null,
  }
  if (!existsSync(sockPath)) return silent
  return await new Promise((res) => {
    const sock = connect(sockPath)
    let buf = ""
    let done = false
    const finish = (g: GuestInfo): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      res(g)
    }
    const timer = setTimeout(() => {
      finish(result.agentVersion === null ? silent : result)
    }, timeoutMs)
    const syncId = Math.floor(Math.random() * 2 ** 31)
    let step = 0
    let sentAt = 0
    const result: {
      agent: "ok" | "silent"
      agentVersion: string | null
      os: string | null
      clockOffsetMs: number | null
    } = {
      agent: "silent",
      agentVersion: null,
      os: null,
      clockOffsetMs: null,
    }
    const send = (o: object): void => {
      sentAt = Date.now()
      sock.write(`${JSON.stringify(o)}\n`)
    }
    sock.on("error", () => {
      finish(silent)
    })
    sock.on("connect", () => {
      send({ execute: "guest-sync-delimited", arguments: { id: syncId } })
    })
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1").replaceAll("\xff", "")
      for (;;) {
        const nl = buf.indexOf("\n")
        if (nl < 0) return
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const ret = msg.return
        if (step === 0) {
          if (ret !== syncId) continue
          step = 1
          send({ execute: "guest-info" })
        } else if (step === 1) {
          const v = (ret as { version?: unknown } | undefined)?.version
          result.agent = "ok"
          result.agentVersion = typeof v === "string" ? v : "?"
          step = 2
          send({ execute: "guest-get-osinfo" })
        } else if (step === 2) {
          const o = rec(ret)
          if (o !== null) result.os = osLabel(o)
          step = 3
          send({ execute: "guest-get-time" })
        } else {
          const receivedAt = Date.now()
          if (typeof ret === "number")
            result.clockOffsetMs = Math.round(
              ret / 1e6 - (sentAt + receivedAt) / 2,
            )
          finish(result)
          return
        }
      }
    })
  })
}

export function osLabel(o: Record<string, unknown>): string | null {
  const build = str(o["kernel-release"])
  let pretty = str(o["pretty-name"]) ?? str(o.name)
  if (pretty !== null && build !== null && Number(build) >= 22000)
    pretty = pretty.replace(/Windows 10\b/, "Windows 11")
  if (pretty === null) return build === null ? null : `build ${build}`
  return build === null ? pretty : `${pretty} (build ${build})`
}

async function queryStatus(p: Paths): Promise<string | null> {
  try {
    const r = (await qmpCommand(p.qmp, "query-status", undefined, 2000)) as
      | { status?: unknown }
      | undefined
    return typeof r?.status === "string" ? r.status : null
  } catch {
    return null
  }
}

export function deriveState(
  running: boolean,
  vmStatus: string | null,
  saves: readonly SaveInfo[],
  asleep = false,
  saving = false,
): State {
  if (running)
    return saving ? "running" : (frozenFrom(vmStatus, asleep) ?? "running")
  return saves.some((s) => s.kind === "stow") ? "stowed" : "stopped"
}

export async function gather(
  name: string,
  deep = true,
): Promise<InstanceStatus> {
  const p = pathsFor(name)
  const meta = readMeta(name)
  const notes: string[] = []
  const saves = readSaves(name)
  const latest = saves[0] ?? null
  const latestBaseline = saves.find((s) => s.kind === "baseline") ?? null
  const savesSummary = {
    count: saves.length,
    bytes: saves.reduce((n, s) => n + (s.bytes ?? 0), 0),
    latest,
    latestBaseline,
  }
  const config = effectiveConfig(name)
  const title = config.title || null
  const closePolicy = config["viewer.closePolicy"]
  const operation = readOperation(name)

  if (meta === null) {
    return {
      name,
      title,
      closePolicy,
      state: "missing",
      vmStatus: null,
      image: null,
      snapshotsCapable: null,
      pid: null,
      uptimeSeconds: null,
      cpus: null,
      memoryMiB: null,
      display: null,
      screen: null,
      vncPort: null,
      websocketPort: null,
      overlayBytes: null,
      guest: null,
      saves: savesSummary,
      watcher: readWatch(name),
      service: null,
      serviceExpected: false,
      management: "current",
      operation,
      stopUnfinished: null,
      hostPoweredOff: null,
      keeper: null,
      notes: [`no instance "${name}" — \`winvm start -i ${name}\` creates it`],
    }
  }

  const pid = qemu.pidOf(p)
  const running = pid !== null
  const vmStatus = running ? await queryStatus(p) : null
  const saving = running && savingRunning(name)
  const state = deriveState(
    running,
    vmStatus,
    saves,
    markedAsleep(p, pid),
    saving,
  )
  const guest =
    running && deep && state === "running" && !saving
      ? await probeGuest(p.qga)
      : null
  if (running && vmStatus === null)
    notes.push("QEMU's monitor did not answer (busy with a save or load?)")
  if (guest?.agent === "silent" && state === "running")
    notes.push("the guest agent did not answer — still booting, or busy")
  const stopUnfinished = running ? unfinishedStop(name) : null
  if (stopUnfinished !== null)
    notes.push(
      `the last \`winvm stop\` (${stopUnfinished.at}) asked Windows to shut down and did not finish; ` +
        "the watcher and the guest's Finder drives are down until " +
        `\`winvm start -i ${name}\` brings them back — \`winvm kill -i ${name}\` if Windows is stuck`,
    )
  const poweredOff = running ? null : hostPoweredOff(name)
  if (poweredOff !== null) notes.push(hostPowerNote(name, poweredOff))
  const keeper =
    pid === null && operation !== null
      ? null
      : keeperStanding(pid, await keeperHello(p), keeperUse().kind)
  const unprotected = keeper === null ? null : keeperNote(name, pid, keeper)
  if (unprotected !== null) notes.push(unprotected)
  const management = managementOf(name)
  if (management === "repair")
    notes.push(
      "its control service or watcher is missing or from another build, or a guest that is gone left drives mounted — " +
        `\`winvm reconcile${name === "default" ? "" : ` -i ${name}`}\` repairs that and leaves Windows running`,
    )

  return {
    name,
    title,
    closePolicy,
    state,
    vmStatus,
    image: meta.image,
    snapshotsCapable: readImageMeta(meta.image)?.virtioBoot ?? null,
    pid,
    uptimeSeconds: pid === null ? null : parseEtime(psField(pid, "etime")),
    ...hardwareFor(name, p, pid),
    display: meta.vnc,
    vncPort: vncPort(meta.vnc),
    websocketPort: websocketPort(meta.vnc),
    overlayBytes: allocatedBytes(p.overlay),
    guest,
    saves: savesSummary,
    watcher: readWatch(name),
    service: serviceOf(p),
    serviceExpected: running && existsSync(p.qmpQemu),
    management,
    operation,
    stopUnfinished,
    hostPoweredOff: poweredOff,
    keeper,
    notes,
  }
}

function keeperNote(
  name: string,
  pid: number | null,
  k: KeeperStanding,
): string | null {
  const flag = name === "default" ? "" : ` -i ${name}`
  const fellBack = k.protection === "legacy" ? keeperFallback(name) : null
  if (fellBack !== null)
    return (
      `winvm's keeper could not start when Windows on "${name}" was started (${fellBack.error}), ` +
      `so it is not protected if the Mac shuts down; see ${resolve(keeperDir(pathsFor(name)), "keeper.log")}`
    )
  switch (k.protection) {
    case "kept":
      return null
    case "legacy":
      return (
        `Windows on "${name}" was started without winvm's keeper, so it is not protected if the Mac shuts down; ` +
        `it is from its next start — \`winvm stow${flag} && winvm start${flag}\` does that now`
      )
    case "off":
      return `WINVM_KEEPER=off: Windows on "${name}" runs without winvm's keeper, so it is not protected if the Mac shuts down`
    case "missing":
      return `this winvm has no winvm-keeper (the Mac app carries one, and \`WINVM_KEEPER=<path>\` names a build), so Windows on "${name}" is not protected if the Mac shuts down`
    case "broken":
      return pid === null
        ? `winvm's keeper (pid ${String(k.pid)}) still runs a QEMU that qemu.pid does not name — \`winvm kill${flag}\` ends it`
        : `winvm's keeper (pid ${String(k.pid)}) runs a different QEMU from the one qemu.pid names (pid ${String(pid)}) — \`winvm kill${flag}\`, then \`winvm start${flag}\``
  }
}

const KEEPER_WORDS: Readonly<Record<Protection, string>> = {
  kept: "protected",
  legacy: "not protected: started without winvm's keeper",
  broken: "confused: the keeper and qemu.pid disagree",
  off: "not protected: WINVM_KEEPER=off",
  missing: "not protected: no winvm-keeper installed",
}

function keeperRow(k: KeeperStanding): string {
  if (k.protection !== "kept") return KEEPER_WORDS[k.protection]
  return `protected by winvm-keeper ${k.version ?? "?"} (pid ${String(k.pid)})`
}

export const gatherAll = async (
  deep = false,
): Promise<readonly InstanceStatus[]> =>
  await Promise.all(
    [...listInstances()].sort().map(async (n) => await gather(n, deep)),
  )

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${String(d)}d ${String(h)}h`
  if (h > 0) return `${String(h)}h ${String(m)}m`
  if (m > 0) return `${String(m)}m ${String(s % 60)}s`
  return `${String(s)}s`
}

export function formatMemory(mib: number): string {
  return mib % 1024 === 0
    ? `${String(mib / 1024)} GiB`
    : mib >= 1024
      ? `${(mib / 1024).toFixed(1)} GiB`
      : `${String(mib)} MiB`
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${i === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0)} ${units[i] ?? "B"}`
}

export function formatAge(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "unknown time"
  const s = (now - t) / 1000
  return s < 0 ? `in ${formatDuration(-s)}` : `${formatDuration(s)} ago`
}

export function formatOffset(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 1000) return "in sync with the host (within 1 s)"
  const amount =
    abs < 60_000 ? `${(abs / 1000).toFixed(1)} s` : formatDuration(abs / 1000)
  return `guest is ${amount} ${ms > 0 ? "ahead of" : "behind"} the host`
}

const fmtSave = (s: SaveInfo, now: number): string =>
  `"${s.name}" (${s.kind}, ${formatAge(s.createdAt, now)}${s.bytes === null ? "" : `, ${formatBytes(s.bytes)}`})`

export function formatWatcher(w: WatchInfo | null, now: number): string {
  if (w === null) return "not set up"
  if (!w.alive)
    return `not running${w.state !== "stopped" ? " (left a stale watch.json)" : ""}`
  const parts = [
    w.state +
      (w.idleSeconds === null
        ? ""
        : `, guest idle ${formatDuration(w.idleSeconds)}`),
  ]
  if (w.autosave?.enabled === true) {
    const last =
      w.autosave.lastAt === null
        ? ""
        : `, last ${formatAge(w.autosave.lastAt, now)}`
    parts.push(
      `autosave after ${String(w.autosave.idleMinutes ?? "?")} min idle (keep ${String(w.autosave.keep ?? "?")}${last})`,
    )
  } else {
    parts.push("autosave off")
  }
  if (w.stow?.enabled === true) {
    const last =
      w.stow.lastAt === null ? "" : `, last ${formatAge(w.stow.lastAt, now)}`
    parts.push(
      `stow after ${String(w.stow.idleMinutes ?? "?")} min idle${last}`,
    )
  } else {
    parts.push("stow off")
  }
  return parts.join(" · ")
}

const STATE_WORDS: Record<State, string> = {
  running: "running",
  paused: "paused",
  asleep: "asleep (Windows locked, then paused; `winvm wake` wakes it)",
  stopped: "stopped",
  stowed: "stowed (stopped; `winvm start` picks up where it left off)",
  missing: "does not exist",
}

export interface Report {
  readonly title: string
  readonly rows: readonly (readonly [string, string])[]
  readonly notes: readonly string[]
}

export function statusReport(
  s: InstanceStatus,
  timeMachine: string,
  now: number,
): Report {
  const rows: [string, string][] = []
  const flag = s.name === "default" ? "" : ` -i ${s.name}`
  if (s.state === "missing")
    return {
      title: `instance "${s.name}" ${STATE_WORDS.missing}`,
      rows: [],
      notes: s.notes,
    }
  const live =
    s.state === "running" || s.state === "paused" || s.state === "asleep"
  if (live) {
    rows.push([
      "uptime",
      `${s.uptimeSeconds === null ? "?" : formatDuration(s.uptimeSeconds)} (qemu pid ${String(s.pid)})`,
    ])
    const g = s.guest
    if (g !== null) {
      rows.push([
        "guest",
        g.agent === "ok"
          ? `${g.os ?? "Windows (version unknown)"} · agent responding (qemu-ga ${g.agentVersion ?? "?"})`
          : "agent not responding",
      ])
      if (g.clockOffsetMs !== null)
        rows.push(["clock", formatOffset(g.clockOffsetMs)])
    }
  }
  const hw = [
    s.cpus === null ? null : `${String(s.cpus)} vCPU`,
    s.memoryMiB === null ? null : `${formatMemory(s.memoryMiB)} RAM`,
    s.image === null
      ? null
      : `image ${s.image}${s.snapshotsCapable === false ? " (no snapshots)" : ""}`,
  ].filter((x) => x !== null)
  rows.push(["hardware", hw.join(", ")])
  if (s.display !== null) {
    rows.push([
      "screen",
      (s.screen === null ? "" : `${s.screen}, `) +
        (live
          ? `VNC :${String(s.display)} · \`winvm open${flag}\` (Screen Sharing) or \`winvm open${flag} --web\``
          : `VNC :${String(s.display)} (when running)`),
    ])
  }
  rows.push([
    "disk",
    s.overlayBytes === null
      ? "no overlay"
      : `overlay uses ${formatBytes(s.overlayBytes)}`,
  ])
  rows.push([
    "saves",
    s.saves.count === 0
      ? "none"
      : [
          `${String(s.saves.count)} (${formatBytes(s.saves.bytes)})`,
          s.saves.latest === null
            ? null
            : `latest ${fmtSave(s.saves.latest, now)}`,
          s.saves.latestBaseline === null
            ? "no baseline"
            : `baseline ${fmtSave(s.saves.latestBaseline, now)}`,
        ]
          .filter((x) => x !== null)
          .join(" · "),
  ])
  if (live) {
    const service =
      s.service !== null
        ? `pid ${String(s.service.pid)}`
        : s.serviceExpected
          ? `missing — \`winvm start${flag}\` starts it again`
          : "none (started before the control service)"
    rows.push(["service", service])
  }
  if (s.keeper !== null) rows.push(["keeper", keeperRow(s.keeper)])
  rows.push(["watcher", formatWatcher(s.watcher, now)])
  rows.push([
    "time machine",
    timeMachine.replace(/^(ok|note)\s+Time Machine:\s*/, ""),
  ])

  const state =
    s.state === "running" && s.vmStatus !== null && s.vmStatus !== "running"
      ? `running (${s.vmStatus})`
      : STATE_WORDS[s.state]
  return {
    title: `instance "${s.name}" — ${state}`,
    rows,
    notes: [...s.notes, ...(live ? [] : [`start it: winvm start${flag}`])],
  }
}

export function formatStatus(
  s: InstanceStatus,
  timeMachine: string,
  now: number,
): string {
  const r = statusReport(s, timeMachine, now)
  const width = Math.max(0, ...r.rows.map(([k]) => k.length))
  return [
    r.title,
    ...r.rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`),
    ...r.notes.map((n) => `  note: ${n}`),
  ].join("\n")
}

export function formatTable(
  all: readonly InstanceStatus[],
  timeMachine: string,
  now: number,
): string {
  const head = ["NAME", "STATE", "UPTIME", "VNC", "DISK", "SAVES", "WATCHER"]
  const body = all.map((s) => [
    s.name,
    s.state,
    s.uptimeSeconds === null ? "-" : formatDuration(s.uptimeSeconds),
    s.display === null ? "-" : `:${String(s.display)}`,
    s.overlayBytes === null ? "-" : formatBytes(s.overlayBytes),
    s.saves.count === 0
      ? "-"
      : `${String(s.saves.count)}${s.saves.latest === null ? "" : `, ${formatAge(s.saves.latest.createdAt, now)}`}`,
    s.watcher === null
      ? "-"
      : s.watcher.alive
        ? s.watcher.state
        : "not running",
  ])
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)),
  )
  const line = (r: readonly string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd()
  return [
    line(head),
    ...body.map(line),
    "",
    timeMachine,
    "details: winvm status -i <name>",
  ].join("\n")
}

export interface StatusArgs {
  readonly instance: string | null
  readonly json: boolean
}

export async function run(a: StatusArgs): Promise<number> {
  const tm = timemachine.localSummary()
  const now = Date.now()
  const names = listInstances()
  if (a.instance === null && names.length !== 1) {
    const all = await gatherAll(false)
    if (a.json)
      console.log(JSON.stringify({ instances: all, timeMachine: tm }, null, 2))
    else if (all.length === 0)
      console.log('no instances yet — `winvm start` creates "default"')
    else console.log(formatTable(all, tm, now))
    return 0
  }
  const s = await gather(a.instance ?? names[0] ?? "default", true)
  if (a.json) console.log(JSON.stringify({ ...s, timeMachine: tm }, null, 2))
  else console.log(formatStatus(s, tm, now))
  return s.state === "missing" ? 1 : 0
}
