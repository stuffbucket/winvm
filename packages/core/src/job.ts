/**
 * Job files for `winvm run` / `winvm test`: parsing and validation. Pure — no
 * VM, no I/O beyond reading the file — so it is tested on its own.
 *
 * A job is GitHub-Actions-shaped, because that is the shape everyone already
 * reads fluently:
 *
 *   name: MSI install and uninstall
 *   golden: ci-golden            # the save every job starts from (optional)
 *   timeout: 600                 # whole job, seconds
 *   env: { VERSION: v1.2.3 }     # every step sees these
 *   files:                       # staged before the first step
 *     - src: ./fixtures/app.msi            # host path, relative to this file
 *       dest: C:\work\app.msi
 *     - url: https://example.com/x.zip     # fetched on the host, then staged
 *       dest: C:\work\
 *     - release: owner/repo                # `gh release download` into a cache
 *       tag: latest
 *       pattern: "*windows-x64.msi"
 *       dest: C:\work\
 *     - src: ./big.zip                     # no dest: only served over HTTP
 *   steps:
 *     - name: install
 *       shell: powershell                  # pwsh | powershell | cmd | winvm
 *       run: |
 *         Start-Process msiexec -ArgumentList '/i','C:\work\app.msi','/qn' -Wait
 *       timeout: 300
 *       continue-on-error: false
 *       env: { FOO: bar }
 *       if: always()                       # success() (default) | failure() | always()
 *       background: true                   # start it and move on (a server, a tray app)
 *   artifacts:
 *     when: failure                        # failure (default) | always
 *     paths: [C:\work\*.log]
 *   screenshot: failure                    # failure (default) | always | never
 *
 * `shell: winvm` runs each line of `run` as a winvm command ON THE HOST against
 * the job's instance (`ui tray … --menu …`, `ui click …`, `webview click …`,
 * `ocr --find …`, `toasts --find …`, `click --text …`); see hoststep.ts and
 * docs/gui.md.
 *
 * Every staged or served file is also reachable from the guest at
 * `$env:WINVM_FILES/<basename>` (http://10.0.2.2:<port>/<token>/files), which
 * is how a job hands an installer an origin to download from.
 *
 * `${{ env.NAME }}` (or `${{ env.NAME || 'default' }}`) in a file entry's
 * fields, or in a step's `run`, is replaced before the job starts (job env,
 * then the host's environment).
 */
import { readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

export type Shell = "pwsh" | "powershell" | "cmd" | "winvm"
export type Condition = "success" | "failure" | "always"
export type When = "failure" | "always" | "never"

export type FileSpec =
  | { readonly kind: "path"; readonly src: string; readonly dest: string | null }
  | { readonly kind: "url"; readonly url: string; readonly dest: string | null }
  | {
      readonly kind: "release"
      readonly repo: string
      readonly tag: string
      readonly patterns: readonly string[]
      readonly dest: string | null
    }

export interface Step {
  readonly name: string
  readonly run: string
  readonly shell: Shell
  readonly timeoutMs: number
  readonly continueOnError: boolean
  readonly env: Readonly<Record<string, string>>
  readonly if: Condition
  readonly background: boolean
}

export interface Job {
  readonly name: string
  /** The file it came from (for messages and relative paths); "" when parsed from text. */
  readonly file: string
  readonly golden: string | null
  readonly reset: boolean
  readonly timeoutMs: number
  readonly env: Readonly<Record<string, string>>
  readonly files: readonly FileSpec[]
  readonly steps: readonly Step[]
  readonly artifacts: { readonly when: When; readonly paths: readonly string[] }
  readonly screenshot: When
}

export class JobError extends Error {}

export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_JOB_TIMEOUT_MS = 60 * 60_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)

function str(o: Obj, key: string, where: string): string | null {
  const v = o[key]
  if (v === undefined || v === null) return null
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  throw new JobError(`${where}: "${key}" must be a string`)
}

function bool(o: Obj, key: string, where: string, dflt: boolean): boolean {
  const v = o[key]
  if (v === undefined || v === null) return dflt
  if (typeof v === "boolean") return v
  throw new JobError(`${where}: "${key}" must be true or false`)
}

/** Seconds (a number, or "90s" / "5m"), returned as milliseconds. */
export function parseDuration(v: unknown, where: string): number | null {
  if (v === undefined || v === null) return null
  if (typeof v === "number" && v > 0) return Math.round(v * 1000)
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(v.trim())
    if (m !== null) {
      const n = Number(m[1])
      const unit = m[2] ?? "s"
      const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000
      if (n > 0) return Math.round(n * mult)
    }
  }
  throw new JobError(`${where}: a duration is a number of seconds, or like "90s", "5m"`)
}

/** GitHub's `timeout-minutes`, as seconds for parseDuration. */
const minutes = (v: unknown): number | undefined => (typeof v === "number" ? v * 60 : undefined)

function env(v: unknown, where: string): Record<string, string> {
  if (v === undefined || v === null) return {}
  if (!isObj(v)) throw new JobError(`${where}: "env" must be a mapping`)
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new JobError(`${where}: bad env name "${k}"`)
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
      throw new JobError(`${where}: env "${k}" must be a scalar`)
    }
    out[k] = String(val)
  }
  return out
}

function shell(v: string | null, where: string): Shell {
  if (v === null) return "powershell"
  if (v === "pwsh" || v === "powershell" || v === "cmd" || v === "winvm") return v
  throw new JobError(`${where}: shell must be pwsh, powershell, cmd or winvm (got "${v}")`)
}

/** `always()`, `failure()`, `success()` — the three conditions a runner can decide alone. */
function condition(v: string | null, where: string): Condition {
  if (v === null) return "success"
  const m = /^\s*(?:\$\{\{\s*)?(success|failure|always)\(\)(?:\s*\}\})?\s*$/.exec(v)
  if (m?.[1] === undefined) throw new JobError(`${where}: "if" supports success(), failure() or always() (got "${v}")`)
  return m[1] as Condition
}

function when(v: string | null, where: string, key: string, dflt: When): When {
  if (v === null) return dflt
  if (v === "failure" || v === "always" || v === "never") return v
  if (v === "on-failure") return "failure"
  throw new JobError(`${where}: "${key}" must be failure, always or never`)
}

function fileSpec(v: unknown, where: string, baseDir: string): FileSpec {
  if (!isObj(v)) throw new JobError(`${where}: each file is a mapping (src/url/release + dest)`)
  const dest = str(v, "dest", where)
  const src = str(v, "src", where)
  const url = str(v, "url", where)
  const repo = str(v, "release", where)
  const given = [src, url, repo].filter((x) => x !== null).length
  if (given !== 1) throw new JobError(`${where}: give exactly one of "src", "url" or "release"`)
  if (src !== null) {
    const expanded = src.startsWith("~/") ? resolve(process.env["HOME"] ?? "", src.slice(2)) : src
    return { kind: "path", src: isAbsolute(expanded) || baseDir === "" ? expanded : resolve(baseDir, expanded), dest }
  }
  if (url !== null) {
    if (!/^https?:\/\//.test(url)) throw new JobError(`${where}: url must be http(s)`)
    return { kind: "url", url, dest }
  }
  if (repo === null || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new JobError(`${where}: release must be owner/repo`)
  const pat = v["pattern"]
  const patterns =
    typeof pat === "string" ? [pat] : Array.isArray(pat) && pat.every((p) => typeof p === "string") ? (pat as string[]) : null
  if (patterns === null || patterns.length === 0) throw new JobError(`${where}: a release file needs "pattern" (one or a list)`)
  return { kind: "release", repo, tag: str(v, "tag", where) ?? "latest", patterns, dest }
}

/**
 * `${{ env.NAME }}` → the job's env, else the host's; unknown names are an
 * error unless a default is given: `${{ env.NAME || 'fallback' }}`.
 */
export function interpolate(text: string, vars: Readonly<Record<string, string>>, where: string): string {
  return text.replace(
    /\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\|\s*'([^']*)'\s*)?\}\}/g,
    (_, name: string, dflt: string | undefined) => {
      const v = vars[name] ?? process.env[name] ?? dflt
      if (v === undefined) throw new JobError(`${where}: \${{ env.${name} }} is not set`)
      return v
    },
  )
}

function interpolateFile(f: FileSpec, vars: Record<string, string>, where: string): FileSpec {
  const i = (s: string): string => interpolate(s, vars, where)
  const dest = f.dest === null ? null : i(f.dest)
  switch (f.kind) {
    case "path":
      return { ...f, src: i(f.src), dest }
    case "url":
      return { ...f, url: i(f.url), dest }
    case "release":
      return { ...f, tag: i(f.tag), patterns: f.patterns.map(i), dest }
  }
}

export function parseJob(text: string, file = ""): Job {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(text)
  } catch (error) {
    throw new JobError(`${file || "job"}: not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  const where = file || "job"
  if (!isObj(raw)) throw new JobError(`${where}: a job is a mapping`)
  const baseDir = file === "" ? "" : dirname(resolve(file))
  const jobEnv = env(raw["env"], where)
  const stepsRaw = raw["steps"]
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) throw new JobError(`${where}: "steps" must be a non-empty list`)
  const steps = stepsRaw.map((s, i): Step => {
    const sw = `${where}: step ${String(i + 1)}`
    if (!isObj(s)) throw new JobError(`${sw}: a step is a mapping`)
    const run = str(s, "run", sw)
    if (run === null || run.trim() === "") throw new JobError(`${sw}: "run" is required`)
    const name = str(s, "name", sw) ?? run.trim().split("\n")[0]?.slice(0, 60) ?? `step ${String(i + 1)}`
    const sh = shell(str(s, "shell", sw), sw)
    if (sh === "winvm" && bool(s, "background", sw, false)) throw new JobError(`${sw}: a winvm step cannot be background`)
    return {
      name,
      run: interpolate(run, jobEnv, sw),
      shell: sh,
      timeoutMs: parseDuration(s["timeout"] ?? minutes(s["timeout-minutes"]), sw) ?? DEFAULT_STEP_TIMEOUT_MS,
      continueOnError: bool(s, "continue-on-error", sw, false),
      env: env(s["env"], sw),
      if: condition(str(s, "if", sw), sw),
      background: bool(s, "background", sw, false),
    }
  })
  const filesRaw = raw["files"] ?? []
  if (!Array.isArray(filesRaw)) throw new JobError(`${where}: "files" must be a list`)
  const files = filesRaw.map((f, i) => {
    const fw = `${where}: file ${String(i + 1)}`
    return interpolateFile(fileSpec(f, fw, baseDir), jobEnv, fw)
  })
  let artifacts: Job["artifacts"] = { when: "failure", paths: [] }
  const a = raw["artifacts"]
  if (Array.isArray(a)) {
    artifacts = { when: "failure", paths: a.map(String) }
  } else if (isObj(a)) {
    const paths = a["paths"]
    if (!Array.isArray(paths)) throw new JobError(`${where}: artifacts.paths must be a list`)
    artifacts = { when: when(str(a, "when", where), where, "artifacts.when", "failure"), paths: paths.map(String) }
  } else if (a !== undefined && a !== null) {
    throw new JobError(`${where}: "artifacts" is a list of guest paths, or { when, paths }`)
  }
  return {
    name: str(raw, "name", where) ?? (file === "" ? "job" : file.replace(/^.*\//, "").replace(/\.ya?ml$/, "")),
    file,
    golden: str(raw, "golden", where),
    reset: bool(raw, "reset", where, true),
    timeoutMs: parseDuration(raw["timeout"], where) ?? DEFAULT_JOB_TIMEOUT_MS,
    env: jobEnv,
    files,
    steps,
    artifacts,
    screenshot: when(str(raw, "screenshot", where), where, "screenshot", "failure"),
  }
}

export const readJob = (file: string): Job => parseJob(readFileSync(file, "utf8"), file)

/**
 * The script a step runs, as the file the shell is given. Like GitHub Actions:
 * the body goes in a file, never on a command line (cmd.exe does not understand
 * the MSVCRT quoting a command line gets), env is set at the top, and a
 * PowerShell script fails on the first error and exits with the last native
 * program's code.
 */
export function stepScript(step: Step, env: Readonly<Record<string, string>>): { readonly ext: ".cmd" | ".ps1"; readonly text: string } {
  const all = { ...env, ...step.env }
  if (step.shell === "cmd") {
    const sets = Object.entries(all).map(([k, v]) => `set "${k}=${v.replaceAll("%", "%%")}"`)
    return { ext: ".cmd", text: ["@echo off", ...sets, step.run.replace(/\r?\n/g, "\r\n"), ""].join("\r\n") }
  }
  const psq = (s: string): string => `'${s.replaceAll("'", "''")}'`
  const sets = Object.entries(all).map(([k, v]) => `$env:${k} = ${psq(v)}`)
  const body = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    ...sets,
    step.run,
    "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }",
    "",
  ].join("\r\n")
  // A BOM, or Windows PowerShell 5.1 reads the file as the ANSI code page.
  return { ext: ".ps1", text: `\uFEFF${body.replace(/\r?\n/g, "\r\n")}` }
}
