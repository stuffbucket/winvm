import { z } from "zod"

const GuestStats = z.object({
  cpu: z.number().nullable().optional(),
  memory: z.object({ total: z.number(), available: z.number() }),
  disk: z
    .object({ path: z.string(), total: z.number(), free: z.number() })
    .nullable(),
})

const Sample = z.object({
  atMs: z.number(),
  host: z.object({ cpuSeconds: z.number(), rssBytes: z.number() }).nullable(),
  guest: GuestStats.nullable(),
  guestError: z.string().nullable(),
})

export type Sample = z.infer<typeof Sample>

export const parseSample = (raw: unknown): Sample | null =>
  Sample.safeParse(raw).data ?? null

export interface Amount {
  readonly used: number
  readonly total: number
}

export interface Usage {
  readonly cpu: number | null
  readonly cpuSource: "windows" | "mac"
  readonly macCpu: number | null
  readonly memory: (Amount & { readonly source: "windows" | "mac" }) | null
  readonly disk: Amount | null
}

const MiB = 1024 ** 2

export function usageFrom(
  prev: Sample | null,
  cur: Sample,
  cpus: number | null,
  memoryMiB: number | null,
): Usage {
  let macCpu: number | null = null
  const seconds = prev === null ? 0 : (cur.atMs - prev.atMs) / 1000
  if (
    prev !== null &&
    prev.host !== null &&
    cur.host !== null &&
    cpus !== null &&
    cpus > 0 &&
    seconds > 0
  ) {
    const busy = (cur.host.cpuSeconds - prev.host.cpuSeconds) / seconds / cpus
    macCpu = Math.min(100, Math.max(0, busy * 100))
  }
  const g = cur.guest
  const windowsCpu = g?.cpu ?? null
  const memory: Usage["memory"] =
    g !== null && g.memory.total > 0
      ? {
          used: Math.max(0, g.memory.total - g.memory.available),
          total: g.memory.total,
          source: "windows",
        }
      : cur.host !== null && memoryMiB !== null
        ? { used: cur.host.rssBytes, total: memoryMiB * MiB, source: "mac" }
        : null
  const disk =
    g !== null && g.disk !== null && g.disk.total > 0
      ? { used: Math.max(0, g.disk.total - g.disk.free), total: g.disk.total }
      : null
  return windowsCpu !== null
    ? {
        cpu: Math.min(100, Math.max(0, windowsCpu * 100)),
        cpuSource: "windows",
        macCpu,
        memory,
        disk,
      }
    : { cpu: macCpu, cpuSource: "mac", macCpu, memory, disk }
}

export const fraction = (a: Amount): number =>
  a.total > 0 ? Math.min(1, a.used / a.total) : 0

export const pushHistory = (
  h: readonly number[],
  v: number | null,
  max = 40,
): number[] => (v === null ? [...h] : [...h, v].slice(-max))

const GB = 1024 ** 3

export function formatGB(bytes: number): string {
  const gb = bytes / GB
  const n =
    gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1).replace(/\.0$/, "")
  return `${n} GB`
}

export function formatPair(a: Amount): string {
  const used = formatGB(a.used).replace(/ GB$/, "")
  return `${used}/${formatGB(a.total)}`
}

export const formatPercent = (p: number): string => `${String(Math.round(p))}%`
