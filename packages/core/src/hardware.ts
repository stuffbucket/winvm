/**
 * The processors and memory a Windows machine gets: `-smp` and `-m` (and the
 * shared memory backend's size, which must equal `-m`; share.ts).
 *
 * Stored in `instances/<name>/hardware.json`, like display.json and
 * share.json. A machine without the file is one made before the setting
 * existed and keeps what every machine had then, LEGACY (4 processors,
 * 4096 MiB); a new machine is written NEW_DEFAULT (8 GiB, because 4 GiB is
 * below comfortable for Windows 11). A change takes effect the next time QEMU
 * boots the machine; a running guest is never resized.
 *
 * ## Saves
 *
 * The size is part of the virtual hardware, so it is in a save's
 * compatibility hash (saves.ts hardwareArgs). A save records the size it was
 * taken at (Manifest.hardware; absent means LEGACY), and `load` and the stow
 * recall launch QEMU at THAT size, so changing the setting never makes a save
 * unloadable. The setting applies again at the next cold boot.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { cpus as osCpus, totalmem } from "node:os"
import { resolve } from "node:path"

import type { Paths } from "./paths"

export interface Hardware {
  readonly cpus: number
  readonly memoryMiB: number
}

/** What every machine had before the setting existed, and what a save without `hardware` was taken at. */
export const LEGACY: Hardware = { cpus: 4, memoryMiB: 4096 }
/** What a new machine gets. */
export const NEW_DEFAULT: Hardware = { cpus: 4, memoryMiB: 8192 }

export const GIB_MIB = 1024

export interface Limits {
  readonly cpus: { readonly min: number; readonly max: number }
  readonly memoryMiB: { readonly min: number; readonly max: number; readonly step: number }
}

/**
 * Processors: 2 up to the host's performance cores (efficiency cores would
 * make a vCPU run slower than its siblings). Memory: 4 GiB up to half the
 * host's RAM, in whole GiB.
 */
export function limitsFor(performanceCores: number, hostBytes: number): Limits {
  const halfGiB = Math.floor(hostBytes / 2 / 1024 ** 3)
  return {
    cpus: { min: 2, max: Math.max(2, performanceCores) },
    memoryMiB: { min: 4 * GIB_MIB, max: Math.max(4, halfGiB) * GIB_MIB, step: GIB_MIB },
  }
}

/** Performance cores on Apple silicon (`hw.perflevel0.physicalcpu`), else every core. */
export function performanceCores(): number {
  const r = spawnSync("sysctl", ["-n", "hw.perflevel0.physicalcpu"], { encoding: "utf8" })
  const n = Number.parseInt((r.stdout ?? "").trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : osCpus().length
}

export const hostLimits = (): Limits => limitsFor(performanceCores(), totalmem())

/** Why `hw` is out of `limits`, in words, or null. */
export function hardwareError(hw: Hardware, limits: Limits): string | null {
  const c = limits.cpus
  const m = limits.memoryMiB
  if (!Number.isInteger(hw.cpus) || hw.cpus < c.min || hw.cpus > c.max) {
    return `processors must be a whole number from ${String(c.min)} to ${String(c.max)} (this Mac's performance cores), got ${String(hw.cpus)}`
  }
  if (!Number.isInteger(hw.memoryMiB) || hw.memoryMiB % m.step !== 0 || hw.memoryMiB < m.min || hw.memoryMiB > m.max) {
    return (
      `memory must be whole GB from ${formatMiB(m.min)} to ${formatMiB(m.max)} (half this Mac's memory), ` +
      `got ${Number.isInteger(hw.memoryMiB) && hw.memoryMiB % GIB_MIB === 0 ? formatMiB(hw.memoryMiB) : `${String(hw.memoryMiB)} MB`}`
    )
  }
  return null
}

/** "8G", "8 GB", "8GiB", "8192M" or a plain number of MiB ("8192"); null when it is none of those. */
export function parseMemory(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(g|gb|gib|m|mb|mib)?\s*$/i.exec(raw)
  if (m === null) return null
  const n = Number(m[1])
  const mib = (m[2] ?? "m").toLowerCase().startsWith("g") ? n * GIB_MIB : n
  return Number.isFinite(mib) ? mib : null
}

export const formatMiB = (mib: number): string => (mib % GIB_MIB === 0 ? `${String(mib / GIB_MIB)} GB` : `${String(mib)} MB`)

export const sameHardware = (a: Hardware, b: Hardware): boolean => a.cpus === b.cpus && a.memoryMiB === b.memoryMiB

export const hardwarePath = (p: Paths): string => resolve(p.dir, "hardware.json")

const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null)

/** A recorded size (hardware.json, a save's manifest), each missing or bad field taken from LEGACY. */
export function hardwareFrom(raw: unknown): Hardware {
  if (typeof raw !== "object" || raw === null) return LEGACY
  const r = raw as Record<string, unknown>
  return { cpus: posInt(r["cpus"]) ?? LEGACY.cpus, memoryMiB: posInt(r["memoryMiB"]) ?? LEGACY.memoryMiB }
}

/** The machine's setting: what its next boot uses. LEGACY for a machine that has never had one. */
export function readHardware(p: Paths): Hardware {
  try {
    return hardwareFrom(JSON.parse(readFileSync(hardwarePath(p), "utf8")))
  } catch {
    return LEGACY
  }
}

export function writeHardware(p: Paths, hw: Hardware): void {
  writeFileSync(hardwarePath(p), `${JSON.stringify({ cpus: hw.cpus, memoryMiB: hw.memoryMiB }, null, 2)}\n`)
}

/** `-smp N` and `-m MiB` off a QEMU command line; null when either is missing. */
export function hardwareFromArgv(argv: readonly string[]): Hardware | null {
  let cpus: number | null = null
  let memoryMiB: number | null = null
  for (let i = 0; i < argv.length - 1; i += 1) {
    const v = argv[i + 1] ?? ""
    if (argv[i] === "-smp") cpus = Number.parseInt(v.split(",")[0]?.replace(/^cpus=/, "") ?? "", 10) || null
    if (argv[i] === "-m") {
      const mm = /^(?:size=)?(\d+)([MG]?)/i.exec(v)
      if (mm !== null) memoryMiB = Number(mm[1]) * (mm[2]?.toUpperCase() === "G" ? GIB_MIB : 1)
    }
  }
  return cpus === null || memoryMiB === null ? null : { cpus, memoryMiB }
}

/** What a running QEMU was started with, off its own command line; null when that cannot be read. */
export function runningHardware(pid: number): Hardware | null {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  const cmd = (r.stdout ?? "").trim()
  return cmd === "" ? null : hardwareFromArgv(cmd.split(/\s+/))
}
