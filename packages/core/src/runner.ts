/**
 * `winvm run` / `winvm test`: run job files (job.ts) against an instance, the
 * way a CI runner would — reset to a golden save, stage files, run steps,
 * collect artifacts — and time every part.
 *
 * THE LIFECYCLE OF ONE JOB
 *
 *   reset     load the golden save (RAM + disk), wait for the guest to answer,
 *             put its clock right. Every job starts from the identical machine.
 *   stage     fetch `files` on the host (a cache under the state dir, so a
 *             release asset is downloaded once), serve them over HTTP on the
 *             host's loopback, and pull them into the guest with one curl.exe
 *             call (10.0.2.2 is the host under QEMU user networking).
 *   steps     each step's body is written to a script file in the guest and
 *             run by its shell, with a timeout and its own env.
 *   collect   on failure (or always): a screenshot and the artifact paths.
 *
 * GOLDEN SAVES (golden.ts): a mapped-ram save taken once the guest has gone
 * quiet, so it restores in about a second. `ensureGolden` creates one on first
 * use — with the in-guest agent installed and a few CI chores done (no sysprep
 * dialog, C:\work exists); `winvm saves -i <instance> rm <golden>` to rebuild.
 *
 * THE CHANNEL (guest.ts): the in-guest agent when it answers — steps run as the
 * logged-on user, in their session, so a tray app shows on the desktop — else
 * qemu-ga, where every step runs as SYSTEM in session 0 (%LOCALAPPDATA% and
 * HKCU are SYSTEM's, nothing launched is visible). WINVM_CHANNEL=qga forces it.
 */
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

import * as agent from "./agent"
import * as golden from "./golden"
import type { Guest } from "./guest"
import { guestFor } from "./guest"
import { capture } from "./host"
import { runHostStep } from "./hoststep"
import * as input from "./input"
import type { FileSpec, Job, Step } from "./job"
import { stepScript } from "./job"
import { ensureInstance } from "./instance"
import { home, pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import type { JobResult, StepResult } from "./report"
import { formatStep, outputTail, secs } from "./report"
import * as saves from "./saves"

export const DEFAULT_GOLDEN = saves.GOLDEN
export const WORK = "C:\\work"
const SCRIPTS = `${WORK}\\.winvm`
const CMD = "C:\\Windows\\System32\\cmd.exe"
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const CURL = "C:\\Windows\\System32\\curl.exe"
/** The host, as the guest sees it under QEMU user networking. */
const HOST_FROM_GUEST = "10.0.2.2"

export const cacheDir = (): string => resolve(home(), "cache")
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "job"

export interface RunOptions {
  readonly instance: string
  /** Overrides the job's own `golden`. */
  readonly golden: string | null
  /** Where artifacts and screenshots go: <dir>/<job>/… */
  readonly artifactsDir: string
  readonly log: (line: string) => void
  /**
   * Polled between steps: once true, the rest of the job is skipped and nothing
   * more is collected. For a pool's watchdog (pool.ts), which gives up on a
   * wedged job and restarts its instance — a step still in flight must not go
   * on to run its successors against the next job's guest.
   */
  readonly cancelled?: () => boolean
}

// ---------------------------------------------------------------------------
// Instance and golden

/**
 * Make sure `golden` exists as a save of `instance`; if not, create it: boot
 * (or use the running guest), do the CI chores, install the in-guest agent,
 * and let golden.ts wait for the guest to settle and take a mapped-ram save.
 * Returns the time spent (0 when it already existed).
 */
export async function ensureGolden(
  instance: string,
  goldenName: string,
  log: (s: string) => void,
  image: string | null = null,
): Promise<number> {
  if (saves.readSave(instance, goldenName) !== null) return 0
  const t0 = Date.now()
  const p = pathsFor(instance)
  log(`golden "${goldenName}" not found on "${instance}": creating it (boot, agent, settle — a few minutes, once)`)
  if (!qemu.isRunning(p)) {
    // A new instance takes WINVM_IMAGE, as `start` would; an existing one keeps its own.
    ensureInstance(instance, readMeta(instance)?.image ?? image ?? process.env["WINVM_IMAGE"] ?? "win11-arm64")
    const meta = readMeta(instance)
    if (meta === null) throw new Error(`could not create instance "${instance}"`)
    await qemu.launch(instance, p, meta, { installMedia: false, ephemeral: false, virtioBoot: readImageMeta(meta.image)?.virtioBoot === true })
  }
  if (!(await qga.waitReady(p.qga, 600_000))) throw new Error(`guest "${instance}" never became ready`)
  // CI chores, frozen into the golden: no audit-mode sysprep dialog on top of
  // every screenshot, and the work dir.
  await qga.exec(p.qga, CMD, ["/c", `taskkill /f /im sysprep.exe >nul 2>&1 & mkdir ${SCRIPTS} 2>nul & exit /b 0`])
  try {
    // ensure, not install: an image with the agent baked in, or an instance
    // that already has one, only needs the token written (~100 ms instead of
    // a ~7 s reinstall).
    await agent.ensure(instance, { log: (l) => log(`  agent: ${l}`) })
  } catch (error) {
    log(`  (no agent — jobs will run over qemu-ga as SYSTEM: ${errMsg(error)})`)
  }
  const r = await golden.createGolden(instance, { name: goldenName, log: (l) => log(`  ${l}`) })
  log(`golden "${goldenName}" created in ${secs(Date.now() - t0)}${r.settled ? "" : " (guest never settled)"}`)
  return Date.now() - t0
}

// ---------------------------------------------------------------------------
// Files on the host

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16)

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  return new RegExp(`^${esc}$`)
}

/** Latest release tag of a repo, asked once per run. */
const latestTags = new Map<string, string>()
function releaseTag(repo: string, tag: string): string {
  if (tag !== "latest") return tag
  const cached = latestTags.get(repo)
  if (cached !== undefined) return cached
  const t = capture("gh", ["release", "view", "-R", repo, "--json", "tagName", "-q", ".tagName"]).trim()
  if (t === "") throw new Error(`could not resolve the latest release of ${repo} (is \`gh\` signed in?)`)
  latestTags.set(repo, t)
  return t
}

/** Host paths for a file entry, downloading into the cache if needed. */
export async function resolveHostFiles(f: FileSpec): Promise<readonly string[]> {
  switch (f.kind) {
    case "path": {
      if (!existsSync(f.src)) throw new Error(`file not found: ${f.src}`)
      return [f.src]
    }
    case "url": {
      const dir = resolve(cacheDir(), "urls", sha1(f.url))
      const dest = resolve(dir, basename(new URL(f.url).pathname) || "download")
      if (!existsSync(dest)) {
        mkdirSync(dir, { recursive: true })
        const r = await fetch(f.url)
        if (!r.ok) throw new Error(`GET ${f.url}: ${String(r.status)}`)
        await Bun.write(`${dest}.partial`, r)
        renameSync(`${dest}.partial`, dest)
      }
      return [dest]
    }
    case "release": {
      const tag = releaseTag(f.repo, f.tag)
      const dir = resolve(cacheDir(), "releases", f.repo, tag)
      mkdirSync(dir, { recursive: true })
      const want = f.patterns.map(globToRegExp)
      const have = (): string[] => readdirSync(dir).filter((n) => !n.startsWith(".") && want.some((re) => re.test(n)))
      // Each pattern must match something already cached, or we ask GitHub.
      if (!f.patterns.every((_, i) => have().some((n) => want[i]?.test(n) === true))) {
        const pats = f.patterns.flatMap((p) => ["-p", p])
        const r = Bun.spawnSync(["gh", "release", "download", tag, "-R", f.repo, ...pats, "-D", dir, "--skip-existing"], {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (r.exitCode !== 0) throw new Error(`gh release download ${f.repo}@${tag}: ${r.stderr.toString().trim()}`)
      }
      const files = have()
      if (files.length === 0) throw new Error(`release ${f.repo}@${tag} has no asset matching ${f.patterns.join(", ")}`)
      return files.sort().map((n) => resolve(dir, n))
    }
  }
}

// ---------------------------------------------------------------------------
// The host's file server

interface FileServer {
  readonly base: string
  readonly filesUrl: string
  readonly uploadUrl: string
  serve(hostPath: string): string
  stop(): void
}

/** Loopback only; a random token in every path, since anything on the host can reach loopback. */
function startServer(uploadDir: string): FileServer {
  const token = randomBytes(16).toString("hex")
  const served = new Map<string, string>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const parts = url.pathname.split("/").filter((s) => s !== "")
      if (parts[0] !== token || parts.length !== 3) return new Response("not found", { status: 404 })
      const name = decodeURIComponent(parts[2] ?? "")
      if (parts[1] === "files" && (req.method === "GET" || req.method === "HEAD")) {
        const path = served.get(name)
        return path === undefined ? new Response("not found", { status: 404 }) : new Response(Bun.file(path))
      }
      if (parts[1] === "upload" && (req.method === "PUT" || req.method === "POST")) {
        if (!/^[\w.-]+$/.test(name)) return new Response("bad name", { status: 400 })
        mkdirSync(uploadDir, { recursive: true })
        await Bun.write(resolve(uploadDir, name), new Uint8Array(await req.arrayBuffer()))
        return new Response("ok")
      }
      return new Response("not found", { status: 404 })
    },
  })
  const base = `http://${HOST_FROM_GUEST}:${String(server.port)}/${token}`
  return {
    base,
    filesUrl: `${base}/files`,
    uploadUrl: `${base}/upload`,
    serve(hostPath) {
      served.set(basename(hostPath), hostPath)
      return `${base}/files/${encodeURIComponent(basename(hostPath))}`
    },
    stop: () => void server.stop(true),
  }
}

// ---------------------------------------------------------------------------
// One job

const guestDir = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("\\")))

async function stage(job: Job, guest: Guest, server: FileServer, log: (s: string) => void): Promise<void> {
  const copies: { url: string; host: string; dest: string }[] = []
  for (const f of job.files) {
    const hosts = await resolveHostFiles(f)
    if (f.dest !== null && hosts.length > 1 && !f.dest.endsWith("\\")) {
      throw new Error(`${String(hosts.length)} files match, so dest must be a directory ending in \\ (${f.dest})`)
    }
    for (const h of hosts) {
      const url = server.serve(h)
      if (f.dest !== null) copies.push({ url, host: h, dest: f.dest.endsWith("\\") ? `${f.dest}${basename(h)}` : f.dest })
    }
  }
  const dirs = [...new Set([SCRIPTS, ...copies.map((c) => guestDir(c.dest))])].filter((d) => d !== "")
  const mk = await guest.run([CMD, "/c", dirs.map((d) => `mkdir "${d}" 2>nul`).join(" & ") + " & exit /b 0"], 60_000)
  if (mk.exitcode !== 0) throw new Error(`mkdir in the guest failed: ${mk.stderr}`)
  if (copies.length === 0) return
  if (guest.fastFiles) {
    for (const c of copies) await guest.putFile(c.host, c.dest)
  } else {
    // One curl for every file: a guest exec costs ~100 ms, a big file over
    // qga's base64 JSON costs far more than over HTTP.
    const args = copies.flatMap((c) => ["-o", c.dest, c.url])
    const r = await guest.run([CURL, "-sSf", "--retry", "3", "--retry-all-errors", ...args], 600_000)
    if (r.exitcode !== 0) throw new Error(`staging files with curl.exe failed (${String(r.exitcode)}): ${r.stderr.trim()}`)
  }
  const bytes = copies.reduce((a, c) => a + statSync(c.host).size, 0)
  log(`  staged ${String(copies.length)} file(s), ${saves.formatBytes(bytes)}`)
}

let pwshPresent: boolean | null = null
async function shellArgv(step: Step, guest: Guest, script: string): Promise<readonly string[]> {
  if (step.shell === "cmd") return [CMD, "/d", "/c", script]
  let exe = POWERSHELL
  if (step.shell === "pwsh") {
    pwshPresent ??= (await guest.run([CMD, "/c", `if exist "${PWSH}" (exit /b 0) else (exit /b 1)`], 30_000)).exitcode === 0
    // The golden image has only Windows PowerShell 5.1; pwsh falls back to it.
    if (pwshPresent) exe = PWSH
  }
  return [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]
}

async function runStep(
  step: Step,
  index: number,
  env: Readonly<Record<string, string>>,
  guest: Guest,
  remainingMs: number,
  instance: string,
): Promise<StepResult> {
  const t0 = Date.now()
  if (step.shell === "winvm") {
    // On the host, against the instance: see hoststep.ts.
    const r = await runHostStep(step.run, instance, { ...env, ...step.env }, Math.min(step.timeoutMs, Math.max(1000, remainingMs)))
    const status = r.timedOut ? "timed-out" : r.exitcode === 0 ? "passed" : "failed"
    return { name: step.name, continueOnError: step.continueOnError, background: false, status, exitcode: r.timedOut ? null : r.exitcode, ms: Date.now() - t0, stdout: r.stdout, stderr: r.stderr }
  }
  const s = stepScript(step, env)
  const script = `${SCRIPTS}\\${String(index + 1)}${s.ext}`
  await guest.put(script, s.text)
  const argv = await shellArgv(step, guest, script)
  const base = { name: step.name, continueOnError: step.continueOnError, background: step.background }
  if (step.background) {
    // Started and left running (a server, a tray app); its output to a log
    // the artifacts can collect. A wrapper, because qga passes argv through
    // MSVCRT quoting, which cmd.exe redirection does not survive.
    const log = `${SCRIPTS}\\${String(index + 1)}.log`
    const wrapper = `${SCRIPTS}\\${String(index + 1)}-bg.cmd`
    const line = argv.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")
    await guest.put(wrapper, `@echo off\r\n${line} > "${log}" 2>&1\r\n`)
    const pid = await guest.launch([CMD, "/d", "/c", wrapper])
    return { ...base, status: "passed", exitcode: 0, ms: Date.now() - t0, stdout: `started (pid ${String(pid)}), output in ${log}\n`, stderr: "" }
  }
  const r = await guest.run(argv, Math.min(step.timeoutMs, Math.max(1000, remainingMs)))
  return {
    ...base,
    status: r.timedOut ? "timed-out" : r.exitcode === 0 ? "passed" : "failed",
    exitcode: r.timedOut ? null : r.exitcode,
    ms: Date.now() - t0,
    stdout: r.stdout,
    stderr: r.stderr,
  }
}

/** Guest paths matching `pattern` (wildcards in the last part; %VARS% expanded by cmd). */
async function expand(guest: Guest, pattern: string): Promise<readonly string[]> {
  const r = await guest.run([CMD, "/c", `for %f in ("${pattern}") do @if exist "%~ff" echo %~ff`], 60_000)
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
}

async function collect(job: Job, guest: Guest, instance: string, dir: string, failed: boolean, log: (s: string) => void): Promise<string[]> {
  const out: string[] = []
  const want = (w: Job["screenshot"]): boolean => w === "always" || (w === "failure" && failed)
  if (want(job.screenshot)) {
    try {
      const file = resolve(dir, "screenshot.png")
      await input.screenshot(pathsFor(instance), file)
      out.push(file)
    } catch (error) {
      log(`  (no screenshot: ${errMsg(error)})`)
    }
  }
  if (want(job.artifacts.when)) {
    for (const pattern of job.artifacts.paths) {
      for (const path of await expand(guest, pattern)) {
        try {
          const bytes = await guest.get(path)
          if (bytes === null) continue
          const file = resolve(dir, path.replace(/^([A-Za-z]):\\/, "$1\\").replace(/[\\:]+/g, "_"))
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, bytes)
          out.push(file)
        } catch (error) {
          log(`  (could not collect ${path}: ${errMsg(error)})`)
        }
      }
    }
  }
  return out
}

export async function runJob(job: Job, o: RunOptions): Promise<JobResult> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const goldenName = o.golden ?? job.golden ?? DEFAULT_GOLDEN
  const p = pathsFor(o.instance)
  const dir = resolve(o.artifactsDir, slug(job.name))
  const result = (r: Partial<JobResult> & Pick<JobResult, "status">): JobResult => ({
    name: job.name,
    file: job.file,
    error: null,
    instance: o.instance,
    golden: job.reset ? goldenName : null,
    channel: "",
    resetMs: 0,
    stageMs: 0,
    stepsMs: 0,
    collectMs: 0,
    steps: [],
    artifacts: [],
    startedAt,
    totalMs: Date.now() - t0,
    ...r,
  })
  o.log(`\n▶ ${job.name}${job.file === "" ? "" : `  (${job.file})`}`)

  let resetMs = 0
  if (job.reset) {
    try {
      const r = await golden.resetToGolden(o.instance, goldenName)
      resetMs = Date.now() - t0
      o.log(
        `  reset to "${goldenName}" in ${secs(resetMs)} ` +
          `(restore ${secs(r.restoredMs)}, answer ${secs(r.responsiveMs)}, clock ${secs(r.clockMs)})`,
      )
    } catch (error) {
      return result({ status: "error", error: `reset to "${goldenName}" failed: ${errMsg(error)}`, resetMs: Date.now() - t0 })
    }
  } else if (!qemu.isRunning(p)) {
    return result({ status: "error", error: `instance "${o.instance}" is not running and the job has reset: false` })
  }

  const guest = await guestFor(o.instance)
  const server = startServer(dir)
  try {
    const t1 = Date.now()
    try {
      await stage(job, guest, server, o.log)
    } catch (error) {
      o.log(`  staging failed: ${errMsg(error)}`)
      return result({ status: "error", error: `staging failed: ${errMsg(error)}`, resetMs, stageMs: Date.now() - t1, channel: guest.kind })
    }
    const stageMs = Date.now() - t1

    const env = {
      WINVM_FILES: server.filesUrl,
      WINVM_UPLOAD: server.uploadUrl,
      WINVM_WORK: WORK,
      WINVM_JOB: job.name,
      CI: "true",
      ...job.env,
    }
    const t2 = Date.now()
    const deadline = t0 + job.timeoutMs
    const steps: StepResult[] = []
    let failed = false
    for (const [i, step] of job.steps.entries()) {
      const run = step.if === "always" || (step.if === "failure" ? failed : !failed)
      let r: StepResult
      if (!run || Date.now() > deadline || o.cancelled?.() === true) {
        r = { name: step.name, status: "skipped", exitcode: null, ms: 0, stdout: "", stderr: "", continueOnError: step.continueOnError, background: step.background }
      } else {
        try {
          r = await runStep(step, i, env, guest, deadline - Date.now(), o.instance)
        } catch (error) {
          r = { name: step.name, status: "failed", exitcode: null, ms: 0, stdout: "", stderr: errMsg(error), continueOnError: step.continueOnError, background: step.background }
        }
      }
      steps.push(r)
      o.log(formatStep(r))
      if ((r.status === "failed" || r.status === "timed-out") && !r.continueOnError) {
        failed = true
        const tail = outputTail(r)
        if (tail !== "") o.log(tail)
      }
    }
    const stepsMs = Date.now() - t2

    const t3 = Date.now()
    if (o.cancelled?.() === true) return result({ status: "error", error: "cancelled", resetMs, stageMs, stepsMs, steps, channel: guest.kind })
    const artifacts = await collect(job, guest, o.instance, dir, failed, o.log).catch((error: unknown) => {
      o.log(`  (collecting artifacts failed: ${errMsg(error)})`)
      return [] as string[]
    })
    if (artifacts.length > 0) o.log(`  artifacts: ${dir}`)
    return result({
      status: failed ? "failed" : "passed",
      channel: `${guest.kind} (${guest.session})`,
      resetMs,
      stageMs,
      stepsMs,
      collectMs: Date.now() - t3,
      steps,
      artifacts,
    })
  } finally {
    server.stop()
  }
}

/** Is `instance` usable for jobs at all? null when yes, else why not. */
export function instanceProblem(instance: string): string | null {
  const meta = readMeta(instance)
  if (meta === null) return null // created on demand
  if (saves.isEphemeral(pathsFor(instance))) return `instance "${instance}" is --ephemeral and cannot hold a golden save`
  return null
}
