import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export interface Counts {
  ts: number
  css: { px: number; ms: number; z: number }
}

export interface Comparison {
  increased: string[]
  decreased: string[]
}

const ROOT = resolve(import.meta.dir, "..")
const BASELINE = join(import.meta.dir, "magic-numbers-baseline.json")
const OXLINT_CONFIG = ".oxlintrc.magic.json"
const TS_ROOTS = ["apps/viewer/ui/src", "packages/canvas/src"]
const CSS_SCRIPT = join(
  ROOT,
  "apps",
  "viewer",
  "scripts",
  "check-design-tokens.ts",
)

function flatten(counts: Counts): Record<string, number> {
  return {
    ts: counts.ts,
    "css.px": counts.css.px,
    "css.ms": counts.css.ms,
    "css.z": counts.css.z,
  }
}

export function compare(current: Counts, baseline: Counts): Comparison {
  const now = flatten(current)
  const before = flatten(baseline)
  const result: Comparison = { increased: [], decreased: [] }
  for (const [name, value] of Object.entries(now)) {
    const limit = before[name] ?? 0
    const line = `${name} ${String(value)} (baseline ${String(limit)})`
    if (value > limit) result.increased.push(line)
    else if (value < limit) result.decreased.push(line)
  }
  return result
}

export function oxlintCount(json: string): number {
  const parsed: unknown = JSON.parse(json)
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("diagnostics" in parsed) ||
    !Array.isArray(parsed.diagnostics)
  ) {
    throw new Error("oxlint output has no diagnostics array")
  }
  return parsed.diagnostics.length
}

export function parseCssCounts(output: string): Counts["css"] {
  const parsed: unknown = JSON.parse(output.trim().split("\n").at(-1) ?? "")
  const field = (name: string): number => {
    const value = (parsed as Record<string, unknown> | null)?.[name]
    if (typeof value !== "number") throw new Error(`css count ${name} missing`)
    return value
  }
  return { px: field("px"), ms: field("ms"), z: field("z") }
}

export function parseBaseline(text: string): Counts {
  const parsed = JSON.parse(text) as Counts
  const numbers = [parsed.ts, parsed.css.px, parsed.css.ms, parsed.css.z]
  if (!numbers.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error("baseline holds a non-integer count")
  }
  return parsed
}

function run(argv: string[]): string {
  const proc = Bun.spawnSync(argv, { cwd: ROOT, env: process.env })
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(
      `${argv.join(" ")} exited ${String(proc.exitCode)}\n${proc.stderr.toString()}`,
    )
  }
  return proc.stdout.toString()
}

function measure(): Counts {
  const ts = oxlintCount(
    run([
      "pnpm",
      "exec",
      "oxlint",
      "-c",
      OXLINT_CONFIG,
      "-f",
      "json",
      ...TS_ROOTS,
    ]),
  )
  const css = parseCssCounts(run(["bun", CSS_SCRIPT, "--count"]))
  return { ts, css }
}

function main(): number {
  const current = measure()
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`magic-numbers: baseline written ${JSON.stringify(current)}`)
    return 0
  }
  const { increased, decreased } = compare(
    current,
    parseBaseline(readFileSync(BASELINE, "utf8")),
  )
  for (const line of increased) console.log(`  up   ${line}`)
  for (const line of decreased) console.log(`  down ${line}`)
  if (increased.length > 0) {
    console.log(`magic-numbers: ${String(increased.length)} increased`)
    return 1
  }
  if (decreased.length > 0) {
    console.log(
      "magic-numbers: counts fell, lower the baseline with: bun scripts/check-magic-numbers.ts --update",
    )
  }
  console.log(`magic-numbers: ok ${JSON.stringify(current)}`)
  return 0
}

if (import.meta.main) process.exit(main())
