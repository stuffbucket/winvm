import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const FILES = [
  "ui/src/styles/styles.css",
  "ui/src/styles/terminal.css",
  "ui/src/styles/files.css",
  "ui/src/styles/checkpoints.css",
  "ui/src/styles/about.css",
  "../../packages/canvas/src/canvas.css",
]
const ROOT = resolve(import.meta.dir, "..")

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

if (import.meta.main) {
  const all = FILES.flatMap((f) =>
    violations(f, readFileSync(resolve(ROOT, f), "utf8")),
  )
  for (const v of all) console.error(`${v.file}:${String(v.line)}  ${v.what}`)
  if (all.length > 0) process.exit(1)
  console.log(`design tokens: clean (${String(FILES.length)} files)`)
}
