import { z } from "zod"

const Size = z.object({ cpus: z.number(), memoryMiB: z.number() })

export type Size = z.infer<typeof Size>

const Forward = z.object({
  kind: z.string(),
  host: z.string(),
  hostPort: z.number(),
  guestPort: z.number(),
})

const Listener = z.object({
  kind: z.string(),
  host: z.string(),
  port: z.number(),
})

const MachineInfo = z.object({
  name: z.string(),
  running: z.boolean(),
  hardware: z.object({
    running: Size.nullable(),
    next: Size,
    limits: z.object({
      cpus: z.object({ min: z.number(), max: z.number() }),
      memoryMiB: z.object({
        min: z.number(),
        max: z.number(),
        step: z.number(),
      }),
    }),
    diskBytes: z.number().nullable(),
  }),
  network: z.object({
    mode: z.string(),
    label: z.string(),
    guest: z.string(),
    gateway: z.string(),
    dns: z.string(),
    windows: z
      .object({ adapter: z.string().nullable(), ipv4: z.string().nullable() })
      .nullable(),
    forwards: z.array(Forward),
    listeners: z.array(Listener),
  }),
})

export type MachineInfo = z.infer<typeof MachineInfo>

export function parseMachineInfo(stdout: string): MachineInfo | null {
  try {
    return MachineInfo.safeParse(JSON.parse(stdout)).data ?? null
  } catch {
    return null
  }
}

export const infoArgs = (instance: string): string[] => [
  "info",
  "-i",
  instance,
  "--json",
]

export function sizeArgs(instance: string, change: Partial<Size>): string[] {
  return [
    "config",
    "-i",
    instance,
    ...(change.cpus === undefined ? [] : [`cpus=${String(change.cpus)}`]),
    ...(change.memoryMiB === undefined
      ? []
      : [`memory=${String(change.memoryMiB)}`]),
  ]
}

const MIB_PER_GB = 1024

export const toGB = (mib: number): number => mib / MIB_PER_GB
export const fromGB = (gb: number): number => Math.round(gb * MIB_PER_GB)

export const formatMemory = (mib: number): string => {
  const gb = toGB(mib)
  return `${Number.isInteger(gb) ? String(gb) : gb.toFixed(1)} GB`
}

export const pendingRestart = (info: MachineInfo): boolean => {
  const r = info.hardware.running
  const n = info.hardware.next
  return r !== null && (r.cpus !== n.cpus || r.memoryMiB !== n.memoryMiB)
}

export const endpoint = (host: string, port: number): string =>
  `${host}:${String(port)}`

export const forwardKey = (kind: string): string =>
  kind === "finder" || kind === "agent"
    ? `network.forward.${kind}`
    : "network.forward.other"

export const listenerKey = (kind: string): string =>
  kind === "vnc" || kind === "websocket"
    ? `network.listener.${kind}`
    : "network.listener.other"

export const windowsAddress = (info: MachineInfo): string =>
  info.network.windows?.ipv4 ?? info.network.guest
