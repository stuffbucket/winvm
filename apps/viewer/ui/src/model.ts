import { z } from "zod"

const Guest = z.object({
  agent: z.enum(["ok", "silent"]),
  agentVersion: z.string().nullable(),
  os: z.string().nullable(),
})

const Status = z.object({
  name: z.string(),
  state: z.enum(["running", "paused", "stopped", "stowed", "missing"]),
  vmStatus: z.string().nullable(),
  image: z.string().nullable(),
  pid: z.number().nullable(),
  uptimeSeconds: z.number().nullable(),
  cpus: z.number().nullable(),
  memoryMiB: z.number().nullable(),
  screen: z.string().nullable(),
  overlayBytes: z.number().nullable(),
  guest: Guest.nullable(),
  saves: z.object({ count: z.number(), bytes: z.number() }),
  notes: z.array(z.string()),
})

export type Status = z.infer<typeof Status>

const Checks = z.object({
  ready: z.boolean(),
  checks: z.array(z.object({ label: z.string(), ok: z.boolean(), hint: z.string() })),
  timeMachine: z.string(),
})

export type Checks = z.infer<typeof Checks>

const Connection = z.object({
  display: z.number(),
  vncPort: z.number(),
  websocketPort: z.number(),
  password: z.string().nullable(),
})

export type Connection = z.infer<typeof Connection>

function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

/** `winvm status --json`: one instance, or `{ instances }` when there are several. */
export function parseStatus(stdout: string): Status[] | null {
  const raw = json(stdout)
  const list = z.object({ instances: z.array(Status) }).safeParse(raw)
  if (list.success) return list.data.instances
  const single = Status.safeParse(raw)
  return single.success ? [single.data] : null
}

export const parseChecks = (stdout: string): Checks | null => Checks.safeParse(json(stdout)).data ?? null

export const parseConnection = (stdout: string): Connection | null => Connection.safeParse(json(stdout)).data ?? null

export type Phase = "starting" | "running" | "paused" | "stopped" | "stowed" | "missing"

export function phase(s: Status): Phase {
  if (s.state === "running" && s.guest?.agent === "silent") return "starting"
  return s.state
}

export interface Controls {
  readonly start: boolean
  readonly shutDown: boolean
  readonly restart: boolean
  readonly pause: boolean
  readonly resume: boolean
  readonly screen: boolean
}

export function controls(p: Phase, busy: boolean): Controls {
  const live = p === "running" || p === "starting" || p === "paused"
  return {
    start: !busy && !live,
    shutDown: !busy && live,
    restart: !busy && (p === "running" || p === "starting"),
    pause: !busy && (p === "running" || p === "starting"),
    resume: !busy && p === "paused",
    screen: live,
  }
}

const GiB = 1024 ** 3

export const formatSize = (bytes: number): string =>
  bytes < GiB ? `${String(Math.round(bytes / 1024 ** 2))} MiB` : `${(bytes / GiB).toFixed(1)} GiB`

export function formatMemory(mib: number): string {
  const gib = mib / 1024
  return Number.isInteger(gib) ? `${String(gib)} GiB` : `${String(mib)} MiB`
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${String(d)} d ${String(h % 24)} h`
  if (h > 0) return `${String(h)} h ${String(m % 60)} min`
  if (m > 0) return `${String(m)} min`
  return `${String(Math.floor(seconds))} s`
}

export interface Row {
  readonly key: string
  readonly value: string
}

/** The details a person reads, as i18n keys and values; anything unknown is left out. */
export function detailRows(s: Status): Row[] {
  const rows: Row[] = []
  const add = (key: string, value: string | null): void => {
    if (value !== null && value !== "") rows.push({ key, value })
  }
  add("detail.windows", s.guest?.os ?? null)
  add("detail.uptime", s.uptimeSeconds === null ? null : formatDuration(s.uptimeSeconds))
  add(
    "detail.hardware",
    [s.cpus === null ? null : `${String(s.cpus)} vCPU`, s.memoryMiB === null ? null : formatMemory(s.memoryMiB)]
      .filter((x) => x !== null)
      .join(" · "),
  )
  add("detail.image", s.image)
  if (s.screen !== null) {
    const d = displaySize(s.screen)
    add("detail.screen", `${String(d.width)} × ${String(d.height)}${d.device === null ? "" : ` (${d.device})`}`)
  }
  add("detail.disk", s.overlayBytes === null ? null : formatSize(s.overlayBytes))
  if (s.saves.count > 0) add("detail.saves", `${String(s.saves.count)} · ${formatSize(s.saves.bytes)}`)
  return rows
}

export interface DisplaySize {
  readonly width: number
  readonly height: number
  readonly device: string | null
}

/** The guest's display from status' description; the firmware framebuffer's 800x600 when unknown. */
export function displaySize(screen: string | null): DisplaySize {
  const size = /(\d+)x(\d+)/.exec(screen ?? "")
  const device = /^(ramfb|virtio-gpu)\b/.exec(screen ?? "")?.[1] ?? null
  if (size === null) return { width: 800, height: 600, device }
  return { width: Number(size[1]), height: Number(size[2]), device }
}

export interface Step {
  readonly key: string
  readonly state: "done" | "current" | "todo"
}

/** What starting has done so far: the disk (for a new instance), the machine, then Windows. */
export function startSteps(created: boolean, s: Status | null): Step[] {
  const exists = s !== null && s.state !== "missing"
  const machine = s !== null && (s.state === "running" || s.state === "paused")
  const windows = machine && s.guest?.agent === "ok"
  const reached = [...(created ? [{ key: "step.disk", done: exists }] : []), { key: "step.machine", done: machine }, { key: "step.windows", done: windows }]
  const firstTodo = reached.findIndex((r) => !r.done)
  return reached.map((r, i) => ({ key: r.key, state: r.done ? "done" : i === firstTodo ? "current" : "todo" }))
}

/** What the instance is, labelled: image, memory, processors, changes since the image, saves. */
export function facts(s: Status): Row[] {
  const out: Row[] = []
  if (s.image !== null) out.push({ key: "fact.image", value: s.image })
  if (s.memoryMiB !== null) out.push({ key: "fact.memory", value: formatMemory(s.memoryMiB) })
  if (s.cpus !== null) out.push({ key: "fact.cpus", value: String(s.cpus) })
  if (s.overlayBytes !== null) out.push({ key: "fact.changes", value: formatSize(s.overlayBytes) })
  if (s.saves.count > 0) out.push({ key: "fact.saves", value: String(s.saves.count) })
  return out
}

const SaveEntry = z.object({
  name: z.string(),
  kind: z.string(),
  createdAt: z.string(),
  bytes: z.number(),
  compatible: z.boolean().nullable(),
  note: z.string().optional(),
})

export type SaveEntry = z.infer<typeof SaveEntry>

/** `winvm saves --json`. */
export const parseSaves = (stdout: string): SaveEntry[] | null => z.array(SaveEntry).safeParse(json(stdout)).data ?? null

export interface Share {
  readonly url: string
  readonly token: string
}

/** The endpoint and bearer token `winvm cua serve` prints when it is ready. */
export function parseShare(stdout: string): Share | null {
  const url = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1]
  const token = /^\s*token (\S+)$/m.exec(stdout)?.[1]
  return url === undefined || token === undefined ? null : { url, token }
}
