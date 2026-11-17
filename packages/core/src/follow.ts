import { fstatSync } from "node:fs"

import type { Args } from "./args"
import {
  type Cursor,
  type Entry,
  endCursor,
  type Position,
  readSinceEach,
  START,
} from "./eventlog"
import { listInstances } from "./paths"

export interface FollowOptions {
  readonly follow: boolean
  readonly json: boolean
  readonly instance?: string | null
  readonly since?: string | null
  readonly pollMs?: number
  readonly scanMs?: number
  readonly signal?: AbortSignal
  readonly write: (line: string) => void
  readonly error?: (message: string) => void
}

export type StreamLine =
  | {
      readonly type: "hello"
      readonly instances: readonly string[]
      readonly cursor: string
    }
  | {
      readonly type: "entry"
      readonly instance: string
      readonly entry: Entry
      readonly cursor: string
    }
  | { readonly type: "gap"; readonly instance: string; readonly cursor: string }
  | {
      readonly type: "instances"
      readonly instances: readonly string[]
      readonly cursor: string
    }
  | { readonly type: "end"; readonly cursor: string }

const TOKEN_VERSION = 1
const TOKEN_TEXT = /^[A-Za-z0-9_-]+$/

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0

function positionOf(v: unknown): Position | null {
  if (!isObject(v)) return null
  const { ino, generation, offset } = v
  if (!count(ino) || !count(offset)) return null
  if (generation !== null && typeof generation !== "string") return null
  return { ino, generation, offset }
}

function cursorOf(v: unknown): Cursor | null {
  const here = positionOf(v)
  if (here === null || !isObject(v)) return null
  if (v.archive === null) return { ...here, archive: null }
  const archive = positionOf(v.archive)
  return archive === null ? null : { ...here, archive }
}

export const encodeCursor = (at: ReadonlyMap<string, Cursor>): string =>
  Buffer.from(
    JSON.stringify({ v: TOKEN_VERSION, at: Object.fromEntries(at) }),
  ).toString("base64url")

export function decodeCursor(
  token: string,
): ReadonlyMap<string, Cursor> | null {
  if (!TOKEN_TEXT.test(token)) return null
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!isObject(raw) || raw.v !== TOKEN_VERSION || !isObject(raw.at))
    return null
  const out = new Map<string, Cursor>()
  for (const [name, c] of Object.entries(raw.at)) {
    const cursor = cursorOf(c)
    if (cursor === null) return null
    out.set(name, cursor)
  }
  return out
}

function describe(e: Entry): string {
  switch (e.kind) {
    case "qmp":
      return e.data === null ? e.event : `${e.event} ${JSON.stringify(e.data)}`
    case "sync":
      return e.status === null
        ? `sync failed: ${e.error ?? "no answer"}`
        : `sync ${e.status}`
    case "disconnected":
      return `disconnected (${e.reason})`
    case "op":
      if (e.phase === "begin")
        return `${e.operation} began (pid ${String(e.pid)})`
      return `${e.operation} ${e.ok ? "succeeded" : "failed"}${e.error === undefined ? "" : `: ${e.error}`}`
    case "service":
    case "warning":
    case "keeper":
      return `${e.kind}: ${e.what}`
  }
}

function plain(l: StreamLine): string | null {
  if (l.type === "entry")
    return `${l.entry.t}  ${l.instance}  ${describe(l.entry)}`
  if (l.type === "gap")
    return `${l.instance}: entries were rotated away before they were read`
  return null
}

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i])

async function nap(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((done) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      done()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", finish)
  })
}

export async function followEvents(o: FollowOptions): Promise<number> {
  const pollMs = o.pollMs ?? 500
  const scanMs = o.scanMs ?? 2000
  const named = o.instance ?? null
  let given: ReadonlyMap<string, Cursor> | null = null
  if (o.since === "start") given = new Map()
  else if (o.since !== undefined && o.since !== null) {
    given = decodeCursor(o.since)
    if (given === null) {
      o.error?.(
        `"${o.since}" is not a cursor winvm events gave out; use one from a line it printed, or --since start`,
      )
      return 2
    }
  }
  const listed = (): readonly string[] =>
    named === null ? [...listInstances()].sort() : [named]
  const first = (name: string): Cursor =>
    given !== null
      ? (given.get(name) ?? START)
      : o.follow
        ? endCursor(name)
        : START

  let names = listed()
  const at = new Map<string, Cursor>(names.map((n) => [n, first(n)]))
  const token = (): string => encodeCursor(at)
  const emit = (l: StreamLine): void => {
    const text = o.json ? JSON.stringify(l) : plain(l)
    if (text !== null) o.write(text)
  }

  const drain = (): void => {
    for (const name of names) {
      if (o.signal?.aborted === true) return
      const read = readSinceEach(name, at.get(name) ?? START)
      if (read.gap) emit({ type: "gap", instance: name, cursor: token() })
      for (const { entry, after } of read.placed) {
        at.set(name, after)
        emit({ type: "entry", instance: name, entry, cursor: token() })
      }
      at.set(name, read.cursor)
    }
  }

  const rescan = (): void => {
    const now = listed()
    if (sameNames(now, names)) return
    for (const n of now) if (!at.has(n)) at.set(n, given?.get(n) ?? START)
    names = now
    emit({ type: "instances", instances: names, cursor: token() })
  }

  emit({ type: "hello", instances: names, cursor: token() })
  drain()
  if (!o.follow) {
    emit({ type: "end", cursor: token() })
    return 0
  }
  let scanned = Date.now()
  for (;;) {
    await nap(pollMs, o.signal)
    if (o.signal?.aborted === true) return 0
    if (named === null && Date.now() - scanned >= scanMs) {
      rescan()
      scanned = Date.now()
    }
    drain()
  }
}

function stdinIsPipe(): boolean {
  try {
    const s = fstatSync(0)
    return s.isFIFO() || s.isSocket()
  } catch {
    return false
  }
}

export async function eventsCmd(args: Args): Promise<number> {
  const follow = args.flags.has("follow")
  const ac = new AbortController()
  const stop = (): void => {
    ac.abort()
  }
  if (follow) {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.on(sig, stop)
    if (stdinIsPipe()) {
      for (const ending of ["end", "close", "error"] as const)
        process.stdin.on(ending, stop)
      process.stdin.on("data", () => undefined)
    }
  }
  process.stdout.on("error", stop)
  return await followEvents({
    follow,
    json: args.flags.has("json"),
    instance: args.flags.get("instance") ?? process.env.WINVM_INSTANCE ?? null,
    since: args.flags.get("since") ?? null,
    signal: ac.signal,
    write: (line) => {
      process.stdout.write(`${line}\n`)
    },
    error: (message) => {
      console.error(`::error::${message}`)
    },
  })
}
