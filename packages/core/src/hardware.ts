import { readFileSync, writeFileSync } from "node:fs"
import { cpus as osCpus, totalmem } from "node:os"
import { resolve } from "node:path"

import type { Paths } from "./paths"
import { spawnText } from "./shell"

export interface Hardware {
  readonly cpus: number
  readonly memoryMiB: number
}

export const LEGACY: Hardware = { cpus: 4, memoryMiB: 4096 }
export const NEW_DEFAULT: Hardware = { cpus: 4, memoryMiB: 8192 }

export const GIB_MIB = 1024

export interface Limits {
  readonly cpus: { readonly min: number; readonly max: number }
  readonly memoryMiB: {
    readonly min: number
    readonly max: number
    readonly step: number
  }
}

export function limitsFor(performanceCores: number, hostBytes: number): Limits {
  const halfGiB = Math.floor(hostBytes / 2 / 1024 ** 3)
  return {
    cpus: { min: 2, max: Math.max(2, performanceCores) },
    memoryMiB: {
      min: 4 * GIB_MIB,
      max: Math.max(4, halfGiB) * GIB_MIB,
      step: GIB_MIB,
    },
  }
}

export function performanceCores(): number {
  const r = spawnText("sysctl", ["-n", "hw.perflevel0.physicalcpu"])
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : osCpus().length
}

export const hostLimits = (): Limits =>
  limitsFor(performanceCores(), totalmem())

export function hardwareError(hw: Hardware, limits: Limits): string | null {
  const c = limits.cpus
  const m = limits.memoryMiB
  if (!Number.isInteger(hw.cpus) || hw.cpus < c.min || hw.cpus > c.max) {
    return `processors must be a whole number from ${String(c.min)} to ${String(c.max)} (this Mac's performance cores), got ${String(hw.cpus)}`
  }
  if (
    !Number.isInteger(hw.memoryMiB) ||
    hw.memoryMiB % m.step !== 0 ||
    hw.memoryMiB < m.min ||
    hw.memoryMiB > m.max
  ) {
    return (
      `memory must be whole GB from ${formatMiB(m.min)} to ${formatMiB(m.max)} (half this Mac's memory), ` +
      `got ${Number.isInteger(hw.memoryMiB) && hw.memoryMiB % GIB_MIB === 0 ? formatMiB(hw.memoryMiB) : `${String(hw.memoryMiB)} MB`}`
    )
  }
  return null
}

export function parseMemory(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(g|gb|gib|m|mb|mib)?\s*$/i.exec(raw)
  if (m === null) return null
  const n = Number(m[1])
  const mib = (m[2] ?? "m").toLowerCase().startsWith("g") ? n * GIB_MIB : n
  return Number.isFinite(mib) ? mib : null
}

export const formatMiB = (mib: number): string =>
  mib % GIB_MIB === 0 ? `${String(mib / GIB_MIB)} GB` : `${String(mib)} MB`

export const sameHardware = (a: Hardware, b: Hardware): boolean =>
  a.cpus === b.cpus && a.memoryMiB === b.memoryMiB

export const hardwarePath = (p: Paths): string =>
  resolve(p.dir, "hardware.json")

const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null

export function hardwareFrom(raw: unknown): Hardware {
  if (typeof raw !== "object" || raw === null) return LEGACY
  const r = raw as Record<string, unknown>
  return {
    cpus: posInt(r["cpus"]) ?? LEGACY.cpus,
    memoryMiB: posInt(r["memoryMiB"]) ?? LEGACY.memoryMiB,
  }
}

export function readHardware(p: Paths): Hardware {
  try {
    return hardwareFrom(JSON.parse(readFileSync(hardwarePath(p), "utf8")))
  } catch {
    return LEGACY
  }
}

export function writeHardware(p: Paths, hw: Hardware): void {
  writeFileSync(
    hardwarePath(p),
    `${JSON.stringify({ cpus: hw.cpus, memoryMiB: hw.memoryMiB }, null, 2)}\n`,
  )
}

export function hardwareFromArgv(argv: readonly string[]): Hardware | null {
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
        memoryMiB = Number(mm[1]) * (mm[2]?.toUpperCase() === "G" ? GIB_MIB : 1)
    }
  }
  return cpus === null || memoryMiB === null ? null : { cpus, memoryMiB }
}

export function runningHardware(pid: number): Hardware | null {
  const r = spawnText("ps", ["-o", "command=", "-p", String(pid)])
  const cmd = r.stdout.trim()
  return cmd === "" ? null : hardwareFromArgv(cmd.split(/\s+/))
}
