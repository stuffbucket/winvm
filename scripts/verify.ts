import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

interface Command {
  argv: string[]
  cwd?: string
}

interface Step {
  name: string
  group: "fast" | "slow"
  lane?: "tests" | "rust"
  commands: Command[]
  findings: (output: string) => number
  prepare?: () => string | undefined
}

interface Result {
  name: string
  ok: boolean
  findings: number
  ms: number
  log: string
}

const ROOT = resolve(import.meta.dir, "..")
const VIEWER = join(ROOT, "apps", "viewer")
const TAURI = join(VIEWER, "src-tauri")
const SIDECAR = join(TAURI, "binaries", "winvm-aarch64-apple-darwin")
const DIST_INDEX = join(VIEWER, "dist", "index.html")

const ENV = {
  ...process.env,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  CARGO_TERM_COLOR: "never",
  TURBO_TELEMETRY_DISABLED: "1",
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

const npmScript = (script: string): Command => ({
  argv: ["pnpm", "run", "--silent", script],
})
const mise = (...argv: string[]): string[] => ["mise", "exec", "--", ...argv]
const cargo = (...argv: string[]): Command => ({
  argv: mise("cargo", ...argv),
  cwd: TAURI,
})

function capture(argv: string[], cwd = ROOT): string {
  const run = Bun.spawnSync(argv, { cwd, env: ENV })
  return `${run.stdout.toString()}${run.stderr.toString()}`
}

function shellFiles(): string[] {
  return capture(["git", "ls-files", "*.sh", ".githooks"])
    .split("\n")
    .filter((file) => file !== "" && existsSync(join(ROOT, file)))
}

function count(pattern: RegExp): (output: string) => number {
  return (output) => output.match(pattern)?.length ?? 0
}

function sumOf(pattern: RegExp): (output: string) => number {
  return (output) =>
    [...output.matchAll(pattern)].reduce(
      (total, match) => total + Number(match[1] ?? 0),
      0,
    )
}

function netWarnings(output: string): number {
  return [
    ...output.matchAll(/generated (\d+) warnings?(?: \((\d+) duplicates?\))?/g),
  ].reduce(
    (total, match) => total + Number(match[1] ?? 0) - Number(match[2] ?? 0),
    0,
  )
}

let rustInputsFailure: string | undefined | null = null

function ensureRustInputs(): string | undefined {
  if (rustInputsFailure !== null) return rustInputsFailure
  rustInputsFailure = undefined
  const builds: [string, string, string][] = [
    [SIDECAR, join(VIEWER, "scripts", "build-sidecar.ts"), ROOT],
    [DIST_INDEX, join(VIEWER, "scripts", "build-ui.ts"), VIEWER],
  ]
  for (const [output, script, cwd] of builds) {
    if (existsSync(output)) continue
    const built = Bun.spawnSync(["bun", script], { cwd, env: ENV })
    if (built.exitCode !== 0 || !existsSync(output)) {
      rustInputsFailure = `setup failed: bun ${script} did not produce ${output}\n${built.stderr.toString()}${built.stdout.toString()}`
      return rustInputsFailure
    }
  }
  return rustInputsFailure
}

const STEPS: Step[] = [
  {
    name: "biome",
    group: "fast",
    commands: [npmScript("lint")],
    findings: sumOf(/^Found (\d+) (?:errors?|warnings?|infos?)\./gm),
  },
  {
    name: "comments",
    group: "fast",
    commands: [npmScript("comments")],
    findings: sumOf(/^check-comments: (\d+) disallowed/gm),
  },
  {
    name: "encoding",
    group: "fast",
    commands: [npmScript("encoding")],
    findings: sumOf(/^check-text-encoding: (\d+) encoding/gm),
  },
  {
    name: "shellcheck",
    group: "fast",
    commands: [{ argv: mise("shellcheck", "--format=gcc", ...shellFiles()) }],
    findings: count(/^\S+:\d+:\d+: (?:error|warning|note)/gm),
  },
  {
    name: "shfmt",
    group: "fast",
    commands: [{ argv: mise("shfmt", "-d", "-i", "2", ...shellFiles()) }],
    findings: count(/^@@ /gm),
  },
  {
    name: "actionlint",
    group: "fast",
    commands: [{ argv: mise("actionlint") }],
    findings: count(/^\S+:\d+:\d+: /gm),
  },
  {
    name: "typecheck",
    group: "fast",
    commands: [{ argv: ["pnpm", "exec", "turbo", "run", "typecheck"] }],
    findings: count(/error TS\d+/g),
  },
  {
    name: "types",
    group: "fast",
    commands: [npmScript("lint:types")],
    findings: (output) =>
      [
        ...output.matchAll(/^Found (\d+) warnings? and (\d+) errors?\./gm),
      ].reduce(
        (total, match) => total + Number(match[1] ?? 0) + Number(match[2] ?? 0),
        0,
      ),
  },
  {
    name: "typecheck-scripts",
    group: "fast",
    commands: [
      {
        argv: [
          "pnpm",
          "exec",
          "tsc",
          "--noEmit",
          "-p",
          "scripts/tsconfig.json",
        ],
      },
    ],
    findings: count(/error TS\d+/g),
  },
  {
    name: "boundaries",
    group: "fast",
    commands: [npmScript("boundaries")],
    findings: sumOf(/Checked \d+ files in \d+ packages, (\d+) issues? found/g),
  },
  {
    name: "knip",
    group: "fast",
    commands: [npmScript("knip")],
    findings: sumOf(/^[A-Z][A-Za-z ]+ \((\d+)\)$/gm),
  },
  {
    name: "deps",
    group: "fast",
    commands: [npmScript("deps")],
    findings: sumOf(/(\d+) dependency violations/g),
  },
  {
    name: "cargo-fmt",
    group: "fast",
    commands: [cargo("fmt", "--check")],
    findings: count(/^Diff in /gm),
  },
  {
    name: "cargo-deny",
    group: "fast",
    commands: [cargo("deny", "check")],
    findings: count(/^error\[/gm),
  },
  {
    name: "cargo-machete",
    group: "fast",
    commands: [cargo("machete")],
    findings: count(/^\t\S+/gm),
  },
  {
    name: "test",
    group: "slow",
    lane: "tests",
    commands: [
      { argv: ["pnpm", "exec", "turbo", "run", "test"] },
      { argv: ["bun", "test", "scripts"] },
    ],
    findings: sumOf(/^\s*(\d+) fail/gm),
  },
  {
    name: "clippy",
    group: "slow",
    lane: "rust",
    prepare: ensureRustInputs,
    commands: [cargo("clippy", "--all-targets")],
    findings: netWarnings,
  },
  {
    name: "clippy-unwrap",
    group: "slow",
    lane: "rust",
    prepare: ensureRustInputs,
    commands: [
      cargo("clippy", "--lib", "--bins", "--", "-D", "clippy::unwrap_used"),
    ],
    findings: sumOf(/due to (\d+) previous errors?/g),
  },
  {
    name: "cargo-test",
    group: "slow",
    lane: "rust",
    prepare: ensureRustInputs,
    commands: [cargo("test")],
    findings: sumOf(/test result: .*?(\d+) failed/g),
  },
]

function usage(): never {
  console.error(
    "usage: verify.ts [--fast] [--only a,b] [--list] [--runner name]",
  )
  process.exit(2)
}

function parseArgs(argv: string[]): {
  fast: boolean
  only: string[] | undefined
  list: boolean
  runner: string
} {
  const queue = [...argv]
  let fast = false
  let list = false
  let only: string[] | undefined
  let runner = "local"
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (arg === "--fast") fast = true
    else if (arg === "--list") list = true
    else if (arg === "--only") only = (queue.shift() ?? "").split(",")
    else if (arg === "--runner") runner = queue.shift() ?? usage()
    else usage()
  }
  return { fast, only, list, runner }
}

async function runStep(step: Step, logs: string): Promise<Result> {
  const started = performance.now()
  const setupFailure = step.prepare?.()
  let output = setupFailure ?? ""
  let ok = setupFailure === undefined
  for (const command of setupFailure === undefined ? step.commands : []) {
    const proc = Bun.spawn(command.argv, {
      cwd: command.cwd ?? ROOT,
      env: ENV,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    output += `$ ${command.argv.join(" ")}\n${out.replace(ANSI, "")}${err.replace(ANSI, "")}\n`
    if (code !== 0) ok = false
  }
  const findings = setupFailure === undefined ? step.findings(output) : 1
  const log = join(logs, `${step.name}.log`)
  writeFileSync(log, output)
  const ms = Math.round(performance.now() - started)
  const result = {
    name: step.name,
    ok: ok && findings === 0,
    findings,
    ms,
    log,
  }
  console.error(
    `${result.ok ? "ok  " : "FAIL"} ${step.name} (${(ms / 1000).toFixed(1)}s)`,
  )
  return result
}

async function runLane(steps: Step[], logs: string): Promise<Result[]> {
  const results: Result[] = []
  for (const step of steps) results.push(await runStep(step, logs))
  return results
}

function stampDirectory(): string {
  const common = capture(["git", "rev-parse", "--git-common-dir"]).trim()
  return join(resolve(ROOT, common), "winvm-verify")
}

function toolVersions(): Record<string, string> {
  const first = (text: string): string => text.trim().split("\n")[0] ?? ""
  return {
    bun: first(capture(["bun", "--version"])),
    biome: first(capture(["pnpm", "exec", "biome", "--version"])),
    turbo: first(capture(["pnpm", "exec", "turbo", "--version"])),
    knip: first(capture(["pnpm", "exec", "knip", "--version"])),
    depcruise: first(capture(["pnpm", "exec", "depcruise", "--version"])),
    typescript: first(capture(["pnpm", "exec", "tsc", "--version"])),
    shellcheck:
      capture(mise("shellcheck", "--version"))
        .split("\n")
        .find((line) => line.startsWith("version:"))
        ?.trim() ?? "",
    shfmt: first(capture(mise("shfmt", "--version"))),
    actionlint: first(capture(mise("actionlint", "--version"))),
    cargo: first(capture(mise("cargo", "--version"), TAURI)),
    cargoDeny: first(capture(mise("cargo", "deny", "--version"), TAURI)),
    cargoMachete: first(capture(mise("cargo", "machete", "--version"), TAURI)),
  }
}

function writeStamp(results: Result[], runner: string): string | undefined {
  if (capture(["git", "status", "--porcelain"]).trim() !== "") {
    return "working tree is not clean, no stamp written"
  }
  const tree = capture(["git", "rev-parse", "HEAD^{tree}"]).trim()
  const commit = capture(["git", "rev-parse", "HEAD"]).trim()
  const directory = stampDirectory()
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${tree}.json`)
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        tree,
        commit,
        runner,
        at: new Date().toISOString(),
        tools: toolVersions(),
        steps: results.map(({ name, ms, findings }) => ({
          name,
          ms,
          findings,
        })),
      },
      null,
      2,
    )}\n`,
  )
  return `stamp ${file}`
}

function table(results: Result[]): void {
  const width = Math.max(...results.map((r) => r.name.length))
  console.log(`${"step".padEnd(width)}  status  findings  seconds`)
  for (const r of results) {
    console.log(
      `${r.name.padEnd(width)}  ${(r.ok ? "ok" : "FAIL").padEnd(6)}  ${String(r.findings).padStart(8)}  ${(r.ms / 1000).toFixed(1).padStart(7)}`,
    )
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.list) {
  for (const step of STEPS) console.log(`${step.name}\t${step.group}`)
  process.exit(0)
}
for (const name of args.only ?? []) {
  if (!STEPS.some((step) => step.name === name)) {
    console.error(`unknown step: ${name}`)
    usage()
  }
}
const selected = STEPS.filter(
  (step) =>
    (args.only === undefined || args.only.includes(step.name)) &&
    (!args.fast || step.group === "fast"),
)
const partial = args.fast || args.only !== undefined
const logs = join(
  resolve(ROOT, capture(["git", "rev-parse", "--git-dir"]).trim()),
  "winvm-verify-logs",
)
mkdirSync(logs, { recursive: true })

const fast = selected.filter((step) => step.group === "fast")
const slow = selected.filter((step) => step.group === "slow")
const results: Result[] = (
  await Promise.all(fast.map((step) => runStep(step, logs)))
).concat(
  (
    await Promise.all([
      runLane(
        slow.filter((step) => step.lane === "tests"),
        logs,
      ),
      runLane(
        slow.filter((step) => step.lane === "rust"),
        logs,
      ),
    ])
  ).flat(),
)

console.log("")
table(results)
const failed = results.filter((r) => !r.ok)
for (const r of failed) {
  console.log(`log: ${r.log}`)
  if (process.env.CI !== undefined) console.log(readFileSync(r.log, "utf8"))
}
if (failed.length > 0) {
  console.log(
    `\nverify: ${String(failed.length)} of ${String(results.length)} steps failed`,
  )
  process.exit(1)
}
const note = partial
  ? "partial run, no stamp written"
  : writeStamp(results, args.runner)
console.log(
  `\nverify: all ${String(results.length)} steps passed${note ? `; ${note}` : ""}`,
)
