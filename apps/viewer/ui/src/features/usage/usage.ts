/**
 * The title bar's meters, from samples the app takes every few seconds
 * (src-tauri/src/guest.rs `instance_usage`): QEMU's CPU time and memory from
 * `ps`, and Windows' own CPU, memory and C: from the agent's GET /stats. Pure.
 *
 * - CPU: how busy Windows' processors are, as Windows counts it (the agent's
 *   `cpu`), out of all of them (100% is every one busy). Beside it, what QEMU
 *   spends on the Mac: its CPU time between two samples over the time between
 *   them, out of as many of the Mac's processors. That is more than Windows'
 *   figure (the screen, the disk and the network are QEMU's work, not
 *   Windows'), so it alone read as "Windows is busy" when it was not. Without
 *   the agent, or one older than 11, QEMU's figure is the headline, said so.
 * - Memory: what Windows has in use (total less available, as Task Manager
 *   counts it) out of what it has. Without the agent, what QEMU holds on the
 *   Mac instead, said so.
 * - Disk: C:'s used space out of its size, from the agent.
 */
import { z } from "zod"

const GuestStats = z.object({
  cpu: z.number().nullable().optional(),
  memory: z.object({ total: z.number(), available: z.number() }),
  disk: z.object({ path: z.string(), total: z.number(), free: z.number() }).nullable(),
})

const Sample = z.object({
  atMs: z.number(),
  host: z.object({ cpuSeconds: z.number(), rssBytes: z.number() }).nullable(),
  guest: GuestStats.nullable(),
  guestError: z.string().nullable(),
})

export type Sample = z.infer<typeof Sample>

export const parseSample = (raw: unknown): Sample | null => Sample.safeParse(raw).data ?? null

export interface Amount {
  readonly used: number
  readonly total: number
}

export interface Usage {
  /** Percent of all the machine's processors busy, 0-100: Windows' own figure, or (cpuSource "mac") QEMU's; null until there is one. */
  readonly cpu: number | null
  readonly cpuSource: "windows" | "mac"
  /** What QEMU spends on the Mac, as a percent of as many of its processors, 0-100; null until two samples. */
  readonly macCpu: number | null
  /** Windows' memory in use, or (source "mac") QEMU's resident memory on the Mac. */
  readonly memory: (Amount & { readonly source: "windows" | "mac" }) | null
  /** C: in Windows. */
  readonly disk: Amount | null
}

const MiB = 1024 ** 2

export function usageFrom(prev: Sample | null, cur: Sample, cpus: number | null, memoryMiB: number | null): Usage {
  let macCpu: number | null = null
  const seconds = prev === null ? 0 : (cur.atMs - prev.atMs) / 1000
  if (prev !== null && prev.host !== null && cur.host !== null && cpus !== null && cpus > 0 && seconds > 0) {
    const busy = (cur.host.cpuSeconds - prev.host.cpuSeconds) / seconds / cpus
    macCpu = Math.min(100, Math.max(0, busy * 100))
  }
  const g = cur.guest
  const windowsCpu = g?.cpu ?? null
  const memory: Usage["memory"] =
    g !== null && g.memory.total > 0
      ? { used: Math.max(0, g.memory.total - g.memory.available), total: g.memory.total, source: "windows" }
      : cur.host !== null && memoryMiB !== null
        ? { used: cur.host.rssBytes, total: memoryMiB * MiB, source: "mac" }
        : null
  const disk = g !== null && g.disk !== null && g.disk.total > 0 ? { used: Math.max(0, g.disk.total - g.disk.free), total: g.disk.total } : null
  return windowsCpu !== null
    ? { cpu: Math.min(100, Math.max(0, windowsCpu * 100)), cpuSource: "windows", macCpu, memory, disk }
    : { cpu: macCpu, cpuSource: "mac", macCpu, memory, disk }
}

/** How much of `a` is used, 0-1. */
export const fraction = (a: Amount): number => (a.total > 0 ? Math.min(1, a.used / a.total) : 0)

/** The last `max` values, `v` added. */
export const pushHistory = (h: readonly number[], v: number | null, max = 40): number[] => (v === null ? [...h] : [...h, v].slice(-max))

const GB = 1024 ** 3

/** Bytes as Windows shows them, in binary units as Task Manager and Explorer count: "2.1 GB", "4 GB", "63 GB". */
export function formatGB(bytes: number): string {
  const gb = bytes / GB
  const n = gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1).replace(/\.0$/, "")
  return `${n} GB`
}

/** "2.1/4.0 GB": both in one unit, the unit once. */
export function formatPair(a: Amount): string {
  const used = formatGB(a.used).replace(/ GB$/, "")
  return `${used}/${formatGB(a.total)}`
}

export const formatPercent = (p: number): string => `${String(Math.round(p))}%`
