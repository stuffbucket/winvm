/**
 * What the Files window does to the guest's files, through winvm's own
 * `mkdir`, `mv`, `cp` and `rm` verbs with `--json`: each answers one JSON
 * object, the result or `{error, code}`.
 */
import { z } from "zod"

import { type Output, winvm } from "../../backend"

/** Why an operation failed; `other` covers anything the agent gave no code for. */
export type OpCode = "notfound" | "denied" | "exists" | "busy" | "into" | "notdir" | "notrunning" | "unavailable" | "other"

export type OpResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: OpCode; readonly detail: string }

const Failure = z.object({ error: z.string(), code: z.string().nullable().optional() })
const CODES = new Set<string>(["notfound", "denied", "exists", "busy", "into", "notdir", "notrunning", "unavailable"])

/** A verb's `--json` output read as `shape`, or why it failed. */
export function parseOp<T>(out: Output, shape: z.ZodType<T>): OpResult<T> {
  let raw: unknown = null
  try {
    raw = JSON.parse(out.stdout.trim().split("\n").pop() ?? "")
  } catch {
    // not JSON: whatever it said is the detail
  }
  if (out.code === 0) {
    const ok = shape.safeParse(raw)
    if (ok.success) return { ok: true, value: ok.data }
  }
  const failed = Failure.safeParse(raw)
  if (failed.success) {
    const code = failed.data.code ?? ""
    return { ok: false, code: CODES.has(code) ? (code as OpCode) : "other", detail: failed.data.error }
  }
  return { ok: false, code: "other", detail: [out.stdout, out.stderr].filter((s) => s.trim() !== "").join("\n").trim() }
}

const Path = z.object({ path: z.string() })
const Deleted = z.object({ deleted: z.number() })

const run = async (args: string[]): Promise<Output> =>
  await winvm(...args).catch((e: unknown) => ({ code: 1, stdout: "", stderr: String(e) }))

export const makeFolder = async (instance: string, path: string): Promise<OpResult<{ path: string }>> =>
  parseOp(await run(["mkdir", "-i", instance, path, "--json"]), Path)

/** Renames or moves `from` to exactly `to`, which must not exist. */
export const move = async (instance: string, from: string, to: string): Promise<OpResult<{ path: string }>> =>
  parseOp(await run(["mv", "-i", instance, from, to, "--json"]), Path)

/** Copies `from` (a file, or a folder and all in it) to exactly `to`, which must not exist. */
export const copy = async (instance: string, from: string, to: string): Promise<OpResult<{ path: string }>> =>
  parseOp(await run(["cp", "-i", instance, from, to, "--json"]), Path)

/** To the Recycle Bin, unless `permanently`. */
export const remove = async (instance: string, paths: readonly string[], permanently = false): Promise<OpResult<{ deleted: number }>> =>
  parseOp(await run(["rm", "-i", instance, ...paths, ...(permanently ? ["--permanently"] : []), "--json"]), Deleted)
