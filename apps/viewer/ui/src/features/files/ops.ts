import { z } from "zod"

import { type AgentReply, agentFetch } from "../../backend"
import type { ListFailure, Listing } from "./files"
import { parseListing } from "./files"

export type OpCode =
  | "notfound"
  | "denied"
  | "exists"
  | "busy"
  | "into"
  | "notdir"
  | "notrunning"
  | "unavailable"
  | "other"

export type OpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: OpCode; readonly detail: string }

const Failure = z.object({
  error: z.string(),
  code: z.string().nullable().optional(),
})
const CODES = new Set<string>([
  "notfound",
  "denied",
  "exists",
  "busy",
  "into",
  "notdir",
  "notrunning",
  "unavailable",
])

export function parseReply<T>(
  reply: AgentReply,
  shape: z.ZodType<T>,
): OpResult<T> {
  if (reply.status >= 200 && reply.status < 300) {
    const ok = shape.safeParse(reply.body)
    if (ok.success) return { ok: true, value: ok.data }
  }
  const failed = Failure.safeParse(reply.body)
  if (failed.success) {
    const code = failed.data.code ?? ""
    return {
      ok: false,
      code: CODES.has(code) ? (code as OpCode) : "other",
      detail: failed.data.error,
    }
  }
  const text =
    typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)
  return {
    ok: false,
    code: "other",
    detail: `${String(reply.status)} ${text}`.trim(),
  }
}

export function unreachable(error: unknown): {
  readonly code: OpCode
  readonly detail: string
} {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    code: /is not running/.test(detail) ? "notrunning" : "other",
    detail,
  }
}

const Path = z.object({ path: z.string() })
const Deleted = z.object({ deleted: z.number() })

async function call<T>(
  instance: string,
  path: string,
  body: unknown,
  shape: z.ZodType<T>,
  timeoutMs?: number,
): Promise<OpResult<T>> {
  try {
    return parseReply(
      await agentFetch(instance, "POST", path, body, timeoutMs),
      shape,
    )
  } catch (error) {
    return { ok: false, ...unreachable(error) }
  }
}

export async function listFolder(
  instance: string,
  path: string | null,
  o: { readonly hidden?: boolean } = {},
): Promise<Listing | ListFailure> {
  const q = new URLSearchParams({ path: path ?? "" })
  if (o.hidden === true) q.set("hidden", "1")
  try {
    const reply = await agentFetch(instance, "GET", `/fs/list?${q.toString()}`)
    return parseListing(JSON.stringify(reply.body))
  } catch (error) {
    return unreachable(error) as ListFailure
  }
}

export const makeFolder = async (
  instance: string,
  path: string,
): Promise<OpResult<{ path: string }>> =>
  await call(instance, "/fs/mkdir", { path }, Path)

export const move = async (
  instance: string,
  from: string,
  to: string,
): Promise<OpResult<{ path: string }>> =>
  await call(instance, "/fs/rename", { from, to }, Path, 600_000)

export const copy = async (
  instance: string,
  from: string,
  to: string,
): Promise<OpResult<{ path: string }>> =>
  await call(instance, "/fs/copy", { from, to }, Path, 600_000)

export const remove = async (
  instance: string,
  paths: readonly string[],
  permanently = false,
): Promise<OpResult<{ deleted: number }>> =>
  await call(
    instance,
    "/fs/delete",
    { paths, recycle: !permanently },
    Deleted,
    630_000,
  )
