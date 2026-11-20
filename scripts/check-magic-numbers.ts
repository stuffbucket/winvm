import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export interface CssInventory {
  readonly px: Readonly<Record<string, number>>
  readonly ms: Readonly<Record<string, number>>
  readonly z: Readonly<Record<string, number>>
}

export interface Measurements {
  readonly ts: number
  readonly css: CssInventory
}

export interface Comparison {
  readonly increased: string[]
  readonly decreased: string[]
}

const ROOT = resolve(import.meta.dir, "..")
const BASELINE = join(import.meta.dir, "magic-numbers-baseline.json")
const OXLINT_CONFIG = ".oxlintrc.magic.json"
const TS_ROOTS = ["apps/viewer/ui/src", "packages/canvas/src"]
const CSS_KINDS = ["px", "ms", "z"] as const
const CSS_SCRIPT = join(
  ROOT,
  "apps",
  "viewer",
  "scripts",
  "check-design-tokens.ts",
)

function flatten(measurements: Measurements): Record<string, number> {
  const flat: Record<string, number> = { ts: measurements.ts }
  for (const kind of CSS_KINDS) {
    for (const [value, count] of Object.entries(measurements.css[kind])) {
      flat[`css.${kind}.${value}`] = count
    }
  }
  return flat
}

export function compare(
  current: Measurements,
  baseline: Measurements,
): Comparison {
  const now = flatten(current)
  const before = flatten(baseline)
  const result: Comparison = { increased: [], decreased: [] }
  const names = [
    "ts",
    ...new Set(
      [...Object.keys(now), ...Object.keys(before)]
        .filter((name) => name !== "ts")
        .sort(),
    ),
  ]
  for (const name of names) {
    const value = now[name] ?? 0
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

function objectEntries(value: unknown, name: string): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not an object`)
  }
  return Object.entries(value)
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} holds a non-integer count`)
  }
  return value
}

function parseValues(value: unknown, name: string): Record<string, number> {
  const values: Record<string, number> = {}
  for (const [token, count] of objectEntries(value, name)) {
    values[token] = nonnegativeInteger(count, `${name}.${token}`)
  }
  return values
}

function parseMeasurements(value: unknown): Measurements {
  const root = Object.fromEntries(objectEntries(value, "measurements"))
  const css = Object.fromEntries(objectEntries(root.css, "css"))
  return {
    ts: nonnegativeInteger(root.ts, "ts"),
    css: {
      px: parseValues(css.px, "css.px"),
      ms: parseValues(css.ms, "css.ms"),
      z: parseValues(css.z, "css.z"),
    },
  }
}

export function parseCssInventory(output: string): CssInventory {
  const line = output.trim().split("\n").at(-1) ?? ""
  const parsed: unknown = JSON.parse(line)
  return parseMeasurements({ ts: 0, css: parsed }).css
}

export function parseBaseline(text: string): Measurements {
  return parseMeasurements(JSON.parse(text))
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

function measure(): Measurements {
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
  const css = parseCssInventory(
    run(["bun", CSS_SCRIPT, "--count", "--inventory"]),
  )
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
