import { existsSync, readFileSync } from "node:fs"
import { extname } from "node:path"
import ts from "typescript"

type Language = "ts" | "rust" | "css"

interface Found {
  start: number
  end: number
  block: boolean
}

interface Violation {
  file: string
  line: number
  excerpt: string
  reason: string
}

const LANGUAGES: Record<string, Language> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".rs": "rust",
  ".css": "css",
}

const VENDORED = /(^|\/)novnc(\/|$)/
const URL_PATTERN = /https?:\/\/\S+/
const BIOME_IGNORE = /^biome-ignore(?:-all|-start)?\s+\S+:\s*\S/
const BIOME_IGNORE_END = /^biome-ignore-end\s+\S+/
const BIOME_IGNORE_ANY = /^biome-ignore/
const TS_EXPECT_ERROR = /^@ts-expect-error\s+\S/
const TS_EXPECT_ERROR_NO_REASON = /^@ts-expect-error\s*$/
const TS_DIRECTIVE = /^@ts-check$/
const PURE_ANNOTATION = /^[@#]__(?:PURE|NO_SIDE_EFFECTS)__$/
const REFERENCE_DIRECTIVE = /^\/\/\/\s*<reference\s/
const SAFETY = /^SAFETY:\s*\S/

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

function languageOf(file: string): Language | undefined {
  return LANGUAGES[extname(file)]
}

function tsComments(file: string, text: string): Found[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : undefined,
  )
  const found = new Map<number, Found>()
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(source)
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.JsxText) return
      const fullStart = node.getFullStart()
      const ranges = [
        ...(ts.getLeadingCommentRanges(text, fullStart) ?? []),
        ...(ts.getTrailingCommentRanges(text, fullStart) ?? []),
      ]
      for (const range of ranges) {
        found.set(range.pos, {
          start: range.pos,
          end: range.end,
          block: range.kind === ts.SyntaxKind.MultiLineCommentTrivia,
        })
      }
      return
    }
    for (const child of children) visit(child)
  }
  visit(source)
  return [...found.values()].sort((a, b) => a.start - b.start)
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

function skipQuoted(text: string, from: number, quote: string): number {
  let i = from + 1
  while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1
  return i + 1
}

function rawStringEnd(text: string, from: number): number | undefined {
  let i = from + 1
  let hashes = 0
  while (text[i] === "#") {
    hashes += 1
    i += 1
  }
  if (text[i] !== '"') return undefined
  const closing = `"${"#".repeat(hashes)}`
  const end = text.indexOf(closing, i + 1)
  return end === -1 ? text.length : end + closing.length
}

function charLiteralEnd(text: string, from: number): number | undefined {
  if (text[from + 1] === "\\") {
    let i = from + 3
    while (i < text.length && text[i] !== "'") i += 1
    return i + 1
  }
  const width = (text.codePointAt(from + 1) ?? 0) > 0xffff ? 2 : 1
  return text[from + 1 + width] === "'" ? from + 2 + width : undefined
}

function rustComments(text: string): Found[] {
  const found: Found[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]
    if (char === "/" && next === "/") {
      const newline = text.indexOf("\n", i)
      const end = newline === -1 ? text.length : newline
      found.push({ start: i, end, block: false })
      i = end
    } else if (char === "/" && next === "*") {
      let depth = 1
      let j = i + 2
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth += 1
          j += 2
        } else if (text[j] === "*" && text[j + 1] === "/") {
          depth -= 1
          j += 2
        } else {
          j += 1
        }
      }
      found.push({ start: i, end: j, block: true })
      i = j
    } else if (char === '"') {
      i = skipQuoted(text, i, '"')
    } else if (
      char === "r" &&
      (!isIdentifierChar(text[i - 1]) ||
        (text[i - 1] === "b" && !isIdentifierChar(text[i - 2])) ||
        (text[i - 1] === "c" && !isIdentifierChar(text[i - 2])))
    ) {
      i = rawStringEnd(text, i) ?? i + 1
    } else if (char === "'") {
      i = charLiteralEnd(text, i) ?? i + 1
    } else {
      i += 1
    }
  }
  return found
}

function cssComments(text: string): Found[] {
  const found: Found[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2)
      const end = close === -1 ? text.length : close + 2
      found.push({ start: i, end, block: true })
      i = end
    } else if (char === '"' || char === "'") {
      i = skipQuoted(text, i, char)
    } else {
      i += 1
    }
  }
  return found
}

function body(raw: string, block: boolean): string {
  if (block) return raw.slice(2, raw.endsWith("*/") ? -2 : undefined).trim()
  return raw.replace(/^\/\/[/!]?/, "").trim()
}

function problem(
  language: Language,
  raw: string,
  block: boolean,
): string | undefined {
  const content = body(raw, block)
  if (URL_PATTERN.test(content)) return undefined
  if (language === "rust") {
    return !block && /^\/\/(?![/!])/.test(raw) && SAFETY.test(content)
      ? undefined
      : "prose comment (only `// SAFETY:` and URLs are allowed in Rust)"
  }
  if (BIOME_IGNORE.test(content) || BIOME_IGNORE_END.test(content)) {
    return undefined
  }
  if (BIOME_IGNORE_ANY.test(content)) return "biome-ignore without a reason"
  if (TS_EXPECT_ERROR_NO_REASON.test(content)) {
    return "@ts-expect-error without a reason"
  }
  if (TS_EXPECT_ERROR.test(content)) return undefined
  if (language === "ts") {
    if (TS_DIRECTIVE.test(content)) return undefined
    if (block && PURE_ANNOTATION.test(content)) return undefined
    if (!block && REFERENCE_DIRECTIVE.test(raw)) return undefined
  }
  return "prose comment"
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length
}

function check(file: string): Violation[] {
  const language = languageOf(file)
  if (language === undefined || VENDORED.test(file) || !existsSync(file)) {
    return []
  }
  const text = readFileSync(file, "utf8")
  const comments =
    language === "ts"
      ? tsComments(file, text)
      : language === "rust"
        ? rustComments(text)
        : cssComments(text)
  const violations: Violation[] = []
  for (const comment of comments) {
    const raw = text.slice(comment.start, comment.end)
    const reason = problem(language, raw, comment.block)
    if (reason === undefined) continue
    violations.push({
      file,
      line: lineOf(text, comment.start),
      excerpt: raw.split("\n")[0]?.slice(0, 72) ?? "",
      reason,
    })
  }
  return violations
}

const requested = process.argv.slice(2)
const files = requested.length > 0 ? requested : trackedFiles()
const violations = files.flatMap(check)
for (const v of violations) {
  console.log(`${v.file}:${String(v.line)}: ${v.reason}: ${v.excerpt}`)
}
const filesWithViolations = new Set(violations.map((v) => v.file)).size
console.log(
  `check-comments: ${String(violations.length)} disallowed comments in ${String(filesWithViolations)} files`,
)
process.exit(violations.length > 0 ? 1 : 0)
