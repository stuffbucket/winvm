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

/** The folder a Windows path is in; a drive's root is its own. */
export function parentPath(path: string): string {
  const parts = path.split("\\").filter((p) => p !== "")
  return parts.length <= 1 ? `${parts[0] ?? path}\\` : parts.length === 2 ? `${parts[0] ?? ""}\\` : parts.slice(0, -1).join("\\")
}

const tidy = (path: string): string => path.replace(/\\+$/, "").toLowerCase()

/** Whether `path` is `folder` or somewhere inside it (Windows paths don't differ by case). */
export const isWithin = (path: string, folder: string): boolean => {
  const p = tidy(path)
  const f = tidy(folder)
  return p === f || p.startsWith(`${f}\\`)
}

/** Whether two Windows paths name the same place. */
export const samePath = (a: string, b: string): boolean => tidy(a) === tidy(b)

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

type Label = (key: string, values?: Record<string, string>) => string

/** A last-written time as Finder words it, at three widths: the list shows the widest that fits. */
export interface FinderDate {
  /** "Today at 1:33 PM", "Yesterday at 9:02 AM", "Oct 19, 2026 at 2:02 PM" */
  readonly long: string
  /** "Today, 1:33 PM", "10/19/26, 2:02 PM" */
  readonly medium: string
  /** "Today", "Yesterday", "10/19/26" */
  readonly short: string
}

const dayNumber = (d: Date): number => Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000)

export function finderDate(ms: number, now: number, label: Label, locale?: string): FinderDate {
  const when = new Date(ms)
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(when)
  const ago = dayNumber(new Date(now)) - dayNumber(when)
  const day = ago === 0 ? "today" : ago === 1 ? "yesterday" : null
  if (day !== null) {
    return {
      long: label(`files.date.${day}`, { time }),
      medium: label(`files.date.${day}Medium`, { time }),
      short: label(`files.date.${day}Short`),
    }
  }
  const short = new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(when)
  return {
    long: label("files.date.other", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(when), time }),
    medium: label("files.date.otherMedium", { date: short, time }),
    short,
  }
}

export type SortKey = "name" | "modified" | "size" | "kind"

export interface Sort {
  readonly key: SortKey
  readonly descending: boolean
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * Entries in the order the list shows them: folders first whatever the
 * column, then by the column (ties by name), reversed when descending. An
 * entry with no size or time sorts after those that have one.
 */
export function sortEntries(entries: readonly Entry[], sort: Sort, kind: (e: Entry) => string): Entry[] {
  const sign = sort.descending ? -1 : 1
  // Missing values go last whichever way the column runs; only real values reverse.
  const numbers = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : sign * (a - b))
  const column = (a: Entry, b: Entry): number => {
    switch (sort.key) {
      case "name":
        return 0
      case "size":
        return numbers(a.size, b.size)
      case "modified":
        return numbers(a.modified, b.modified)
      case "kind":
        return sign * byName.compare(kind(a), kind(b))
    }
  }
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    const c = column(a, b)
    // Ties go by name, A to Z, unless the names are what is reversed.
    return c !== 0 ? c : (sort.key === "name" ? sign : 1) * byName.compare(a.name, b.name)
  })
}

/** Why Windows would refuse `name` for a file or folder, or null when it is fine. */
export function nameProblem(name: string): "empty" | "chars" | "reserved" | "ends" | null {
  if (name.trim() === "" || name === "." || name === "..") return "empty"
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return "chars"
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return "reserved"
  if (/[. ]$/.test(name)) return "ends"
  return null
}

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
