import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs"

import { linkNew } from "./exclusive"
import { pathsFor } from "./paths"

type Json = Record<string, unknown>

export interface QmpTimestamp {
  readonly seconds: number
  readonly microseconds: number
}

interface Stamp {
  readonly t: string
  readonly instance: string
}

export interface QmpFields {
  readonly kind: "qmp"
  readonly event: string
  readonly data: Json | null
  readonly timestamp: QmpTimestamp | null
  readonly legacy?: true
}

export interface SyncFields {
  readonly kind: "sync"
  readonly status: string | null
  readonly running: boolean | null
  readonly error?: string
}

export type DisconnectReason = "qemu-closed" | "drain-timeout"

export interface DisconnectedFields {
  readonly kind: "disconnected"
  readonly reason: DisconnectReason
}

export interface OpIdentity {
  readonly id: string
  readonly operation: string
  readonly pid: number
  readonly startedAt: string
  readonly automatic: boolean
  readonly leased: boolean
}

export interface OpBeginFields extends OpIdentity {
  readonly kind: "op"
  readonly phase: "begin"
}

export interface OpOutcome {
  readonly ok: boolean
  readonly exitCode?: number
  readonly error?: string
  readonly abandoned?: true
  readonly irreversibleAt?: string
}

export interface OpEndFields extends OpIdentity, OpOutcome {
  readonly kind: "op"
  readonly phase: "end"
  readonly endedAt: string
}

export interface NoteFields {
  readonly kind: "service" | "warning"
  readonly what: string
  readonly [field: string]: unknown
}

export type EntryFields =
  | QmpFields
  | SyncFields
  | DisconnectedFields
  | OpBeginFields
  | OpEndFields
  | NoteFields

export type QmpEntry = QmpFields & Stamp
export type SyncEntry = SyncFields & Stamp
export type OpEntry = (OpBeginFields | OpEndFields) & Stamp
export type Entry = EntryFields & Stamp

export interface Position {
  readonly ino: number
  readonly generation: string | null
  readonly offset: number
}

export interface Cursor extends Position {
  readonly archive: Position | null
}

export const START: Cursor = {
  ino: 0,
  generation: null,
  offset: 0,
  archive: null,
}

export interface Batch {
  readonly entries: readonly Entry[]
  readonly cursor: Cursor
  readonly gap: boolean
}

export const MAX_LINE_BYTES = 8192
export const DEFAULT_MAX_BYTES = 1 << 20
const SHORT_FIELD = 256
const TAIL_BYTES = 64 * 1024
const READ_LIMIT = 2 * DEFAULT_MAX_BYTES
const LINE_START = '{"t":"'
const GENERATION = "generation"
const HEADER_BYTES = 512

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function lineFor(instance: string, fields: EntryFields): string {
  const { t: _t, instance: _instance, ...rest } = fields as Json
  const head = { t: new Date().toISOString(), instance }
  const full = JSON.stringify({ ...head, ...rest })
  const bytes = Buffer.byteLength(full)
  if (bytes < MAX_LINE_BYTES) return full
  const short = Object.fromEntries(
    Object.entries(rest).filter(
      ([, v]) =>
        v !== undefined &&
        typeof v !== "function" &&
        typeof v !== "symbol" &&
        JSON.stringify(v).length <= SHORT_FIELD,
    ),
  )
  const slim = JSON.stringify({ ...head, ...short, truncated: bytes })
  return Buffer.byteLength(slim) < MAX_LINE_BYTES
    ? slim
    : JSON.stringify({ ...head, kind: fields.kind, truncated: bytes })
}

const APPEND = constants.O_WRONLY | constants.O_APPEND

const headerFor = (instance: string): string =>
  `${JSON.stringify({
    t: new Date().toISOString(),
    instance,
    kind: GENERATION,
    generation: randomUUID(),
  })}\n`

function openAppending(instance: string): number {
  const file = pathsFor(instance).events
  try {
    return openSync(file, APPEND)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
  linkNew(file, headerFor(instance))
  return openSync(file, APPEND)
}

export function appendEntry(
  instance: string,
  fields: EntryFields,
): string | null {
  let line: string
  let fd: number
  try {
    line = lineFor(instance, fields)
    fd = openAppending(instance)
  } catch {
    return null
  }
  const bytes = Buffer.from(`${line}\n`)
  try {
    return writeSync(fd, bytes) === bytes.length ? line : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export function rotateEvents(
  instance: string,
  maxBytes: number,
  allowed: () => boolean = () => true,
): boolean {
  const p = pathsFor(instance)
  try {
    const size = statSync(p.events, { throwIfNoEntry: false })?.size
    if (size === undefined || size < maxBytes || !allowed()) return false
    renameSync(p.events, p.eventsPrev)
    return true
  } catch {
    return false
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

const timestampOf = (v: unknown): QmpTimestamp | null =>
  isObject(v) &&
  typeof v.seconds === "number" &&
  typeof v.microseconds === "number"
    ? { seconds: v.seconds, microseconds: v.microseconds }
    : null

export const qmpFields = (e: Json): QmpFields => ({
  kind: "qmp",
  event: str(e.event) ?? "",
  data: isObject(e.data) ? e.data : null,
  timestamp: timestampOf(e.timestamp),
})

export function syncFields(reply: Json): SyncFields {
  const r = reply.return
  if (isObject(r))
    return {
      kind: "sync",
      status: str(r.status),
      running: typeof r.running === "boolean" ? r.running : null,
    }
  const error = isObject(reply.error) ? str(reply.error.desc) : null
  return {
    kind: "sync",
    status: null,
    running: null,
    error: error ?? "query-status gave no answer",
  }
}

const LEGACY_EVENTS: Readonly<Record<string, string>> = {
  paused: "STOP",
  running: "RESUME",
  stopped: "SHUTDOWN",
  reset: "RESET",
  migration: "MIGRATION",
}

function legacyEntry(stamp: Stamp, r: Json): Entry | null {
  const state = str(r.state)
  const event = state === null ? undefined : LEGACY_EVENTS[state]
  if (event === undefined) return null
  const status = str(r.status)
  const data =
    event === "MIGRATION"
      ? status === null
        ? null
        : { status }
      : isObject(r.data)
        ? r.data
        : null
  return {
    ...stamp,
    kind: "qmp",
    event,
    data,
    timestamp: null,
    legacy: true,
  }
}

function opEntry(stamp: Stamp, r: Json): Entry | null {
  const id = str(r.id)
  const operation = str(r.operation)
  const startedAt = str(r.startedAt)
  if (
    id === null ||
    operation === null ||
    startedAt === null ||
    typeof r.pid !== "number" ||
    typeof r.automatic !== "boolean" ||
    typeof r.leased !== "boolean"
  )
    return null
  const who: OpIdentity = {
    id,
    operation,
    pid: r.pid,
    startedAt,
    automatic: r.automatic,
    leased: r.leased,
  }
  if (r.phase === "begin")
    return { ...stamp, kind: "op", phase: "begin", ...who }
  const endedAt = str(r.endedAt)
  if (r.phase !== "end" || endedAt === null || typeof r.ok !== "boolean")
    return null
  const error = str(r.error)
  const irreversibleAt = str(r.irreversibleAt)
  return {
    ...stamp,
    kind: "op",
    phase: "end",
    ...who,
    endedAt,
    ok: r.ok,
    ...(typeof r.exitCode === "number" ? { exitCode: r.exitCode } : {}),
    ...(error === null ? {} : { error }),
    ...(r.abandoned === true ? { abandoned: true as const } : {}),
    ...(irreversibleAt === null ? {} : { irreversibleAt }),
  }
}

function entryOf(r: Json): Entry | null {
  const t = str(r.t)
  const instance = str(r.instance)
  if (t === null || instance === null) return null
  const stamp: Stamp = { t, instance }
  switch (r.kind) {
    case "qmp": {
      const event = str(r.event)
      if (event === null) return null
      return {
        ...stamp,
        kind: "qmp",
        event,
        data: isObject(r.data) ? r.data : null,
        timestamp: timestampOf(r.timestamp),
        ...(r.legacy === true ? { legacy: true as const } : {}),
      }
    }
    case "state":
      return legacyEntry(stamp, r)
    case "sync": {
      const error = str(r.error)
      return {
        ...stamp,
        kind: "sync",
        status: str(r.status),
        running: typeof r.running === "boolean" ? r.running : null,
        ...(error === null ? {} : { error }),
      }
    }
    case "disconnected":
      return {
        ...stamp,
        kind: "disconnected",
        reason: r.reason === "drain-timeout" ? "drain-timeout" : "qemu-closed",
      }
    case "op":
      return opEntry(stamp, r)
    case "service":
    case "warning": {
      const what = str(r.what)
      return what === null ? null : { ...r, ...stamp, kind: r.kind, what }
    }
    default:
      return null
  }
}

function decode(line: string): Entry | null {
  try {
    const v: unknown = JSON.parse(line)
    return isObject(v) ? entryOf(v) : null
  } catch {
    return null
  }
}

export function parseEntry(line: string): Entry | null {
  const whole = decode(line)
  if (whole !== null) return whole
  const after = line.indexOf(LINE_START, 1)
  return after < 0 ? null : parseEntry(line.slice(after))
}

interface Opened {
  readonly fd: number
  readonly ino: number
  readonly generation: string | null
  readonly size: number
}

function generationOf(fd: number, size: number): string | null {
  const buf = Buffer.alloc(Math.min(size, HEADER_BYTES))
  const n = readSync(fd, buf, 0, buf.length, 0)
  const nl = buf.subarray(0, n).indexOf(0x0a)
  if (nl < 0) return null
  try {
    const v: unknown = JSON.parse(buf.subarray(0, nl).toString("utf8"))
    return isObject(v) && v.kind === GENERATION ? str(v.generation) : null
  } catch {
    return null
  }
}

function openRecord(file: string, seams: ReadSeams = {}): Opened | null {
  try {
    const fd = openSync(file, "r")
    const s = fstatSync(fd)
    return {
      fd,
      ino: seams.inode?.(s.ino) ?? s.ino,
      generation: generationOf(fd, s.size),
      size: s.size,
    }
  } catch {
    return null
  }
}

function readFrom(o: Opened, from: number): Buffer {
  const length = Math.max(0, o.size - from)
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const n = readSync(o.fd, buf, got, length - got, from + got)
    if (n === 0) break
    got += n
  }
  return buf.subarray(0, got)
}

interface Line {
  readonly text: string
  readonly end: number
}

interface Lines {
  readonly lines: readonly Line[]
  readonly end: number
  readonly skipped: boolean
}

function wholeLines(o: Opened, from: number): Lines {
  const bounded = Math.max(from, o.size - READ_LIMIT)
  const buf = readFrom(o, bounded)
  const lines: Line[] = []
  let at = bounded > from ? buf.indexOf(0x0a) + 1 : 0
  for (;;) {
    const nl = buf.indexOf(0x0a, at)
    if (nl < 0) break
    lines.push({
      text: buf.subarray(at, nl).toString("utf8"),
      end: bounded + nl + 1,
    })
    at = nl + 1
  }
  return { lines, end: bounded + at, skipped: bounded > from }
}

type Item = Placed

interface Scan {
  readonly items: readonly Item[]
  readonly cursor: Cursor
  readonly gap: boolean
}

const itemsOf = (read: Lines | null, after: (end: number) => Cursor): Item[] =>
  (read?.lines ?? []).flatMap((l) => {
    const entry = parseEntry(l.text)
    return entry === null ? [] : [{ entry, after: after(l.end) }]
  })

const closeAll = (...opened: readonly (Opened | null)[]): void => {
  for (const o of opened) if (o !== null) closeSync(o.fd)
}

const sameFile = (o: Opened, at: Position): boolean =>
  o.generation !== null || at.generation !== null
    ? o.generation === at.generation
    : at.ino !== 0 && o.ino === at.ino

const holds = (o: Opened | null, at: Position | null): o is Opened =>
  o !== null && at !== null && sameFile(o, at)

const at = (o: Opened, offset: number): Position => ({
  ino: o.ino,
  generation: o.generation,
  offset,
})

function archiveBeside(cur: Opened | null, prev: Opened | null): Opened | null {
  if (prev === null || cur === null || prev.ino !== cur.ino) return prev
  closeSync(prev.fd)
  return null
}

export interface ReadSeams {
  readonly betweenOpens?: () => void
  readonly inode?: (real: number) => number
}

function openBoth(
  instance: string,
  seams: ReadSeams,
): { readonly cur: Opened | null; readonly prev: Opened | null } {
  const p = pathsFor(instance)
  const cur = openRecord(p.events, seams)
  seams.betweenOpens?.()
  return { cur, prev: archiveBeside(cur, openRecord(p.eventsPrev, seams)) }
}

function readCurrent(cur: Opened, prev: Opened | null, cursor: Cursor): Scan {
  const tracked = holds(prev, cursor.archive) ? prev : null
  const from = cursor.archive?.offset ?? 0
  const late =
    tracked === null ? null : wholeLines(tracked, Math.min(from, tracked.size))
  const shrunk = cur.size < cursor.offset
  const base = shrunk ? 0 : cursor.offset
  const now = wholeLines(cur, base)
  const archive =
    tracked === null || late === null ? null : at(tracked, late.end)
  return {
    items: [
      ...(tracked === null
        ? []
        : itemsOf(late, (end) => ({
            ...at(cur, base),
            archive: at(tracked, end),
          }))),
      ...itemsOf(now, (end) => ({ ...at(cur, end), archive })),
    ],
    cursor: { ...at(cur, now.end), archive },
    gap: shrunk || now.skipped || late?.skipped === true,
  }
}

function readAcross(
  cur: Opened | null,
  prev: Opened | null,
  cursor: Cursor,
): Scan {
  const fromPrev = holds(prev, cursor)
  const older =
    prev === null
      ? null
      : wholeLines(prev, fromPrev ? Math.min(cursor.offset, prev.size) : 0)
  const now = cur === null ? null : wholeLines(cur, 0)
  const left = prev === null || older === null ? null : at(prev, older.end)
  return {
    items: [
      ...(prev === null
        ? []
        : itemsOf(older, (end) => ({
            ...at(prev, end),
            archive: null,
          }))),
      ...(cur === null
        ? []
        : itemsOf(now, (end) => ({ ...at(cur, end), archive: left }))),
    ],
    cursor:
      cur !== null && now !== null
        ? { ...at(cur, now.end), archive: left }
        : left === null
          ? START
          : { ...left, archive: null },
    gap:
      ((cursor.ino !== 0 || cursor.generation !== null) && !fromPrev) ||
      older?.skipped === true ||
      now?.skipped === true,
  }
}

function scan(instance: string, cursor: Cursor, seams: ReadSeams = {}): Scan {
  const { cur, prev } = openBoth(instance, seams)
  try {
    return holds(cur, cursor)
      ? readCurrent(cur, prev, cursor)
      : readAcross(cur, prev, cursor)
  } finally {
    closeAll(prev, cur)
  }
}

export function readSince(
  instance: string,
  cursor: Cursor,
  seams: ReadSeams = {},
): Batch {
  const s = scan(instance, cursor, seams)
  return { entries: s.items.map((i) => i.entry), cursor: s.cursor, gap: s.gap }
}

export interface Placed {
  readonly entry: Entry
  readonly after: Cursor
}

export interface PlacedBatch {
  readonly placed: readonly Placed[]
  readonly cursor: Cursor
  readonly gap: boolean
}

export function readSinceEach(
  instance: string,
  cursor: Cursor,
  seams: ReadSeams = {},
): PlacedBatch {
  const s = scan(instance, cursor, seams)
  return { placed: s.items, cursor: s.cursor, gap: s.gap }
}

function lastLineEnd(o: Opened): number {
  const from = Math.max(0, o.size - TAIL_BYTES)
  const at = readFrom(o, from).lastIndexOf(0x0a)
  if (at >= 0) return from + at + 1
  return from === 0 ? 0 : o.size
}

const endOf = (o: Opened): Position => at(o, lastLineEnd(o))

export function endCursor(instance: string): Cursor {
  const { cur, prev } = openBoth(instance, {})
  try {
    if (cur !== null)
      return { ...endOf(cur), archive: prev === null ? null : endOf(prev) }
    return prev === null ? START : { ...endOf(prev), archive: null }
  } finally {
    closeAll(prev, cur)
  }
}

export const qmpEvent =
  (...names: readonly string[]) =>
  (e: Entry): e is QmpEntry =>
    e.kind === "qmp" && names.includes(e.event)

export interface WaitOptions {
  readonly since?: Cursor
  readonly pollMs?: number
  readonly streamPollMs?: number
  readonly signal?: AbortSignal
}

class Alarm {
  private rung = false
  private wake: (() => void) | null = null

  ring(): void {
    this.rung = true
    this.wake?.()
  }

  async nap(ms: number): Promise<void> {
    if (!this.rung)
      await new Promise<void>((r) => {
        const done = (): void => {
          clearTimeout(timer)
          this.wake = null
          r()
        }
        const timer = setTimeout(done, ms)
        this.wake = done
      })
    this.rung = false
  }
}

class ServiceStream {
  private readonly control: string
  private readonly onChange: () => void
  private ac: AbortController | null = null
  private retryAt = 0
  live = false

  constructor(control: string, onChange: () => void) {
    this.control = control
    this.onChange = onChange
  }

  ensure(retryMs: number): void {
    if (this.ac !== null || Date.now() < this.retryAt) return
    const ac = new AbortController()
    this.ac = ac
    void this.follow(ac).finally(() => {
      if (this.ac !== ac) return
      this.ac = null
      this.live = false
      this.retryAt = Date.now() + retryMs
      this.onChange()
    })
  }

  close(): void {
    const ac = this.ac
    this.ac = null
    this.live = false
    ac?.abort()
  }

  private async follow(ac: AbortController): Promise<void> {
    try {
      const res = await fetch("http://localhost/events", {
        unix: this.control,
        signal: ac.signal,
      })
      const body = res.body
      if (!res.ok || body === null) return
      const reader = body.getReader()
      this.live = true
      this.onChange()
      for (;;) {
        const r = await reader.read()
        if (r.done) return
        this.onChange()
      }
    } catch {
      return
    }
  }
}

export interface Found<E extends Entry> {
  readonly entry: E
  readonly cursor: Cursor
  readonly gap: boolean
}

export function waitForEvent<E extends Entry>(
  instance: string,
  predicate: (e: Entry) => e is E,
  deadline: number,
  o?: WaitOptions,
): Promise<Found<E> | null>
export function waitForEvent(
  instance: string,
  predicate: (e: Entry) => boolean,
  deadline: number,
  o?: WaitOptions,
): Promise<Found<Entry> | null>
export async function waitForEvent(
  instance: string,
  predicate: (e: Entry) => boolean,
  deadline: number,
  o: WaitOptions = {},
): Promise<Found<Entry> | null> {
  if (!Number.isFinite(deadline))
    throw new RangeError(
      `waitForEvent needs a deadline in epoch milliseconds, not ${String(deadline)}`,
    )
  const pollMs = o.pollMs ?? 250
  const streamPollMs = o.streamPollMs ?? 2000
  const alarm = new Alarm()
  const ring = (): void => {
    alarm.ring()
  }
  const stream = new ServiceStream(pathsFor(instance).control, ring)
  o.signal?.addEventListener("abort", ring)
  let cursor = o.since ?? endCursor(instance)
  let gap = false
  try {
    for (;;) {
      o.signal?.throwIfAborted()
      const s = scan(instance, cursor)
      gap ||= s.gap
      const hit = s.items.find((i) => predicate(i.entry))
      if (hit !== undefined) return { entry: hit.entry, cursor: hit.after, gap }
      cursor = s.cursor
      const left = deadline - Date.now()
      if (left <= 0) return null
      stream.ensure(pollMs)
      await alarm.nap(Math.min(left, stream.live ? streamPollMs : pollMs))
    }
  } finally {
    o.signal?.removeEventListener("abort", ring)
    stream.close()
  }
}
