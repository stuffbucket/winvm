/**
 * Results of `winvm run` / `winvm test`, and their three renderings: the
 * console summary, JUnit XML (what every CI system ingests), and JSON. Pure.
 *
 * THE NUMBER THAT MATTERS is the reset share: of the wall clock, how much went
 * to putting the guest back to its golden state rather than testing. Fast
 * resets are the whole premise of running installers in a VM per job; if the
 * share creeps toward half, the harness is measuring itself.
 */
export type StepStatus = "passed" | "failed" | "timed-out" | "skipped"
export type JobStatus = "passed" | "failed" | "error"

export interface StepResult {
  readonly name: string
  readonly status: StepStatus
  readonly exitcode: number | null
  readonly ms: number
  readonly stdout: string
  readonly stderr: string
  readonly continueOnError: boolean
  readonly background: boolean
}

export interface JobResult {
  readonly name: string
  readonly file: string
  readonly status: JobStatus
  /** Set when the job could not run at all (bad file, reset failed, staging failed). */
  readonly error: string | null
  readonly instance: string
  readonly golden: string | null
  readonly channel: string
  readonly resetMs: number
  readonly stageMs: number
  readonly stepsMs: number
  readonly collectMs: number
  readonly totalMs: number
  readonly steps: readonly StepResult[]
  /** Host paths of collected artifacts and screenshots. */
  readonly artifacts: readonly string[]
  readonly startedAt: string
}

export interface RunSummary {
  readonly jobs: readonly JobResult[]
  /** Wall clock for the whole run, including any boot and golden creation. */
  readonly wallMs: number
  /** One-off setup before the first job (boot, golden creation), already in wallMs. */
  readonly setupMs: number
  /** Set by `winvm test --pool` (pool.ts). */
  readonly pool?: PoolStats
}

/**
 * A pool's timing. With jobs running side by side, summed reset time says
 * little — a reset on one instance while others run jobs costs nothing — so
 * the figure that matters is EXPOSED reset: wall-clock time when some
 * instance was resetting and none was running a job.
 */
export interface PoolStats {
  readonly instances: readonly string[]
  /** From the first job's reset starting to the last job finishing (setup excluded). */
  readonly runMs: number
  /** Sum over jobs of stage + steps + collect. */
  readonly jobMs: number
  /** Sum over jobs of their resets. */
  readonly resetMs: number
  readonly exposedResetMs: number
  readonly perInstance: readonly { readonly instance: string; readonly jobs: number; readonly busyMs: number }[]
}

export interface Interval {
  readonly start: number
  readonly end: number
}

/** Merge overlapping intervals; the result is sorted and disjoint. */
export function merge(xs: readonly Interval[]): Interval[] {
  const sorted = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const x of sorted) {
    const last = out.at(-1)
    if (last !== undefined && x.start <= last.end) out[out.length - 1] = { start: last.start, end: Math.max(last.end, x.end) }
    else out.push({ ...x })
  }
  return out
}

const length = (xs: readonly Interval[]): number => xs.reduce((a, x) => a + x.end - x.start, 0)

/** Time covered by `a` and not by `b`. */
export function uncoveredMs(a: readonly Interval[], b: readonly Interval[]): number {
  const bs = merge(b)
  let out = 0
  for (const x of merge(a)) {
    let covered = 0
    for (const y of bs) covered += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start))
    out += x.end - x.start - covered
  }
  return out
}

/** A job's reset, then its work (stage, steps, collect), as wall-clock intervals. */
export function jobIntervals(j: JobResult): { readonly reset: Interval; readonly work: Interval } {
  const start = Date.parse(j.startedAt)
  return { reset: { start, end: start + j.resetMs }, work: { start: start + j.resetMs, end: start + j.totalMs } }
}

export function poolStats(jobs: readonly JobResult[], instances: readonly string[]): PoolStats {
  const iv = jobs.map(jobIntervals)
  const all = merge(iv.flatMap((x) => [x.reset, x.work]))
  return {
    instances,
    runMs: all.length === 0 ? 0 : (all.at(-1)?.end ?? 0) - (all[0]?.start ?? 0),
    jobMs: jobs.reduce((a, j) => a + j.stageMs + j.stepsMs + j.collectMs, 0),
    resetMs: jobs.reduce((a, j) => a + j.resetMs, 0),
    exposedResetMs: uncoveredMs(
      iv.map((x) => x.reset),
      iv.map((x) => x.work),
    ),
    perInstance: instances.map((instance) => {
      const mine = jobs.filter((j) => j.instance === instance)
      return { instance, jobs: mine.length, busyMs: length(merge(mine.map((j) => jobIntervals(j)).flatMap((x) => [x.reset, x.work]))) }
    }),
  }
}

export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`
const pct = (part: number, whole: number): string => (whole <= 0 ? "-" : `${((100 * part) / whole).toFixed(0)}%`)

export function totals(s: RunSummary): {
  readonly passed: number
  readonly failed: number
  readonly resetMs: number
  readonly testMs: number
  readonly overheadMs: number
} {
  const resetMs = s.jobs.reduce((a, j) => a + j.resetMs, 0)
  const testMs = s.jobs.reduce((a, j) => a + j.stageMs + j.stepsMs + j.collectMs, 0)
  return {
    passed: s.jobs.filter((j) => j.status === "passed").length,
    failed: s.jobs.filter((j) => j.status !== "passed").length,
    resetMs,
    testMs,
    overheadMs: Math.max(0, s.wallMs - resetMs - testMs),
  }
}

const mark = (st: StepStatus | JobStatus): string =>
  st === "passed" ? "ok  " : st === "skipped" ? "skip" : st === "timed-out" ? "TIME" : st === "error" ? "ERR " : "FAIL"

/** One line per step as it finishes. */
export function formatStep(r: StepResult): string {
  const tail = r.status === "failed" && r.continueOnError ? " (continue-on-error)" : r.background ? " (background)" : ""
  const code = r.exitcode === null || r.exitcode === 0 ? "" : ` exit ${String(r.exitcode)}`
  return `  [${mark(r.status)}] ${r.name} — ${secs(r.ms)}${code}${tail}`
}

/** The last lines of a failed step's output, indented. */
export function outputTail(r: StepResult, lines = 15): string {
  const text = `${r.stdout}${r.stderr === "" ? "" : `\n${r.stderr}`}`.trim()
  if (text === "") return ""
  return text
    .split(/\r?\n/)
    .slice(-lines)
    .map((l) => `      | ${l.trimEnd()}`)
    .join("\n")
}

export function formatSummary(s: RunSummary): string {
  const t = totals(s)
  const pool = s.pool
  const out: string[] = ["", "job".padEnd(34) + "result   reset    stage    steps    collect  total" + (pool === undefined ? "" : "    instance")]
  for (const j of s.jobs) {
    out.push(
      j.name.slice(0, 33).padEnd(34) +
        j.status.padEnd(9) +
        [j.resetMs, j.stageMs, j.stepsMs, j.collectMs, j.totalMs].map((ms) => secs(ms).padEnd(9)).join("") +
        (pool === undefined ? "" : j.instance),
    )
  }
  out.push(
    "",
    `${String(t.passed)} passed, ${String(t.failed)} failed in ${secs(s.wallMs)} wall clock` +
      (s.setupMs > 0 ? ` (${secs(s.setupMs)} of it one-off setup)` : ""),
    `reset ${secs(t.resetMs)} vs test ${secs(t.testMs)}: resets were ${pct(t.resetMs, s.wallMs)} of the wall clock` +
      ` (${pct(t.resetMs, s.wallMs - s.setupMs)} excluding setup)`,
  )
  if (pool !== undefined) out.push(...formatPool(pool))
  return out.join("\n")
}

export function formatPool(p: PoolStats): string[] {
  const serial = p.jobMs + p.resetMs
  return [
    `pool of ${String(p.instances.length)} (${p.instances.join(", ")}): ${secs(p.runMs)} wall clock, setup excluded; ` +
      `job time ${secs(p.jobMs)} summed, resets ${secs(p.resetMs)} summed` +
      (p.runMs > 0 ? ` — ${(serial / p.runMs).toFixed(2)}x one instance back to back` : ""),
    `exposed reset (resetting, no job running): ${secs(p.exposedResetMs)}, ${pct(p.exposedResetMs, p.runMs)} of the wall clock`,
    `  ${p.perInstance.map((i) => `${i.instance}: ${String(i.jobs)} job(s), busy ${secs(i.busyMs)}`).join("; ")}`,
  ]
}

const xmlEscape = (s: string): string =>
  s
    // XML 1.0 forbids most control characters outright, even escaped.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const sec = (ms: number): string => (ms / 1000).toFixed(3)

/** JUnit XML: a testsuite per job, a testcase per step; reset and staging as their own cases. */
export function toJunit(s: RunSummary): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>']
  const t = totals(s)
  const cases = s.jobs.reduce((a, j) => a + j.steps.length + 1, 0)
  out.push(
    `<testsuites name="winvm" tests="${String(cases)}" failures="${String(t.failed)}" time="${sec(s.wallMs)}">`,
  )
  for (const j of s.jobs) {
    const failures = j.steps.filter((r) => (r.status === "failed" || r.status === "timed-out") && !r.continueOnError).length
    const skipped = j.steps.filter((r) => r.status === "skipped").length
    out.push(
      `  <testsuite name="${xmlEscape(j.name)}" tests="${String(j.steps.length + 1)}" failures="${String(failures)}"` +
        ` errors="${j.status === "error" ? "1" : "0"}" skipped="${String(skipped)}" time="${sec(j.totalMs)}" timestamp="${j.startedAt}">`,
    )
    out.push(
      `    <properties><property name="instance" value="${xmlEscape(j.instance)}"/>` +
        `<property name="golden" value="${xmlEscape(j.golden ?? "")}"/>` +
        `<property name="channel" value="${xmlEscape(j.channel)}"/>` +
        `<property name="file" value="${xmlEscape(j.file)}"/></properties>`,
    )
    const setup = `    <testcase classname="${xmlEscape(j.name)}" name="reset + stage" time="${sec(j.resetMs + j.stageMs)}"`
    out.push(j.error === null ? `${setup}/>` : `${setup}><error message="${xmlEscape(j.error)}"/></testcase>`)
    for (const r of j.steps) {
      const head = `    <testcase classname="${xmlEscape(j.name)}" name="${xmlEscape(r.name)}" time="${sec(r.ms)}">`
      const body: string[] = []
      if (r.status === "skipped") body.push("      <skipped/>")
      if ((r.status === "failed" || r.status === "timed-out") && !r.continueOnError) {
        const msg = r.status === "timed-out" ? "timed out" : `exit code ${String(r.exitcode)}`
        body.push(`      <failure message="${xmlEscape(msg)}"/>`)
      }
      if (r.stdout !== "") body.push(`      <system-out>${xmlEscape(r.stdout)}</system-out>`)
      if (r.stderr !== "") body.push(`      <system-err>${xmlEscape(r.stderr)}</system-err>`)
      out.push(head, ...body, "    </testcase>")
    }
    out.push("  </testsuite>")
  }
  out.push("</testsuites>", "")
  return out.join("\n")
}

export function toJson(s: RunSummary): string {
  const t = totals(s)
  return `${JSON.stringify(
    {
      ...t,
      wallMs: s.wallMs,
      setupMs: s.setupMs,
      resetShare: s.wallMs > 0 ? t.resetMs / s.wallMs : null,
      ...(s.pool === undefined
        ? {}
        : { pool: { ...s.pool, exposedResetShare: s.pool.runMs > 0 ? s.pool.exposedResetMs / s.pool.runMs : null } }),
      jobs: s.jobs,
    },
    null,
    2,
  )}\n`
}
