import { z } from "zod"

const VIEW_EVENTS: ReadonlySet<string> = new Set([
  "STOP",
  "RESUME",
  "SHUTDOWN",
  "RESET",
  "SUSPEND",
  "WAKEUP",
  "GUEST_PANICKED",
  "VSERPORT_CHANGE",
])

const Entry = z.object({
  kind: z.string(),
  event: z.string().optional(),
  phase: z.string().optional(),
})

const Line = z.object({
  type: z.string(),
  instance: z.string().optional(),
  entry: Entry.optional(),
})

export type StreamSignal =
  | { readonly kind: "connected" }
  | { readonly kind: "instances" }
  | { readonly kind: "changed"; readonly instance: string }
  | { readonly kind: "down" }

function changes(entry: z.infer<typeof Entry>): boolean {
  switch (entry.kind) {
    case "op":
      return entry.phase !== "output"
    case "sync":
    case "disconnected":
      return true
    case "qmp":
      return entry.event !== undefined && VIEW_EVENTS.has(entry.event)
    default:
      return false
  }
}

export function signalOf(raw: unknown): StreamSignal | null {
  const line = Line.safeParse(raw)
  if (!line.success) return null
  const { type, instance, entry } = line.data
  switch (type) {
    case "hello":
      return { kind: "connected" }
    case "instances":
      return { kind: "instances" }
    case "down":
      return { kind: "down" }
    case "gap":
      return instance === undefined ? null : { kind: "changed", instance }
    case "entry":
      return instance !== undefined && entry !== undefined && changes(entry)
        ? { kind: "changed", instance }
        : null
    default:
      return null
  }
}
