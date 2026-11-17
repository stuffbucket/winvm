import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { readSince, START } from "./eventlog"
import { pathsFor } from "./paths"

export type HostPowerCause =
  | "host-signal"
  | "qemu-gone"
  | "host-shutdown"
  | "host-quit"
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

interface HostEnd {
  readonly at: string
  readonly steps: Set<string>
}

function keptEnd(
  end: HostEnd,
  exit: Readonly<Record<string, unknown>>,
): HostPoweredOff {
  const cause: HostPowerCause = end.steps.has("kill")
    ? "host-kill"
    : end.steps.has("quit")
      ? "host-quit"
      : exit.status === 0
        ? "host-shutdown"
        : "host-kill"
  return { at: end.at, cause, detail: null }
}

export function hostPoweredOff(name: string): HostPoweredOff | null {
  let found = null as HostPoweredOff | null
  let sawShutdown = false
  let intended = false
  let hostEnd = null as HostEnd | null
  let settledByKeeper = false
  for (const e of readSince(name, START).entries) {
    if (e.kind === "op") {
      if (e.phase === "begin" && ENDS_QEMU.has(e.operation)) intended = true
      else if (e.phase === "end" && e.ok) {
        if (BRINGS_BACK.has(e.operation)) found = null
        if (LAUNCHES.has(e.operation)) {
          sawShutdown = false
          intended = false
          hostEnd = null
          settledByKeeper = false
        }
      } else if (e.phase === "end" && e.operation === "start")
        found = found?.cause === "qemu-gone" ? null : found
    } else if (e.kind === "keeper") {
      if (e.what === "host-ending") hostEnd = { at: e.t, steps: new Set() }
      else if (e.what === "host-end" && typeof e.step === "string")
        hostEnd?.steps.add(e.step)
      else if (
        (e.what === "exited" || e.what === "exited-unknown") &&
        e.child === "qemu" &&
        hostEnd !== null
      ) {
        found = keptEnd(hostEnd, e)
        settledByKeeper = true
      }
    } else if (settledByKeeper) {
    } else if (e.kind === "qmp" && e.event === "SHUTDOWN") {
      sawShutdown = true
      found =
        e.data?.reason === "host-signal"
          ? { at: e.t, cause: "host-signal", detail: null }
          : null
    } else if (
      e.kind === "disconnected" &&
      e.reason === "qemu-closed" &&
      !sawShutdown &&
      !intended
    )
      found = { at: e.t, cause: "qemu-gone", detail: null }
  }
  if (found?.cause !== "host-signal") return found
  return { ...found, detail: signalLine(pathsFor(name).qemuLog) }
}
