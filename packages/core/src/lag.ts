import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import * as agent from "./agent"
import { qmpCommand } from "./monitor"
import type { Paths } from "./paths"
import * as qemu from "./qemu"
import { cpuSeconds, vcpusOf, watchPathsFor } from "./watch"

export const STALL_MS = 250

export const ANSWER_TIMEOUT_MS = 5000

export interface LagSample {
  readonly t: number
  readonly lateMs: number
  readonly qmp: number | null
  readonly agent: number | null | undefined
  readonly state: string | null
  readonly cpu: number | null
  readonly proc: string | null
  readonly minPri: number | null
}

export type StallKind =
  | "paused"
  | "mac"
  | "qemu"
  | "windows"
  | "monitor"
  | "recorder"

export interface Stall {
  readonly kind: StallKind
  readonly startMs: number
  readonly durationMs: number
  readonly samples: number
  readonly worstMs: number
  readonly explanation: string
}

export interface LayerStats {
  readonly answered: number
  readonly missed: number
  readonly p50: number | null
  readonly p95: number | null
  readonly max: number | null
}

export interface LagReport {
  readonly seconds: number
  readonly qmp: LayerStats
  readonly agent: LayerStats | null
  readonly stalls: readonly Stall[]
  readonly peakCpu: number | null
  readonly minPri: number | null
  readonly summary: string
}

const slow = (ms: number | null | undefined): boolean =>
  ms === null || (ms !== undefined && ms > STALL_MS)

function stats(values: readonly (number | null)[]): LayerStats {
  const got = values
    .filter((v): v is number => v !== null)
    .toSorted((a, b) => a - b)
  const at = (q: number): number | null =>
    got.length === 0
      ? null
      : (got[Math.min(got.length - 1, Math.floor(q * got.length))] ?? null)
  return {
    answered: got.length,
    missed: values.length - got.length,
    p50: at(0.5),
    p95: at(0.95),
    max: got.at(-1) ?? null,
  }
}

function sampleKind(s: LagSample): StallKind | null {
  if (s.state !== null && s.state !== "running") return "paused"
  const q = slow(s.qmp)
  const a = s.agent === undefined ? false : slow(s.agent)
  const late = s.lateMs > STALL_MS
  if (late && (q || a)) return "mac"
  if (q && a) return "qemu"
  if (a) return "windows"
  if (q) return "monitor"
  if (late) return "recorder"
  return null
}

const EXPLAIN: Readonly<Record<StallKind, string>> = {
  paused:
    "the machine was PAUSED (QEMU's monitor answered at once and said it is not running): a save (an autosave stops the guest for about 1.5 s), a stow, or someone's pause. The lines of watch.log and events.jsonl at that time say which.",
  mac: "EVERYTHING stopped together, this recorder's own timer included: the Mac did not run its processes (a short sleep or nap, or the host swapping or starved). Check `pmset -g log` and `vm_stat` for that minute.",
  qemu: "QEMU's monitor AND the agent's connection (which runs through QEMU) stopped while the Mac kept running this recorder: QEMU's main loop was held (a save or screen dump, host paging its memory in) or the QEMU process was stalled. Capture `sample <pid> 3` during the next one.",
  windows:
    "QEMU answered at once and only the agent inside Windows did not: the guest stopped scheduling (vCPUs starved, Windows busy at a priority above the agent's, the guest swapping or at a driver wait). Look inside Windows: its event log and performance counters for that minute.",
  monitor:
    "only QEMU's monitor was slow while the agent answered: the monitor is shared with other clients (a save, the app polling); the guest itself kept running.",
  recorder:
    "only this recorder's own timer was late while QEMU and Windows answered on time: this process was not scheduled (the Mac was busy). QEMU's answers were prompt.",
}

export function analyzeLag(samples: readonly LagSample[]): LagReport {
  const hasAgent = samples.some((s) => s.agent !== undefined)
  const stalls: Stall[] = []
  let run: {
    kind: StallKind
    from: LagSample
    last: LagSample
    n: number
    worst: number
  } | null = null
  const rtt = (s: LagSample): number =>
    Math.max(
      s.qmp ?? ANSWER_TIMEOUT_MS,
      s.agent === undefined ? 0 : (s.agent ?? ANSWER_TIMEOUT_MS),
      s.lateMs,
    )
  const close = (): void => {
    if (run === null) return
    stalls.push({
      kind: run.kind,
      startMs: run.from.t,
      durationMs: Math.max(1, run.last.t + rtt(run.last) - run.from.t),
      samples: run.n,
      worstMs: run.worst,
      explanation: EXPLAIN[run.kind],
    })
    run = null
  }
  for (const s of samples) {
    const kind = sampleKind(s)
    if (kind === null) {
      close()
      continue
    }
    if (run !== null && run.kind !== kind) close()
    const worst = rtt(s)
    if (run === null) run = { kind, from: s, last: s, n: 1, worst }
    else {
      run.last = s
      run.n += 1
      run.worst = Math.max(run.worst, worst)
    }
  }
  close()

  const cpus = samples.flatMap((s) => (s.cpu === null ? [] : [s.cpu]))
  const pris = samples.flatMap((s) => (s.minPri === null ? [] : [s.minPri]))
  const qmpStats = stats(samples.map((s) => s.qmp))
  const agentStats = hasAgent
    ? stats(samples.flatMap((s) => (s.agent === undefined ? [] : [s.agent])))
    : null
  const peakCpu = cpus.length === 0 ? null : Math.max(...cpus)
  const minPri = pris.length === 0 ? null : Math.min(...pris)
  const fmt = (v: number | null): string =>
    v === null ? "-" : `${String(v)} ms`
  const summary =
    `${String(samples.length)} s: monitor p50 ${fmt(qmpStats.p50)} max ${fmt(qmpStats.max)}${qmpStats.missed > 0 ? ` (${String(qmpStats.missed)} unanswered)` : ""}` +
    (agentStats === null
      ? ", no agent to ask"
      : `; agent p50 ${fmt(agentStats.p50)} max ${fmt(agentStats.max)}${agentStats.missed > 0 ? ` (${String(agentStats.missed)} unanswered)` : ""}`) +
    `; ${stalls.length === 0 ? "no stall" : `${String(stalls.length)} stall(s): ${stalls.map((x) => `${x.kind} ${(x.durationMs / 1000).toFixed(1)} s`).join(", ")}`}`
  return {
    seconds: samples.length,
    qmp: qmpStats,
    agent: agentStats,
    stalls,
    peakCpu,
    minPri,
    summary,
  }
}

export function minThreadPriority(psOutput: string): number | null {
  let min: number | null = null
  for (const line of psOutput.split("\n").slice(1)) {
    const m = /\s(\d+)[A-Za-z]?\s+\d+:\d{2}\.\d{2}\s+\d+:\d{2}\.\d{2}/.exec(
      line,
    )
    if (m?.[1] === undefined) continue
    const n = Number(m[1])
    if (min === null || n < min) min = n
  }
  return min
}

function psThreads(pid: number): number | null {
  const r = spawnSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" })
  return r.status === 0 ? minThreadPriority(r.stdout) : null
}

async function timedMs(
  fn: () => Promise<unknown>,
): Promise<{ readonly ms: number | null; readonly value: unknown }> {
  const t0 = performance.now()
  try {
    const value = await fn()
    return { ms: Math.round(performance.now() - t0), value }
  } catch {
    return { ms: null, value: null }
  }
}

export interface LagProbe {
  qmp(): Promise<{ readonly ms: number | null; readonly state: string | null }>
  agent: (() => Promise<number | null>) | undefined
  process(): {
    readonly proc: string | null
    readonly cpuSec: number | null
    readonly minPri: number | null
  }
}

export const CAPTURE_AFTER_MS = 500

export const CAPTURE_COOLDOWN_MS = 30_000

export const captureFile = (dir: string, at: number): string =>
  resolve(
    dir,
    `lag-sample-${new Date(at).toISOString().replace(/[:.]/g, "-")}.txt`,
  )

export function realProbe(
  p: Paths,
  capture?: { readonly onCapture: (file: string) => void },
): LagProbe {
  const pid = qemu.pidOf(p)
  let lastCapture = 0
  const startCapture = (): void => {
    if (
      pid === null ||
      capture === undefined ||
      Date.now() - lastCapture < CAPTURE_COOLDOWN_MS
    )
      return
    lastCapture = Date.now()
    const file = captureFile(p.dir, lastCapture)
    try {
      const child = spawn("sample", [String(pid), "2", "-file", file], {
        stdio: "ignore",
      })
      child.on("error", () => undefined)
      child.unref()
      capture.onCapture(file)
    } catch {}
  }
  const state = agent.readState(p)
  const client =
    state === null || state.hostPort === null
      ? null
      : agent.clientFor({ token: state.token, hostPort: state.hostPort })
  return {
    qmp: async () => {
      const slowTimer =
        capture === undefined
          ? undefined
          : setTimeout(startCapture, CAPTURE_AFTER_MS)
      const r = await timedMs(
        async () =>
          await qmpCommand(p.qmp, "query-status", undefined, ANSWER_TIMEOUT_MS),
      ).finally(() => {
        clearTimeout(slowTimer)
      })
      const status = (r.value as { status?: unknown } | null)?.status
      return { ms: r.ms, state: typeof status === "string" ? status : null }
    },
    agent:
      client === null
        ? undefined
        : async () =>
            (await timedMs(async () => await client.health(ANSWER_TIMEOUT_MS)))
              .ms,
    process: () => {
      if (pid === null) return { proc: null, cpuSec: null, minPri: null }
      const ps = spawnSync("ps", ["-o", "state=", "-p", String(pid)], {
        encoding: "utf8",
      })
      return {
        proc: ps.status === 0 ? ps.stdout.trim() || null : null,
        cpuSec: cpuSeconds(pid),
        minPri: psThreads(pid),
      }
    },
  }
}

export interface RecordOptions {
  readonly seconds: number
  readonly onSample?: (s: LagSample, index: number) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export async function recordLag(
  probe: LagProbe,
  o: RecordOptions,
): Promise<LagSample[]> {
  const now = o.now ?? Date.now
  const sleep =
    o.sleep ??
    (async (ms: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, ms))
    })
  const out: LagSample[] = []
  const start = now()
  let prevCpu = probe.process().cpuSec
  let prevAt = start
  for (let i = 0; i < o.seconds; i += 1) {
    const due = start + i * 1000
    const ready = Math.max(due, prevAt)
    const wait = ready - now()
    if (wait > 0) await sleep(wait)
    const began = now()
    const [q, a] = await Promise.all([
      probe.qmp(),
      probe.agent === undefined ? Promise.resolve(undefined) : probe.agent(),
    ])
    const ps = probe.process()
    const at = now()
    const dt = (at - prevAt) / 1000
    const cpu =
      i > 0 && ps.cpuSec !== null && prevCpu !== null && dt > 0
        ? Math.max(0, Math.round(((ps.cpuSec - prevCpu) / dt) * 100))
        : null
    prevCpu = ps.cpuSec
    prevAt = at
    const s: LagSample = {
      t: due,
      lateMs: Math.max(0, began - ready),
      qmp: q.ms,
      agent: a,
      state: q.state,
      cpu,
      proc: ps.proc,
      minPri: ps.minPri,
    }
    out.push(s)
    o.onSample?.(s, i)
  }
  return out
}

export interface ContextLine {
  readonly at: number
  readonly text: string
}

export function eventsBetween(
  file: string,
  from: number,
  to: number,
): ContextLine[] {
  if (!existsSync(file)) return []
  const out: ContextLine[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue
    try {
      const e = JSON.parse(line) as {
        t?: string
        kind?: string
        state?: string
        what?: string
      }
      const at = Date.parse(e.t ?? "")
      if (!Number.isFinite(at) || at < from || at > to) continue
      out.push({
        at,
        text: `events: ${e.kind ?? "?"} ${e.state ?? e.what ?? ""}`.trim(),
      })
    } catch {}
  }
  return out
}

export function watchLogBetween(
  file: string,
  from: number,
  to: number,
): ContextLine[] {
  if (!existsSync(file)) return []
  const out: ContextLine[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[[^\]]*\] (.*)$/.exec(line)
    if (m?.[1] === undefined || m[2] === undefined) continue
    const at = Date.parse(m[1])
    if (at < from || at > to || m[2].startsWith("tick:")) continue
    out.push({ at, text: `watch.log: ${m[2]}` })
  }
  return out
}

const clock = (t: number): string => new Date(t).toISOString().slice(11, 23)
const ms = (v: number | null | undefined): string =>
  v === undefined
    ? "  n/a"
    : v === null
      ? "  NONE"
      : `${String(v).padStart(5)} ms`

export function formatSample(s: LagSample, index: number): string {
  const bad = sampleKind(s) !== null
  return (
    `${String(index).padStart(3)}  ${clock(s.t)}  monitor ${ms(s.qmp).padStart(8)}  agent ${ms(s.agent).padStart(8)}` +
    `  ${(s.state ?? "?").padEnd(9)} cpu ${s.cpu === null ? "  -" : String(s.cpu).padStart(3)}%  ps ${(s.proc ?? "?").padEnd(2)}` +
    `${s.lateMs > STALL_MS ? `  (timer ${String(s.lateMs)} ms late)` : ""}${bad ? `  <-- ${sampleKind(s) ?? ""}` : ""}`
  )
}

export function formatLagReport(
  name: string,
  report: LagReport,
  context: readonly ContextLine[],
): string {
  const out: string[] = [`lag recording for "${name}": ${report.summary}`]
  if (report.minPri !== null) {
    out.push(
      `QEMU thread priority: lowest ${String(report.minPri)} (31 = normal)${report.minPri < 20 ? "; a LOW priority: macOS treats QEMU as background work and may starve it" : ""}; ` +
        `peak ${report.peakCpu === null ? "?" : String(report.peakCpu)}% of one core`,
    )
  }
  if (report.stalls.length === 0) {
    out.push(
      `ok  every answer came within ${String(STALL_MS)} ms. If you felt a stall during these seconds it was not in QEMU's monitor, the agent or this Mac's scheduling; ` +
        "look at the viewer (a dropped connection, a window the Mac was not drawing) or inside the guest.",
    )
  }
  for (const s of report.stalls) {
    out.push(
      `STALL ${clock(s.startMs)} ${(s.durationMs / 1000).toFixed(1)} s (worst answer ${String(s.worstMs)} ms) [${s.kind}]\n      ${s.explanation}`,
    )
  }
  if (context.length > 0) {
    out.push("what else logged in that time:")
    for (const c of context.toSorted((a, b) => a.at - b.at))
      out.push(`  ${clock(c.at)}  ${c.text}`)
  }
  return out.join("\n")
}

export function appendToWatchLog(
  name: string,
  report: LagReport,
  at = new Date(),
): void {
  const line = (s: string): string => `${at.toISOString()} [${name}] ${s}\n`
  let text = line(`lag: recorded ${report.summary}`)
  for (const s of report.stalls)
    text += line(
      `lag: ${s.kind} stall at ${new Date(s.startMs).toISOString()}, ${(s.durationMs / 1000).toFixed(1)} s (worst ${String(s.worstMs)} ms)`,
    )
  try {
    appendFileSync(watchPathsFor(name).log, text)
  } catch {}
}

export async function lagCommand(
  name: string,
  p: Paths,
  seconds: number,
  json: boolean,
  sample = false,
): Promise<number> {
  if (qemu.pidOf(p) === null) {
    console.error(
      `::error::instance "${name}" is not running: there is nothing to time`,
    )
    return 1
  }
  const captures: string[] = []
  const probe = realProbe(
    p,
    sample ? { onCapture: (f) => captures.push(f) } : undefined,
  )
  const vcpus = vcpusOf(qemu.pidOf(p) ?? 0)
  if (!json) {
    console.log(
      `recording ${String(seconds)} s for "${name}" (${String(vcpus)} vCPUs): once a second, the monitor, the agent and QEMU's process are asked, nothing is sent to the guest.`,
    )
    if (probe.agent === undefined)
      console.log("(no agent installed: only QEMU's monitor can be timed)")
    if (sample)
      console.log(
        `--sample: a monitor silent for ${String(CAPTURE_AFTER_MS)} ms gets \`sample\` run on QEMU for 2 s (files beside the instance's logs)`,
      )
    console.log(
      "run this while the stall happens; lines marked <-- are slower than 250 ms.\n",
    )
  }
  const started = Date.now()
  const samples = await recordLag(probe, {
    seconds,
    onSample: (s, i) => {
      if (!json) console.log(formatSample(s, i))
    },
  })
  const report = analyzeLag(samples)
  const context = [
    ...eventsBetween(p.events, started - 2000, Date.now()),
    ...watchLogBetween(watchPathsFor(name).log, started - 2000, Date.now()),
  ]
  appendToWatchLog(name, report)
  if (captures.length > 0) {
    try {
      appendFileSync(
        watchPathsFor(name).log,
        `${new Date().toISOString()} [${name}] lag: QEMU stacks during a stall: ${captures.join(", ")}\n`,
      )
    } catch {}
  }
  if (json)
    console.log(
      JSON.stringify(
        { instance: name, report, samples, context, captures },
        null,
        2,
      ),
    )
  else {
    const stacks =
      captures.length > 0
        ? `\nQEMU's stacks during the stall (what each thread was waiting on):\n${captures.map((c) => `  ${c}`).join("\n")}`
        : ""
    console.log(`\n${formatLagReport(name, report, context)}${stacks}`)
  }
  return report.stalls.length === 0 ? 0 : 1
}
