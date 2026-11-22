import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const GLOBS = ["ui/src/**/*.css", "../../packages/canvas/src/**/*.css"]
const TOKENS_FILE = "ui/src/styles/tokens.css"

export function cssFiles(): string[] {
  return GLOBS.flatMap((pattern) =>
    [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })].sort(),
  ).filter((file) => file !== TOKENS_FILE)
}

export interface MagicCounts {
  readonly px: number
  readonly ms: number
  readonly z: number
}

export interface MagicHit {
  readonly file: string
  readonly line: number
  readonly kind: keyof MagicCounts
  readonly text: string
  readonly value: string
}

export type MagicInventory = Record<
  keyof MagicCounts,
  Readonly<Record<string, number>>
>

const NONZERO = String.raw`(?:\d+\.?\d*|\.\d+)`
const PX = new RegExp(String.raw`(?<![\w.])([+-]?${NONZERO}px)\b`, "gi")
const DURATION = new RegExp(String.raw`(?<![\w.])([+-]?${NONZERO}m?s)\b`, "gi")
const Z_INDEX = /(?<![\w-])z-index\s*:\s*(-?\d+)\s*(?:;|$)/gi

const isNonZero = (token: string): boolean => /[1-9]/.test(token)

function maskIgnored(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/url\([^)]*\)/gi, (url) => " ".repeat(url.length))
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, (quoted) => " ".repeat(quoted.length))
    .replace(/--[\w-]+/g, (name) => " ".repeat(name.length))
}

interface ScanRange {
  readonly start: number
  readonly end: number
}

function scanRanges(src: string): ScanRange[] {
  const ranges: ScanRange[] = []
  const stack: number[] = []
  let segmentStart = 0

  for (let index = 0; index < src.length; index += 1) {
    const char = src[index]
    if (char === "{") {
      const segment = src.slice(segmentStart, index)
      if (stack.length > 0 || segment.trimStart().startsWith("@")) {
        ranges.push({ start: segmentStart, end: index })
      }
      stack.push(index)
      segmentStart = index + 1
    } else if (char === "}") {
      if (stack.length > 0) {
        ranges.push({ start: segmentStart, end: index })
        stack.pop()
      }
      segmentStart = index + 1
    }
  }

  return ranges
}

export function magicHits(file: string, src: string): MagicHit[] {
  const hits: MagicHit[] = []
  const stripped = maskIgnored(src)
  const lineAt = (offset: number): number =>
    stripped.slice(0, offset).split("\n").length

  for (const range of scanRanges(stripped)) {
    const text = stripped.slice(range.start, range.end)
    const scan = (pattern: RegExp, kind: keyof MagicCounts): void => {
      for (const found of text.matchAll(pattern)) {
        const value = found[1]?.toLowerCase() ?? found[0].toLowerCase()
        if (!isNonZero(value)) continue
        hits.push({
          file,
          line: lineAt(range.start + found.index),
          kind,
          text: found[0],
          value,
        })
      }
    }
    scan(PX, "px")
    scan(DURATION, "ms")
    scan(Z_INDEX, "z")
  }

  return hits.sort((a, b) => a.line - b.line)
}

export function countMagic(hits: readonly MagicHit[]): MagicCounts {
  const of = (kind: keyof MagicCounts): number =>
    hits.filter((hit) => hit.kind === kind).length
  return { px: of("px"), ms: of("ms"), z: of("z") }
}

export function inventoryMagic(hits: readonly MagicHit[]): MagicInventory {
  const inventory: Record<keyof MagicCounts, Record<string, number>> = {
    px: {},
    ms: {},
    z: {},
  }
  for (const hit of hits) {
    const values = inventory[hit.kind]
    values[hit.value] = (values[hit.value] ?? 0) + 1
  }
  return inventory
}

interface Violation {
  readonly file: string
  readonly line: number
  readonly what: string
}

export function violations(file: string, src: string): Violation[] {
  const out: Violation[] = []
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  )
  const lineAt = (offset: number): number =>
    stripped.slice(0, offset).split("\n").length
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let m = rule.exec(stripped); m !== null; m = rule.exec(stripped)) {
    const selector = (m[1] ?? "").trim()
    const body = m[2] ?? ""
    const bodyAt = m.index + (m[1] ?? "").length + 1
    const xs = body.indexOf("var(--text-xs)")
    if (xs !== -1 && !/\.kbd\b/.test(selector))
      out.push({
        file,
        line: lineAt(bodyAt + xs),
        what: `--text-xs in \`${selector}\``,
      })
    const raw = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/.exec(body)
    if (raw !== null && !selector.startsWith("@font-face"))
      out.push({
        file,
        line: lineAt(bodyAt + raw.index),
        what: `raw color ${raw[0]} in \`${selector}\``,
      })
  }
  return out
}

function read(file: string): string {
  return readFileSync(resolve(ROOT, file), "utf8")
}

if (import.meta.main && process.argv.includes("--count")) {
  const hits = cssFiles().flatMap((file) => magicHits(file, read(file)))
  if (process.argv.includes("--list")) {
    for (const hit of hits)
      console.error(`${hit.file}:${String(hit.line)}  ${hit.text}`)
  }
  const result = process.argv.includes("--inventory")
    ? inventoryMagic(hits)
    : countMagic(hits)
  console.log(JSON.stringify(result))
} else if (import.meta.main) {
  const files = cssFiles()
  const all = files.flatMap((file) => violations(file, read(file)))
  for (const violation of all)
    console.error(
      `${violation.file}:${String(violation.line)}  ${violation.what}`,
    )
  if (all.length > 0) process.exit(1)
  console.log(`design tokens: clean (${String(files.length)} files)`)
}
