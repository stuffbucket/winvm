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
  ".html",
  ".ps1",
  ".psm1",
  ".cs",
  ".xml",
  ".sh",
  ".nsh",
  ".cmd",
  ".swift",
])

const VENDORED = /(^|\/)novnc(\/|$)/

const CP1252_GLYPHS =
  "\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178"

const CONTINUATION = `[\\u0080-\\u00bf${CP1252_GLYPHS}]`

const SUSPECT = new RegExp(
  [
    `[\\u00f0-\\u00f4]${CONTINUATION}{3}`,
    `[\\u00e0-\\u00ef]${CONTINUATION}{2}`,
    `[\\u00c2-\\u00df]${CONTINUATION}`,
    "\\u00e2[\\u0080-\\u009f\\u20ac]",
    "[\\u0080-\\u009f]",
    "\\ufffd",
  ].join("|"),
  "gu",
)

const hex = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`

const isControl = (char: string): boolean => /[\u0080-\u009f]/u.test(char)

function reasonFor(match: string): string {
  if (match === "\ufffd") return `replacement character ${hex(match)}`
  if (match.length === 1 && isControl(match)) {
    return `C1 control character ${hex(match)}`
  }
  const shown = Array.from(match)
    .map((char) => (isControl(char) ? `<${hex(char)}>` : char))
    .join("")
  return `double-encoded UTF-8 (${shown})`
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

export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2))
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Uint8Array.from(bytes.subarray(2))
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const first = swapped[i] ?? 0
      swapped[i] = swapped[i + 1] ?? 0
      swapped[i + 1] = first
    }
    return new TextDecoder("utf-16le").decode(swapped)
  }
  return new TextDecoder("utf-8").decode(bytes)
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
    for (const problem of encodingProblems(decodeText(readFileSync(file)))) {
      total += 1
      console.log(`${file}:${String(problem.line)}: ${problem.reason}`)
    }
  }
  console.log(`check-text-encoding: ${String(total)} encoding problems`)
  process.exit(total > 0 ? 1 : 0)
}
