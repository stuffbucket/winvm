import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { extname } from "node:path"
import ts from "typescript"

type Language = "ts" | "rust" | "css"

interface Found {
  start: number
  end: number
  block: boolean
}

interface Rejected extends Found {
  reason: string
}

interface Removal {
  start: number
  end: number
  container: boolean
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
const OXLINT_DISABLE =
  /^oxlint-disable-next-line\s+typescript\/[a-z-]+\s+--\s+\S/
const OXLINT_ANY = /^oxlint-/
const ESLINT_DIRECTIVE = /\beslint-(?:disable|enable)/
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

function tsComments(
  file: string,
  text: string,
): { comments: Found[]; containers: Found[] } {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : undefined,
  )
  const found = new Map<number, Found>()
  const containers: Found[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxExpression(node) &&
      node.expression === undefined &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      containers.push({
        start: node.getStart(source),
        end: node.end,
        block: true,
      })
    }
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
  return {
    comments: [...found.values()].sort((a, b) => a.start - b.start),
    containers,
  }
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

export function problem(
  language: Language,
  raw: string,
  block: boolean,
): string | undefined {
  const content = body(raw, block)
  if (ESLINT_DIRECTIVE.test(content)) {
    return "eslint directive (there is no ESLint here; oxlint would still honor it)"
  }
  if (language === "ts" && OXLINT_ANY.test(content)) {
    return !block && OXLINT_DISABLE.test(content)
      ? undefined
      : "oxlint directive other than `oxlint-disable-next-line typescript/<rule> -- <reason>`"
  }
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

function coveredFile(file: string): Language | undefined {
  const language = languageOf(file)
  if (language === undefined || VENDORED.test(file)) return undefined
  return language
}

function scan(
  file: string,
  text: string,
  language: Language,
): { rejected: Rejected[]; containers: Found[] } {
  let containers: Found[] = []
  let comments: Found[]
  if (language === "ts") {
    const scanned = tsComments(file, text)
    comments = scanned.comments
    containers = scanned.containers
  } else {
    comments = language === "rust" ? rustComments(text) : cssComments(text)
  }
  const rejected: Rejected[] = []
  for (const comment of comments) {
    const reason = problem(
      language,
      text.slice(comment.start, comment.end),
      comment.block,
    )
    if (reason !== undefined) rejected.push({ ...comment, reason })
  }
  return { rejected, containers }
}

export function violationsIn(file: string, text: string): Violation[] {
  const language = coveredFile(file)
  if (language === undefined) return []
  return scan(file, text, language).rejected.map((comment) => ({
    file,
    line: lineOf(text, comment.start),
    excerpt:
      text.slice(comment.start, comment.end).split("\n")[0]?.slice(0, 72) ?? "",
    reason: comment.reason,
  }))
}

function check(file: string): Violation[] {
  if (coveredFile(file) === undefined || !existsSync(file)) return []
  return violationsIn(file, readFileSync(file, "utf8"))
}

const COMMENT_MARK = "\u0001"
const CONTAINER_MARK = "\u0002"
const GAP = Symbol("gap")

function containerRemovals(
  text: string,
  rejected: Rejected[],
  containers: Found[],
): { removals: Removal[]; covered: Set<Rejected> } {
  const removals: Removal[] = []
  const covered = new Set<Rejected>()
  for (const container of containers) {
    const inside = rejected.filter(
      (comment) =>
        comment.start >= container.start && comment.end <= container.end,
    )
    if (inside.length === 0) continue
    if (commentsWithin(text, container) !== inside.length) continue
    for (const comment of inside) covered.add(comment)
    removals.push({
      start: container.start,
      end: container.end,
      container: true,
    })
  }
  return { removals, covered }
}

function commentsWithin(text: string, container: Found): number {
  const inner = text.slice(container.start + 1, container.end - 1)
  const ranges = ts.getLeadingCommentRanges(inner, 0) ?? []
  const last = ranges[ranges.length - 1]
  const trailing = last === undefined ? inner : inner.slice(last.end)
  return trailing.trim() === "" ? ranges.length : -1
}

function removals(
  text: string,
  rejected: Rejected[],
  containers: Found[],
): Removal[] {
  const found = containerRemovals(text, rejected, containers)
  for (const comment of rejected) {
    if (found.covered.has(comment)) continue
    found.removals.push({
      start: comment.start,
      end: comment.end,
      container: false,
    })
  }
  return found.removals.sort((a, b) => a.start - b.start)
}

function lineBounds(text: string, from: number, to: number) {
  const lineStart = text.lastIndexOf("\n", from - 1) + 1
  const newline = text.indexOf("\n", to)
  const lineEnd = newline === -1 ? text.length : newline
  return { lineStart, lineEnd }
}

function mark(
  text: string,
  removal: Removal,
): { replacement: string; splits: boolean } {
  if (removal.container) return { replacement: CONTAINER_MARK, splits: false }
  const raw = text.slice(removal.start, removal.end)
  if (!raw.includes("\n")) return { replacement: COMMENT_MARK, splits: false }
  const { lineStart, lineEnd } = lineBounds(text, removal.start, removal.end)
  const before = text.slice(lineStart, removal.start)
  const after = text.slice(removal.end, lineEnd)
  if (before.trim() === "" || after.trim() === "") {
    return { replacement: COMMENT_MARK, splits: false }
  }
  const indent = /^\s*/.exec(before)?.[0] ?? ""
  return { replacement: `${COMMENT_MARK}\n${indent}`, splits: true }
}

function stripMarks(line: string): string {
  let result = ""
  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i)
    if (char !== COMMENT_MARK && char !== CONTAINER_MARK) {
      result += char
      continue
    }
    if (char === CONTAINER_MARK) continue
    const before = result[result.length - 1]
    const after = line[i + 1]
    if (before === undefined || /\s/.test(before)) {
      while (line[i + 1] !== undefined && /[ \t]/.test(line[i + 1] ?? ""))
        i += 1
    } else if (after !== undefined && /\w/.test(before) && /\w/.test(after)) {
      result += " "
    }
  }
  return result.trimEnd()
}

function opens(line: string): boolean {
  return /[{([]$/.test(line.trimEnd())
}

function closes(line: string): boolean {
  return /^[})\]]/.test(line.trimStart())
}

function settle(items: (string | typeof GAP)[]): string[] {
  const result: string[] = []
  let i = 0
  while (i < items.length) {
    const item = items[i]
    if (typeof item === "string" && item.trim() !== "") {
      result.push(item)
      i += 1
      continue
    }
    let j = i
    let blanks = 0
    let touched = false
    while (j < items.length) {
      const run = items[j]
      if (run === GAP) touched = true
      else if (run?.trim() === "") blanks += 1
      else break
      j += 1
    }
    const next = items[j]
    const prev = result[result.length - 1]
    if (!touched) {
      for (let k = 0; k < blanks; k += 1) result.push("")
    } else if (
      blanks > 0 &&
      prev !== undefined &&
      typeof next === "string" &&
      !opens(prev) &&
      !closes(next)
    ) {
      result.push("")
    }
    i = j
  }
  return result
}

export function fixText(
  file: string,
  text: string,
): { text: string; removed: number } {
  const language = coveredFile(file)
  if (language === undefined) return { text, removed: 0 }
  const { rejected, containers } = scan(file, text, language)
  if (rejected.length === 0) return { text, removed: 0 }
  if (text.includes(COMMENT_MARK) || text.includes(CONTAINER_MARK)) {
    throw new Error(`${file}: contains control characters used by --fix`)
  }
  let marked = ""
  let cursor = 0
  for (const removal of removals(text, rejected, containers)) {
    const { replacement, splits } = mark(text, removal)
    marked += text.slice(cursor, removal.start) + replacement
    cursor = removal.end
    if (splits) cursor += /^[ \t]*/.exec(text.slice(cursor))?.[0].length ?? 0
  }
  marked += text.slice(cursor)
  const endsWithNewline = marked.endsWith("\n")
  const lines = (endsWithNewline ? marked.slice(0, -1) : marked).split("\n")
  const items: (string | typeof GAP)[] = lines.map((line) => {
    if (!line.includes(COMMENT_MARK) && !line.includes(CONTAINER_MARK)) {
      return line
    }
    const stripped = stripMarks(line)
    return stripped.trim() === "" ? GAP : stripped
  })
  const settled = settle(items)
  const out = settled.join("\n")
  return {
    text: out === "" ? "" : endsWithNewline ? `${out}\n` : out,
    removed: rejected.length,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const fix = args.includes("--fix")
  const requested = args.filter((arg) => arg !== "--fix")
  const files = requested.length > 0 ? requested : trackedFiles()
  if (fix) {
    let removed = 0
    let changed = 0
    for (const file of files) {
      if (coveredFile(file) === undefined || !existsSync(file)) continue
      const before = readFileSync(file, "utf8")
      const result = fixText(file, before)
      if (result.text === before) continue
      writeFileSync(file, result.text)
      removed += result.removed
      changed += 1
    }
    console.log(
      `check-comments --fix: removed ${String(removed)} comments in ${String(changed)} files`,
    )
  }
  const violations = files.flatMap(check)
  for (const v of violations) {
    console.log(`${v.file}:${String(v.line)}: ${v.reason}: ${v.excerpt}`)
  }
  const filesWithViolations = new Set(violations.map((v) => v.file)).size
  console.log(
    `check-comments: ${String(violations.length)} disallowed comments in ${String(filesWithViolations)} files`,
  )
  process.exit(violations.length > 0 ? 1 : 0)
}
