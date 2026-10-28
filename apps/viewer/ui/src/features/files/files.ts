/**
 * The guest file browser's model: `winvm dir --json` parsed, and the
 * Windows-path and display helpers the browser and the copies share. No React,
 * no backend, so tests run it as is.
 */
import { z } from "zod"

const Entry = z.object({
  name: z.string(),
  dir: z.boolean(),
  size: z.number().nullable(),
  modified: z.number().nullable(),
  hidden: z.boolean(),
})

export type Entry = z.infer<typeof Entry>

const PlaceKind = z.enum(["desktop", "documents", "downloads", "home", "work", "drive"])

const Place = z.object({ kind: PlaceKind, name: z.string(), path: z.string() })

export type Place = z.infer<typeof Place>

const Listing = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(Entry),
  total: z.number(),
  places: z.array(Place),
})

export type Listing = z.infer<typeof Listing>

/** Why a folder didn't open; `other` covers anything the agent gave no code for. */
export type ListFailure = { readonly code: "notfound" | "denied" | "notdir" | "notrunning" | "other"; readonly detail: string }

const Failure = z.object({ error: z.string(), code: z.string().nullable() })
const CODES = new Set(["notfound", "denied", "notdir", "notrunning"])

/** `winvm dir --json`'s output: the listing, or why there is none (it prints `{error, code}` then). */
export function parseListing(stdout: string, stderr = ""): Listing | ListFailure {
  let raw: unknown = null
  try {
    raw = JSON.parse(stdout)
  } catch {
    // not JSON: whatever it said is the detail
  }
  const ok = Listing.safeParse(raw)
  if (ok.success) return ok.data
  const failed = Failure.safeParse(raw)
  if (failed.success) {
    const code = failed.data.code ?? ""
    return { code: CODES.has(code) ? (code as ListFailure["code"]) : "other", detail: failed.data.error }
  }
  return { code: "other", detail: [stdout, stderr].filter((s) => s.trim() !== "").join("\n").trim() }
}

export const isListing = (r: Listing | ListFailure): r is Listing => "entries" in r

/** A Windows path's last part: the folder or file name, or `C:` for a drive's root. */
export function leafName(path: string): string {
  const parts = path.split("\\").filter((p) => p !== "")
  return parts[parts.length - 1] ?? path
}

/** `C:\Users\me` → C:\, C:\Users, C:\Users\me, each with the name to show for it. */
export function crumbs(path: string): { readonly name: string; readonly path: string }[] {
  const parts = path.split("\\").filter((p) => p !== "")
  return parts.map((name, i) => ({ name, path: i === 0 ? `${name}\\` : parts.slice(0, i + 1).join("\\") }))
}

export const childPath = (folder: string, name: string): string => (folder.endsWith("\\") ? `${folder}${name}` : `${folder}\\${name}`)

/** Mac paths: the name after the last slash. */
export const hostName = (path: string): string => path.split("/").filter((p) => p !== "").pop() ?? path

/**
 * A free name in a Windows folder, as Explorer makes one: `report.txt`, else
 * `report (2).txt`, `report (3).txt`… Windows names don't differ by case.
 */
export function freeName(name: string, taken: ReadonlySet<string>, folder = false): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  const dot = folder ? -1 : name.lastIndexOf(".")
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
  for (let n = 2; ; n += 1) {
    const next = `${stem} (${String(n)})${ext}`
    if (!lower.has(next.toLowerCase())) return next
  }
}

/** Sizes as Finder shows them, in powers of 1000: 812 bytes, 12 kB, 3.4 MB. */
export function formatBytes(bytes: number, locale?: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const
  let value = bytes
  let i = 0
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000
    i += 1
  }
  const digits = i > 0 && value < 10 ? 1 : 0
  return new Intl.NumberFormat(locale, { style: "unit", unit: units[i], unitDisplay: i === 0 ? "long" : "short", maximumFractionDigits: digits }).format(value)
}

/** A last-written time as its day and its time of day, so a narrow list can drop the time. */
export const formatModified = (ms: number, locale?: string): { readonly day: string; readonly time: string } => ({
  day: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(ms)),
  time: new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(ms)),
})

/**
 * The selection after a click on row `i`: plain picks it alone, ⌘ toggles it,
 * ⇧ takes the range from the anchor. Returns the new selection and anchor.
 */
export function clickSelect(
  selected: ReadonlySet<number>,
  anchor: number | null,
  i: number,
  mods: { readonly toggle: boolean; readonly range: boolean },
): { selected: Set<number>; anchor: number } {
  if (mods.range && anchor !== null) {
    const [a, b] = anchor < i ? [anchor, i] : [i, anchor]
    const next = mods.toggle ? new Set(selected) : new Set<number>()
    for (let k = a; k <= b; k += 1) next.add(k)
    return { selected: next, anchor }
  }
  if (mods.toggle) {
    const next = new Set(selected)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    return { selected: next, anchor: i }
  }
  return { selected: new Set([i]), anchor: i }
}

/** Type-to-select: the first row at or after `from` whose name starts with `prefix`, wrapping; else null. */
export function findByPrefix(names: readonly string[], prefix: string, from: number): number | null {
  const p = prefix.toLowerCase()
  for (let k = 0; k < names.length; k += 1) {
    const i = (from + k) % names.length
    if ((names[i] ?? "").toLowerCase().startsWith(p)) return i
  }
  return null
}
