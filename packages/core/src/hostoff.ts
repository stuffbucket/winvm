import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { readSince, START } from "./eventlog"
import { pathsFor } from "./paths"

export const CHOSEN_SHUTDOWN = "hostEnd.action is shutdown"
export const FOREIGN_RUNTIME = "the running QEMU "

export const isDecision = (reason: string): boolean =>
  reason === CHOSEN_SHUTDOWN || reason.startsWith(FOREIGN_RUNTIME)

export type HostPowerCause =
  | "host-signal"
  | "qemu-gone"
  | "host-shutdown"
  | "host-quit"
  | "host-quit-stopped"
  | "host-kill"
  | "host-stow"
  | "host-cut-off"

export interface HostPoweredOff {
  readonly at: string
  readonly cause: HostPowerCause
  readonly detail: string | null
  readonly fallback: string | null
  readonly elapsedMs: number | null
}

const BRINGS_BACK: ReadonlySet<string> = new Set([
  "start",
  "stop",
  "kill",
  "reset",
  "rewind",
  "load",
  "stow",
  "golden-reset",
])

const ENDS_QEMU: ReadonlySet<string> = new Set([
  "stop",
  "kill",
  "reset",
  "rewind",
  "load",
  "stow",
  "destroy",
  "golden-reset",
])

const LAUNCHES: ReadonlySet<string> = new Set([
  "start",
  "wake",
  "resume",
  "load",
  "rewind",
  "reset",
  "golden-reset",
])

const TAIL_BYTES = 64 * 1024
const SIGNAL_LINE = /terminating on signal \d+ from pid \d+ \([^)]*\)/g

function tailOf(path: string): string {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch {
    return ""
  }
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString("utf8")
  } catch {
    return ""
  } finally {
    closeSync(fd)
  }
}

export function signalLine(qemuLog: string): string | null {
  const found = tailOf(qemuLog).match(SIGNAL_LINE)
  return found?.at(-1) ?? null
}

type KeptExit = "clean" | "unclean" | "unknown"

interface HostEnd {
  readonly at: string
  readonly withQemu: boolean
  readonly steps: Set<string>
  stoppedStatus: string | null
  exit: KeptExit | null
  exitAt: string | null
  shutdown: string | null
  stowing: boolean
  stowed: boolean
  fallback: string | null
  last: string
}

const STOPPED_FOR_MIGRATION: ReadonlySet<string> = new Set([
  "postmigrate",
  "inmigrate",
  "prelaunch",
])

const between = (from: string, to: string): number | null => {
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) ? Math.max(0, ms) : null
}

function exitCause(end: HostEnd): HostPowerCause {
  if (end.shutdown === "host-signal") return "host-signal"
  if (end.shutdown === "host-qmp-quit") return "host-quit"
  if (end.exit === "clean") return "host-shutdown"
  if (end.exit === "unclean") return "host-kill"
  if (end.shutdown === "guest-shutdown") return "host-shutdown"
  if (end.shutdown === "host-qmp-quit") return "host-quit"
  return "host-kill"
}

function keptCause(end: HostEnd): {
  readonly cause: HostPowerCause
  readonly detail: string | null
} {
  if (end.stowed) return { cause: "host-stow", detail: null }
  if (end.steps.has("kill")) return { cause: "host-kill", detail: null }
  if (end.stoppedStatus !== null)
    return { cause: "host-quit-stopped", detail: end.stoppedStatus }
  if (end.steps.has("quit")) return { cause: "host-quit", detail: null }
  return { cause: exitCause(end), detail: null }
}

function keptEnd(end: HostEnd): HostPoweredOff {
  const cause = keptCause(end)
  return {
    at: end.at,
    ...cause,
    fallback: cause.cause === "host-stow" ? null : end.fallback,
    elapsedMs: between(end.at, end.exitAt ?? end.last),
  }
}

function cutOff(end: HostEnd): HostPoweredOff {
  const last = [...end.steps].at(-1)
  return {
    at: end.at,
    cause: "host-cut-off",
    detail: end.stowing
      ? "a stow was being written"
      : last === undefined
        ? "it had not started"
        : `its last step was ${last}`,
    fallback: end.fallback,
    elapsedMs: between(end.at, end.last),
  }
}

const plain = (at: string, cause: HostPowerCause): HostPoweredOff => ({
  at,
  cause,
  detail: null,
  fallback: null,
  elapsedMs: null,
})

const isQemuOf = (e: Readonly<Record<string, unknown>>): boolean =>
  e.child === "qemu"

function noteStep(end: HostEnd, e: Readonly<Record<string, unknown>>): void {
  if (typeof e.step !== "string") return
  end.steps.add(e.step)
  if (
    e.step === "quit" &&
    typeof e.status === "string" &&
    STOPPED_FOR_MIGRATION.has(e.status)
  )
    end.stoppedStatus = e.status
  if (e.step === "fallback" && typeof e.reason === "string")
    end.fallback = e.reason
  if (e.step === "service" && e.ok === false && e.unconfirmed !== true)
    end.fallback = `the service did not take it: ${typeof e.error === "string" ? e.error : "no reason given"}`
}

export function hostPoweredOff(name: string): HostPoweredOff | null {
  let found = null as HostPoweredOff | null
  let sawShutdown = false
  let intended = false
  let keptQemu = false
  let hostEnd = null as HostEnd | null
  const close = (): void => {
    const end = hostEnd
    hostEnd = null
    if (end === null) return
    if (end.exit !== null && end.stowing && !end.stowed) found = cutOff(end)
    else if (end.exit !== null) found = keptEnd(end)
    else if (end.withQemu && !end.steps.has("done")) found = cutOff(end)
  }
  for (const e of readSince(name, START).entries) {
    const settled = hostEnd !== null && hostEnd.exit !== null
    if (hostEnd !== null && !settled) hostEnd.last = e.t
    if (e.kind === "op") {
      if (hostEnd !== null && e.operation === "stow") {
        hostEnd.stowing = e.phase === "begin"
        if (e.phase === "end" && e.ok) hostEnd.stowed = true
        else if (e.phase === "end")
          hostEnd.fallback ??= `the stow failed: ${e.error ?? `exit ${String(e.exitCode ?? "?")}`}`
      }
      if (e.phase === "begin" && ENDS_QEMU.has(e.operation)) intended = true
      else if (e.phase === "end" && e.ok) {
        if (BRINGS_BACK.has(e.operation)) found = null
        if (LAUNCHES.has(e.operation)) {
          sawShutdown = false
          intended = false
          hostEnd = null
        }
      } else if (e.phase === "end" && e.operation === "start")
        found = found?.cause === "qemu-gone" ? null : found
    } else if (e.kind === "keeper") {
      if (e.what === "started" || (e.what === "launched" && isQemuOf(e))) {
        close()
        sawShutdown = false
        intended = false
        if (e.what === "launched") keptQemu = true
      } else if (e.what === "adopted" && isQemuOf(e)) keptQemu = true
      else if (e.what === "host-ending")
        hostEnd = {
          at: e.t,
          withQemu: keptQemu,
          steps: new Set(),
          stoppedStatus: null,
          exit: null,
          exitAt: null,
          shutdown: null,
          stowing: false,
          stowed: false,
          fallback: null,
          last: e.t,
        }
      else if (e.what === "host-end" && hostEnd !== null) noteStep(hostEnd, e)
      else if (
        (e.what === "exited" || e.what === "exited-unknown") &&
        isQemuOf(e)
      ) {
        keptQemu = false
        if (hostEnd !== null && hostEnd.exit === null) {
          hostEnd.exitAt = e.t
          hostEnd.exit =
            e.what === "exited-unknown"
              ? "unknown"
              : e.status === 0
                ? "clean"
                : "unclean"
        }
      }
    } else if (e.kind === "qmp" && e.event === "SHUTDOWN") {
      if (hostEnd !== null && hostEnd.shutdown === null)
        hostEnd.shutdown =
          typeof e.data?.reason === "string" ? e.data.reason : null
      if (settled) continue
      sawShutdown = true
      found =
        e.data?.reason === "host-signal" ? plain(e.t, "host-signal") : null
    } else if (
      !settled &&
      e.kind === "disconnected" &&
      e.reason === "qemu-closed" &&
      !sawShutdown &&
      !intended
    )
      found = plain(e.t, "qemu-gone")
  }
  close()
  if (found?.cause !== "host-signal") return found
  return { ...found, detail: signalLine(pathsFor(name).qemuLog) }
}
