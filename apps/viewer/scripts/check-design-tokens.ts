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
}

const NONZERO = String.raw`(?:\d+\.?\d*|\.\d+)`
const PX = new RegExp(String.raw`(?<![\w.])${NONZERO}px\b`, "g")
const DURATION = new RegExp(String.raw`(?<![\w.])${NONZERO}m?s\b`, "g")
const Z_INDEX = /(?<![\w-])z-index\s*:\s*(-?\d+)\s*(?:;|$)/g

const isNonZero = (token: string): boolean => /[1-9]/.test(token)

export function magicHits(file: string, src: string): MagicHit[] {
  const hits: MagicHit[] = []
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  )
  const lineAt = (offset: number): number =>
    stripped.slice(0, offset).split("\n").length
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let m = rule.exec(stripped); m !== null; m = rule.exec(stripped)) {
    const bodyAt = m.index + (m[1] ?? "").length + 1
    const body = (m[2] ?? "")
      .replace(/url\([^)]*\)/g, (u) => " ".repeat(u.length))
      .replace(/(["'])(?:\\.|(?!\1).)*\1/g, (q) => " ".repeat(q.length))
      .replace(/--[\w-]+/g, (name) => " ".repeat(name.length))
    const scan = (pattern: RegExp, kind: keyof MagicCounts): void => {
      for (const found of body.matchAll(pattern)) {
        const text = found[1] ?? found[0]
        if (!isNonZero(text)) continue
        hits.push({
          file,
          line: lineAt(bodyAt + found.index),
          kind,
          text: found[0],
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
  const hits = cssFiles().flatMap((f) => magicHits(f, read(f)))
  if (process.argv.includes("--list")) {
    for (const h of hits)
      console.error(`${h.file}:${String(h.line)}  ${h.text}`)
  }
  console.log(JSON.stringify(countMagic(hits)))
} else if (import.meta.main) {
  const files = cssFiles()
  const all = files.flatMap((f) => violations(f, read(f)))
  for (const v of all) console.error(`${v.file}:${String(v.line)}  ${v.what}`)
  if (all.length > 0) process.exit(1)
  console.log(`design tokens: clean (${String(files.length)} files)`)
}
