/**
 * `winvm toasts` — the notifications (toasts) apps raised in the guest, read
 * from Windows' own record of them rather than from the screen.
 *
 *   winvm toasts [-i name] [--since T] [--app A] [--find TEXT] [--wait S] [--json]
 *
 * Windows keeps every toast it accepts in the logged-on user's Windows Push
 * Notification database, %LOCALAPPDATA%\Microsoft\Windows\Notifications\
 * wpndatabase.db (SQLite, WAL mode, held open by WpnUserService). The in-guest
 * agent runs as that user, so it copies the database and its -wal/-shm out
 * over HTTP and bun:sqlite reads the copy on the host. The record exists
 * whether or not the toast popped up: the image switches popups and the
 * notification centre off (assets/logon.ps1), and toasts are recorded anyway.
 *
 * A toast stays in the table until it is dismissed or expires (days), so a
 * "did it fire?" check wants `--since` (an ISO time, or "90s"/"5m"/"2h" ago).
 * Times are the guest's clock, which winvm keeps on the host's.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Database } from "bun:sqlite"

import * as agent from "./agent"
import { AgentError } from "./agent"
import type { Args } from "./args"
import { instanceName } from "./args"
import { pathsFor } from "./paths"
import * as qemu from "./qemu"

export interface Toast {
  readonly id: number
  /** The app's id: an AppUserModelID (e.g. co.stuffbucket.maximal) or a package's. */
  readonly app: string
  readonly arrived: string
  readonly expires: string | null
  /** The <text> elements, in order; the first is the title. Empty ones dropped. */
  readonly texts: readonly string[]
  readonly tag: string | null
  readonly group: string | null
  readonly payload: string
}

/** Windows FILETIME (100 ns ticks since 1601) -> ISO time. */
export function fileTimeToIso(ft: number | bigint | null): string | null {
  if (ft === null) return null
  const ms = Number(BigInt(ft) / 10_000n) - 11_644_473_600_000
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString()
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e.startsWith("#x") || e.startsWith("#X")
      ? String.fromCodePoint(Number.parseInt(e.slice(2), 16))
      : e.startsWith("#")
        ? String.fromCodePoint(Number(e.slice(1)))
        : (ENTITIES[e] ?? m),
  )

/** The text lines of a toast's XML payload. */
export function toastTexts(xml: string): string[] {
  return [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decode(m[1] ?? "").trim()).filter((t) => t !== "")
}

/** "90s" / "5m" / "2h" / "1d" ago, or an ISO date/time. */
export function parseSince(v: string, now = Date.now()): Date | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(v.trim())
  if (m !== null) {
    const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"]
    return new Date(now - Number(m[1]) * mult)
  }
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Every toast in a copy of wpndatabase.db, oldest first. */
export function readDb(file: string): Toast[] {
  const db = new Database(file)
  try {
    const rows = db
      .query(
        `SELECT n.Id AS id, h.PrimaryId AS app, n.ArrivalTime AS arrival, n.ExpiryTime AS expiry, n.Payload AS payload,
                n.Tag AS tag, n.[Group] AS grp
           FROM Notification n LEFT JOIN NotificationHandler h ON h.RecordId = n.HandlerId
          WHERE n.Type = 'toast' ORDER BY n.ArrivalTime, n.[Order]`,
      )
      .all() as { id: number; app: string | null; arrival: number | bigint | null; expiry: number | bigint | null; payload: Uint8Array | string | null; tag: string | null; grp: string | null }[]
    return rows.map((r) => {
      const payload = r.payload === null ? "" : typeof r.payload === "string" ? r.payload : new TextDecoder().decode(r.payload)
      return {
        id: r.id,
        app: r.app ?? "",
        arrived: fileTimeToIso(r.arrival) ?? "",
        expires: fileTimeToIso(r.expiry),
        texts: toastTexts(payload),
        tag: r.tag,
        group: r.grp,
        payload,
      }
    })
  } finally {
    db.close()
  }
}

export interface Filter {
  readonly since?: Date | null
  readonly app?: string | null
  readonly find?: string | null
}

export function filterToasts(all: readonly Toast[], f: Filter): Toast[] {
  const app = f.app?.toLowerCase() ?? null
  const find = f.find?.toLowerCase() ?? null
  return all.filter(
    (t) =>
      (f.since == null || t.arrived >= f.since.toISOString()) &&
      (app === null || t.app.toLowerCase().includes(app)) &&
      (find === null || t.texts.some((x) => x.toLowerCase().includes(find))),
  )
}

/** Copy the guest's notification database out and read it. */
export async function readToasts(name: string): Promise<{ toasts: Toast[]; ms: number }> {
  const t0 = performance.now()
  const c = await agent.connect(name, { timeoutMs: 5000 })
  if (c === null) throw new Error(`instance "${name}" has no agent answering (toasts are per user; qemu-ga runs as SYSTEM) — \`winvm agent install -i ${name}\``)
  const dir = mkdtempSync(resolve(tmpdir(), "winvm-wpn-"))
  try {
    const base = `${(await c.pwsh("$env:LOCALAPPDATA")).output.trim()}\\Microsoft\\Windows\\Notifications\\wpndatabase.db`
    const parts = await Promise.all(
      ["", "-wal", "-shm"].map(async (s) => {
        try {
          return [s, await c.get(`${base}${s}`, 30_000)] as const
        } catch (error) {
          if (error instanceof AgentError && error.status === 404 && s !== "") return [s, null] as const
          throw error
        }
      }),
    )
    for (const [s, bytes] of parts) if (bytes !== null) writeFileSync(resolve(dir, `wpndatabase.db${s}`), bytes)
    return { toasts: readDb(resolve(dir, "wpndatabase.db")), ms: performance.now() - t0 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const line = (t: Toast): string => `${t.arrived.replace(/\.\d+Z$/, "Z")}  ${t.app}  ${t.texts.join(" — ")}`

export async function toasts(args: Args): Promise<number> {
  const name = instanceName(args)
  if (!qemu.isRunning(pathsFor(name))) {
    console.error(`::error::instance "${name}" is not running`)
    return 1
  }
  const sinceRaw = args.flags.get("since")
  const since = sinceRaw === undefined ? null : parseSince(sinceRaw)
  if (sinceRaw !== undefined && since === null) {
    console.error(`::error::--since takes an ISO time or an age like 90s, 5m, 2h (got "${sinceRaw}")`)
    return 1
  }
  const f: Filter = { since, app: args.flags.get("app") ?? null, find: args.flags.get("find") ?? null }
  const deadline = Date.now() + Number(args.flags.get("wait") ?? 0) * 1000
  try {
    for (;;) {
      const { toasts: all } = await readToasts(name)
      const hits = filterToasts(all, f)
      if (hits.length > 0 || Date.now() >= deadline) {
        if (args.flags.has("json")) console.log(JSON.stringify(hits, null, 2))
        else for (const t of hits) console.log(line(t))
        if (hits.length === 0 && (f.find != null || f.app != null || f.since != null)) {
          console.error("::error::no matching toast")
          return 1
        }
        return 0
      }
      await Bun.sleep(500)
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
