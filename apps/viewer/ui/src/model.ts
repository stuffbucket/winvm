import { z } from "zod"

const Guest = z.object({
  agent: z.enum(["ok", "silent"]),
  agentVersion: z.string().nullable(),
  os: z.string().nullable(),
})

export const VM_OPERATIONS = [
  "start",
  "stop",
  "reboot",
  "kill",
  "reset",
  "snapshot",
  "rewind",
  "save",
  "load",
  "pause",
  "resume",
  "sleep",
  "wake",
  "lock",
  "stow",
  "setup",
  "golden-create",
  "golden-reset",
] as const

const VmOperationSchema = z.enum(VM_OPERATIONS)

export type VmOperation = z.infer<typeof VmOperationSchema>

const OperationInfoSchema = z.object({
  operation: VmOperationSchema,
  pid: z.number(),
  startedAt: z.string(),
})

export const CLOSE_POLICIES = ["ask", "leave", "stow", "shutdown"] as const

const ClosePolicySchema = z.enum(CLOSE_POLICIES)

export type ClosePolicy = z.infer<typeof ClosePolicySchema>

export const closePolicyAssignment = (policy: ClosePolicy): string => `viewer.closePolicy=${policy}`

const Status = z.object({
  name: z.string(),
  title: z.string().nullable().default(null),
  closePolicy: ClosePolicySchema.default("ask"),
  operation: OperationInfoSchema.nullable().default(null),
  state: z.enum(["running", "paused", "asleep", "stopped", "stowed", "missing"]),
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

export const TITLE_MAX = 80

export const shownTitle = (name: string, title: string | null | undefined): string => title ?? name

export const titleAssignment = (title: string): string => `title=${title.trim()}`

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

export function parseStatus(stdout: string): Status[] | null {
  const raw = json(stdout)
  const list = z.object({ instances: z.array(Status) }).safeParse(raw)
  if (list.success) return list.data.instances
  const single = Status.safeParse(raw)
  return single.success ? [single.data] : null
}

export const parseChecks = (stdout: string): Checks | null => Checks.safeParse(json(stdout)).data ?? null

export const parseConnection = (stdout: string): Connection | null => Connection.safeParse(json(stdout)).data ?? null

export type Phase = "starting" | "running" | "paused" | "asleep" | "stopped" | "stowed" | "missing"

export const isLivePhase = (p: Phase | null | undefined): boolean =>
  p === "running" || p === "starting" || p === "paused" || p === "asleep"

export const isFrozen = (p: Phase | null | undefined): boolean => p === "paused" || p === "asleep"

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
  readonly sleep: boolean
  readonly lock: boolean
  readonly screen: boolean
  readonly terminal: boolean
}

export function controls(p: Phase, busy: boolean): Controls {
  const live = isLivePhase(p)
  return {
    start: !busy && !live,
    shutDown: !busy && live,
    restart: !busy && (p === "running" || p === "starting"),
    pause: !busy && (p === "running" || p === "starting"),
    resume: !busy && isFrozen(p),
    sleep: !busy && p === "running",
    lock: !busy && p === "running",
    screen: live,
    terminal: !busy && p === "running",
  }
}

export function terminalBlocked(p: Phase, busy: boolean): string | null {
  if (p === "starting") return "terminal.why.starting"
  if (p === "paused") return "terminal.why.paused"
  if (p === "asleep") return "terminal.why.asleep"
  if (p !== "running") return "terminal.why.off"
  return busy ? "terminal.why.busy" : null
}

const GiB = 1024 ** 3

export const formatSize = (bytes: number): string =>
  bytes < GiB ? `${String(Math.round(bytes / 1024 ** 2))} MiB` : `${(bytes / GiB).toFixed(1)} GiB`

function formatMemory(mib: number): string {
  const gib = mib / 1024
  return Number.isInteger(gib) ? `${String(gib)} GiB` : `${String(mib)} MiB`
}

function formatDuration(seconds: number): string {
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

export function startSteps(created: boolean, s: Status | null): Step[] {
  const exists = s !== null && s.state !== "missing"
  const machine = s !== null && (s.state === "running" || s.state === "paused" || s.state === "asleep")
  const windows = machine && s.guest?.agent === "ok"
  const reached = [...(created ? [{ key: "step.disk", done: exists }] : []), { key: "step.machine", done: machine }, { key: "step.windows", done: windows }]
  const firstTodo = reached.findIndex((r) => !r.done)
  return reached.map((r, i) => ({ key: r.key, state: r.done ? "done" : i === firstTodo ? "current" : "todo" }))
}

export function facts(s: Status): Row[] {
  const out: Row[] = []
  if (s.image !== null) out.push({ key: "fact.image", value: s.image })
  if (s.memoryMiB !== null) out.push({ key: "fact.memory", value: formatMemory(s.memoryMiB) })
  if (s.cpus !== null) out.push({ key: "fact.cpus", value: String(s.cpus) })
  if (s.overlayBytes !== null) out.push({ key: "fact.changes", value: formatSize(s.overlayBytes) })
  if (s.saves.count > 0) out.push({ key: "fact.saves", value: String(s.saves.count) })
  return out
}

const SaveNotes = z.object({
  title: z.string().nullable().default(null),
  text: z.string().default(""),
  tags: z.array(z.string()).default([]),
  updatedAt: z.string().optional(),
})

export type SaveNotes = z.infer<typeof SaveNotes>

const SaveEntry = z.object({
  name: z.string(),
  title: z.string().nullable().default(null),
  kind: z.string(),
  createdAt: z.string(),
  bytes: z.number(),
  compatible: z.boolean().nullable(),
  note: z.string().optional(),
  format: z.string().optional(),
  screenshot: z.string().nullable().default(null),
  thumbnail: z.string().nullable().default(null),
  screenSize: z.object({ width: z.number(), height: z.number() }).optional(),
  notes: SaveNotes.nullable().default(null),
  incompatible: z.array(z.string()).default([]),
})

export type SaveEntry = z.infer<typeof SaveEntry>

export const parseSaves = (stdout: string): SaveEntry[] | null => z.array(SaveEntry).safeParse(json(stdout)).data ?? null

export function parseNote(stdout: string): SaveNotes | null | undefined {
  if (stdout.trim() === "") return undefined
  const raw = json(stdout)
  if (raw === null && stdout.trim() !== "null") return undefined
  const r = SaveNotes.nullable().safeParse(raw)
  return r.success ? r.data : undefined
}

export interface Share {
  readonly url: string
  readonly token: string
}

export function parseShare(stdout: string): Share | null {
  const url = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1]
  const token = /^\s*token (\S+)$/m.exec(stdout)?.[1]
  return url === undefined || token === undefined ? null : { url, token }
}

const ClaudeClientId = z.enum(["claude-code", "claude-desktop"])

const ClaudeClient = z.object({
  id: ClaudeClientId,
  name: z.string(),
  available: z.boolean(),
  added: z.boolean(),
  current: z.boolean(),
  config: z.string(),
})

export type ClaudeClient = z.infer<typeof ClaudeClient>
export type ClaudeClientId = z.infer<typeof ClaudeClientId>

const ClaudeStatus = z.object({
  instance: z.string(),
  server: z.string(),
  clients: z.array(ClaudeClient),
})

export type ClaudeStatus = z.infer<typeof ClaudeStatus>

export const parseClaudeStatus = (stdout: string): ClaudeStatus | null => ClaudeStatus.safeParse(json(stdout)).data ?? null

const ClaudeChange = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), client: ClaudeClientId, changed: z.boolean(), restart: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

export type ClaudeChange = z.infer<typeof ClaudeChange>

export const parseClaudeChange = (stdout: string): ClaudeChange | null => ClaudeChange.safeParse(json(stdout)).data ?? null

const SharedFolderStatus = z.object({
  available: z.boolean(),
  reason: z.string().nullable().default(null),
  folder: z.string().nullable(),
  letter: z.string(),
  readonly: z.boolean(),
  running: z.boolean(),
  serving: z.string().nullable().default(null),
  pending: z.boolean(),
  guest: z.object({ installed: z.boolean().nullable(), mounted: z.boolean().nullable() }).default({ installed: null, mounted: null }),
})

export type SharedFolderStatus = z.infer<typeof SharedFolderStatus>

export const parseSharedFolder = (stdout: string): SharedFolderStatus | null => SharedFolderStatus.safeParse(json(stdout)).data ?? null
