/**
 * The title bar's meters, from samples the app takes every few seconds
 * (src-tauri/src/guest.rs `instance_usage`): QEMU's CPU time and memory from
 * `ps`, and Windows' own memory and C: from the agent's GET /stats. Pure.
 *
 * - CPU: QEMU's CPU time between two samples over the time between them, out
 *   of all the machine's processors (100% is every one busy).
 * - Memory: what Windows has in use (total less available, as Task Manager
 *   counts it) out of what it has. Without the agent, what QEMU holds on the
 *   Mac instead, said so.
 * - Disk: C:'s used space out of its size, from the agent.
 */
import { z } from "zod"

const GuestStats = z.object({
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
  /** Percent of all the machine's processors, 0-100; null until two samples. */
  readonly cpu: number | null
  /** Windows' memory in use, or (source "mac") QEMU's resident memory on the Mac. */
  readonly memory: (Amount & { readonly source: "windows" | "mac" }) | null
  /** C: in Windows. */
  readonly disk: Amount | null
}

const MiB = 1024 ** 2

export function usageFrom(prev: Sample | null, cur: Sample, cpus: number | null, memoryMiB: number | null): Usage {
  let cpu: number | null = null
  const seconds = prev === null ? 0 : (cur.atMs - prev.atMs) / 1000
  if (prev !== null && prev.host !== null && cur.host !== null && cpus !== null && cpus > 0 && seconds > 0) {
    const busy = (cur.host.cpuSeconds - prev.host.cpuSeconds) / seconds / cpus
    cpu = Math.min(100, Math.max(0, busy * 100))
  }
  const g = cur.guest
  const memory: Usage["memory"] =
    g !== null && g.memory.total > 0
      ? { used: Math.max(0, g.memory.total - g.memory.available), total: g.memory.total, source: "windows" }
      : cur.host !== null && memoryMiB !== null
        ? { used: cur.host.rssBytes, total: memoryMiB * MiB, source: "mac" }
        : null
  const disk = g !== null && g.disk !== null && g.disk.total > 0 ? { used: Math.max(0, g.disk.total - g.disk.free), total: g.disk.total } : null
  return { cpu, memory, disk }
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
