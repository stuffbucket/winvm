import { z } from "zod"

const Entry = z.object({
  name: z.string(),
  dir: z.boolean(),
  size: z.number().nullable(),
  modified: z.number().nullable(),
  hidden: z.boolean(),
})

export type Entry = z.infer<typeof Entry>

const PlaceKind = z.enum([
  "desktop",
  "documents",
  "downloads",
  "home",
  "work",
  "drive",
])

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

export type ListFailure = {
  readonly code: "notfound" | "denied" | "notdir" | "notrunning" | "other"
  readonly detail: string
}

const Failure = z.object({ error: z.string(), code: z.string().nullable() })
const CODES = new Set(["notfound", "denied", "notdir", "notrunning"])

export function parseListing(
  stdout: string,
  stderr = "",
): Listing | ListFailure {
  let raw: unknown = null
  try {
    raw = JSON.parse(stdout)
  } catch {}
  const ok = Listing.safeParse(raw)
  if (ok.success) return ok.data
  const failed = Failure.safeParse(raw)
  if (failed.success) {
    const code = failed.data.code ?? ""
    return {
      code: CODES.has(code) ? (code as ListFailure["code"]) : "other",
      detail: failed.data.error,
    }
  }
  return {
    code: "other",
    detail: [stdout, stderr]
      .filter((s) => s.trim() !== "")
      .join("\n")
      .trim(),
  }
}

export const isListing = (r: Listing | ListFailure): r is Listing =>
  "entries" in r

export function leafName(path: string): string {
  const parts = path.split("\\").filter((p) => p !== "")
  return parts[parts.length - 1] ?? path
}

export function crumbs(
  path: string,
): { readonly name: string; readonly path: string }[] {
  const parts = path.split("\\").filter((p) => p !== "")
  return parts.map((name, i) => ({
    name,
    path: i === 0 ? `${name}\\` : parts.slice(0, i + 1).join("\\"),
  }))
}

export const childPath = (folder: string, name: string): string =>
  folder.endsWith("\\") ? `${folder}${name}` : `${folder}\\${name}`

export function parentPath(path: string): string {
  const parts = path.split("\\").filter((p) => p !== "")
  return parts.length <= 1
    ? `${parts[0] ?? path}\\`
    : parts.length === 2
      ? `${parts[0] ?? ""}\\`
      : parts.slice(0, -1).join("\\")
}

const tidy = (path: string): string => path.replace(/\\+$/, "").toLowerCase()

export const isWithin = (path: string, folder: string): boolean => {
  const p = tidy(path)
  const f = tidy(folder)
  return p === f || p.startsWith(`${f}\\`)
}

export const samePath = (a: string, b: string): boolean => tidy(a) === tidy(b)

export const hostName = (path: string): string =>
  path
    .split("/")
    .filter((p) => p !== "")
    .pop() ?? path

export function freeName(
  name: string,
  taken: ReadonlySet<string>,
  folder = false,
): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  const dot = folder ? -1 : name.lastIndexOf(".")
  const [stem, ext] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
  for (let n = 2; ; n += 1) {
    const next = `${stem} (${String(n)})${ext}`
    if (!lower.has(next.toLowerCase())) return next
  }
}

export function formatBytes(bytes: number, locale?: string): string {
  const units = [
    "byte",
    "kilobyte",
    "megabyte",
    "gigabyte",
    "terabyte",
  ] as const
  let value = bytes
  let i = 0
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000
    i += 1
  }
  const digits = i > 0 && value < 10 ? 1 : 0
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[i],
    unitDisplay: i === 0 ? "long" : "short",
    maximumFractionDigits: digits,
  }).format(value)
}

type Label = (key: string, values?: Record<string, string>) => string

export interface FinderDate {
  readonly long: string
  readonly medium: string
  readonly short: string
}

const dayNumber = (d: Date): number =>
  Math.round(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000,
  )

export function finderDate(
  ms: number,
  now: number,
  label: Label,
  locale?: string,
): FinderDate {
  const when = new Date(ms)
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(
    when,
  )
  const ago = dayNumber(new Date(now)) - dayNumber(when)
  const day = ago === 0 ? "today" : ago === 1 ? "yesterday" : null
  if (day !== null) {
    return {
      long: label(`files.date.${day}`, { time }),
      medium: label(`files.date.${day}Medium`, { time }),
      short: label(`files.date.${day}Short`),
    }
  }
  const short = new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(
    when,
  )
  return {
    long: label("files.date.other", {
      date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        when,
      ),
      time,
    }),
    medium: label("files.date.otherMedium", { date: short, time }),
    short,
  }
}

export type SortKey = "name" | "modified" | "size" | "kind"

export interface Sort {
  readonly key: SortKey
  readonly descending: boolean
}

const byName = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

export function sortEntries(
  entries: readonly Entry[],
  sort: Sort,
  kind: (e: Entry) => string,
): Entry[] {
  const sign = sort.descending ? -1 : 1
  const numbers = (a: number | null, b: number | null): number =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : sign * (a - b)
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
    return c !== 0
      ? c
      : (sort.key === "name" ? sign : 1) * byName.compare(a.name, b.name)
  })
}

export function nameProblem(
  name: string,
): "empty" | "chars" | "reserved" | "ends" | null {
  if (name.trim() === "" || name === "." || name === "..") return "empty"
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return "chars"
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name))
    return "reserved"
  if (/[. ]$/.test(name)) return "ends"
  return null
}

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

export function findByPrefix(
  names: readonly string[],
  prefix: string,
  from: number,
): number | null {
  const p = prefix.toLowerCase()
  for (let k = 0; k < names.length; k += 1) {
    const i = (from + k) % names.length
    if ((names[i] ?? "").toLowerCase().startsWith(p)) return i
  }
  return null
}
