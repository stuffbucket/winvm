import { existsSync, readFileSync } from "node:fs"
import { extname } from "node:path"

interface Problem {
  line: number
  reason: string
}

const EXTENSIONS = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".md",
  ".toml",
  ".yaml",
  ".yml",
])

const VENDORED = /(^|\/)novnc(\/|$)/

const SUSPECT = /â[\u0080-\u009f€]|Ã[\u0080-¿]|[\u0080-\u009f]/gu

const hex = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`

function reasonFor(match: string): string {
  if (match.length === 1) return `C1 control character ${hex(match)}`
  const lead = match.charAt(0)
  const next = match.charAt(1)
  if (next === "€") return `double-encoded UTF-8 (${lead}${next})`
  return `double-encoded UTF-8 (${lead} followed by ${hex(next)})`
}

export function encodingProblems(text: string): Problem[] {
  const problems: Problem[] = []
  text.split("\n").forEach((content, index) => {
    for (const match of content.matchAll(SUSPECT)) {
      problems.push({ line: index + 1, reason: reasonFor(match[0]) })
    }
  })
  return problems
}

function trackedFiles(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { stdout: "pipe", stderr: "inherit" },
  )
  if (listed.exitCode !== 0) process.exit(2)
  return listed.stdout
    .toString()
    .split("\n")
    .filter((file) => file !== "")
}

if (import.meta.main) {
  const requested = process.argv.slice(2)
  const files = (requested.length > 0 ? requested : trackedFiles()).filter(
    (file) =>
      EXTENSIONS.has(extname(file)) && !VENDORED.test(file) && existsSync(file),
  )
  let total = 0
  for (const file of files) {
    for (const problem of encodingProblems(readFileSync(file, "utf8"))) {
      total += 1
      console.log(`${file}:${String(problem.line)}: ${problem.reason}`)
    }
  }
  console.log(`check-text-encoding: ${String(total)} encoding problems`)
  process.exit(total > 0 ? 1 : 0)
}
