import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { readSince, START } from "./eventlog"
import { pathsFor } from "./paths"

export type HostPowerCause =
  | "host-signal"
  | "qemu-gone"
  | "host-shutdown"
  | "host-quit"
  | "host-quit-stopped"
  | "host-kill"

export interface HostPoweredOff {
  readonly at: string
  readonly cause: HostPowerCause
  readonly detail: string | null
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
  readonly steps: Set<string>
  stoppedStatus: string | null
  exit: KeptExit | null
  shutdown: string | null
}

const STOPPED_FOR_MIGRATION: ReadonlySet<string> = new Set([
  "postmigrate",
  "inmigrate",
  "prelaunch",
])

function exitCause(end: HostEnd): HostPowerCause {
  if (end.exit === "clean") return "host-shutdown"
  if (end.exit === "unclean") return "host-kill"
  if (end.shutdown === "guest-shutdown") return "host-shutdown"
  if (end.shutdown === "host-qmp-quit") return "host-quit"
  return "host-kill"
}

function keptEnd(end: HostEnd): HostPoweredOff {
  if (end.steps.has("kill"))
    return { at: end.at, cause: "host-kill", detail: null }
  if (end.stoppedStatus !== null)
    return {
      at: end.at,
      cause: "host-quit-stopped",
      detail: end.stoppedStatus,
    }
  if (end.steps.has("quit"))
    return { at: end.at, cause: "host-quit", detail: null }
  return { at: end.at, cause: exitCause(end), detail: null }
}

const CLOSES_HOST_END: ReadonlySet<string> = new Set(["started", "launched"])

export function hostPoweredOff(name: string): HostPoweredOff | null {
  let found = null as HostPoweredOff | null
  let sawShutdown = false
  let intended = false
  let hostEnd = null as HostEnd | null
  const close = (): void => {
    if (hostEnd?.exit !== null && hostEnd !== null) found = keptEnd(hostEnd)
    hostEnd = null
  }
  for (const e of readSince(name, START).entries) {
    const settled = hostEnd !== null && hostEnd.exit !== null
    if (e.kind === "op") {
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
      if (
        CLOSES_HOST_END.has(e.what) &&
        (e.what === "started" || e.child === "qemu")
      ) {
        close()
        sawShutdown = false
        intended = false
      } else if (e.what === "host-ending")
        hostEnd = {
          at: e.t,
          steps: new Set(),
          stoppedStatus: null,
          exit: null,
          shutdown: null,
        }
      else if (e.what === "host-end" && typeof e.step === "string") {
        hostEnd?.steps.add(e.step)
        if (
          e.step === "quit" &&
          typeof e.status === "string" &&
          STOPPED_FOR_MIGRATION.has(e.status) &&
          hostEnd !== null
        )
          hostEnd.stoppedStatus = e.status
      } else if (
        (e.what === "exited" || e.what === "exited-unknown") &&
        e.child === "qemu" &&
        hostEnd !== null &&
        hostEnd.exit === null
      )
        hostEnd.exit =
          e.what === "exited-unknown"
            ? "unknown"
            : e.status === 0
              ? "clean"
              : "unclean"
    } else if (e.kind === "qmp" && e.event === "SHUTDOWN") {
      if (hostEnd !== null && hostEnd.shutdown === null)
        hostEnd.shutdown =
          typeof e.data?.reason === "string" ? e.data.reason : null
      if (settled) continue
      sawShutdown = true
      found =
        e.data?.reason === "host-signal"
          ? { at: e.t, cause: "host-signal", detail: null }
          : null
    } else if (
      !settled &&
      e.kind === "disconnected" &&
      e.reason === "qemu-closed" &&
      !sawShutdown &&
      !intended
    )
      found = { at: e.t, cause: "qemu-gone", detail: null }
  }
  close()
  if (found?.cause !== "host-signal") return found
  return { ...found, detail: signalLine(pathsFor(name).qemuLog) }
}
