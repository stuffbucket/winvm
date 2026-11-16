import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { readSince, START } from "./eventlog"
import { pathsFor } from "./paths"

export type HostPowerCause = "host-signal" | "qemu-gone"

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
  "sleep",
  "destroy",
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

export function hostPoweredOff(name: string): HostPoweredOff | null {
  let found: HostPoweredOff | null = null
  let sawShutdown = false
  let intended = false
  for (const e of readSince(name, START).entries) {
    if (e.kind === "op") {
      if (e.phase === "begin" && ENDS_QEMU.has(e.operation)) intended = true
      else if (e.phase === "end" && e.ok && BRINGS_BACK.has(e.operation)) {
        found = null
        if (e.operation === "start") {
          sawShutdown = false
          intended = false
        }
      }
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
