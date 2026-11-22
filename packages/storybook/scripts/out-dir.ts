import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path"

export const OWN = ["light", "dark", "index.html", "index.md"] as const
export const MARKER = ".storybook-shots"

export interface Guarded {
  readonly home: string
  readonly repo: string
  readonly storybook: string
}

export function resolveOut(arg: string, base: string): string {
  return isAbsolute(arg) ? resolve(arg) : resolve(base, arg)
}

export function realOut(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(realOut(parent), basename(path))
}

const covers = (dir: string, path: string): boolean => {
  const rel = relative(dir, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export function refusal(
  out: string,
  guarded: Guarded,
  entries: readonly string[] | null,
): string | null {
  if (parse(out).root === out) return `${out} is a filesystem root`
  const named: readonly (readonly [string, string])[] = [
    ["home", guarded.home],
    ["repository", guarded.repo],
    ["Storybook package", guarded.storybook],
  ]
  for (const [what, path] of named)
    if (covers(out, path))
      return `${out} is or contains the ${what} directory (${path})`
  if (entries === null || entries.includes(MARKER)) return null
  const own: readonly string[] = OWN
  const foreign = entries.filter((entry) => !own.includes(entry))
  return foreign.length === 0
    ? null
    : `${out} holds files storybook:shots did not write (${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""})`
}

export function entriesOf(out: string): string[] | null {
  if (!existsSync(out)) return null
  if (!statSync(out).isDirectory()) return ["(not a directory)"]
  return readdirSync(out)
}

const isRealDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

export function prepareOut(out: string, everything: boolean): void {
  for (const entry of [...OWN, MARKER]) {
    const path = join(out, entry)
    const keep = !everything && !entry.includes(".") && isRealDirectory(path)
    if (!keep) rmSync(path, { recursive: true, force: true })
  }
  writeFileSync(
    join(out, MARKER),
    "written by packages/storybook/scripts/shots.ts\n",
  )
}
