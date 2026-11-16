import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { availableParallelism, totalmem } from "node:os"
import { dirname, resolve } from "node:path"

import { ensureState, readState, writeState } from "./agentfwd"
import type { Args } from "./args"
import { parseDuration } from "./golden"
import { NEW_DEFAULT } from "./hardware"
import type { Job } from "./job"
import { withOperation } from "./operation"
import { home, pathsFor, readMeta } from "./paths"
import * as qemu from "./qemu"
import type { JobResult } from "./report"
import {
  DEFAULT_GOLDEN,
  ensureGolden,
  instanceProblem,
  resolveHostFiles,
  runJob,
} from "./runner"
import * as saves from "./saves"
import * as watcher from "./watch"

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)
const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

export const VCPUS = NEW_DEFAULT.cpus
export const MEMORY_BYTES = NEW_DEFAULT.memoryMiB * 1024 ** 2
export const WATCHDOG_GRACE_MS = 5 * 60_000
const watchdogGraceMs = (): number => {
  const v = process.env.WINVM_POOL_GRACE
  return v === undefined || v === "" ? WATCHDOG_GRACE_MS : parseDuration(v)
}

export const poolMembers = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1)}`)

export function poolSizeError(raw: string): string | null {
  if (!/^\d+$/.test(raw))
    return `--pool takes a number of instances, got "${raw}"`
  const n = Number(raw)
  if (n < 1 || n > 16) return `--pool must be 1-16, got ${String(n)}`
  return null
}

export function resourceWarnings(
  n: number,
  cpus: number,
  memBytes: number,
): string[] {
  const out: string[] = []
  if (n * VCPUS > cpus)
    out.push(
      `${String(n)} instances x ${String(VCPUS)} vCPUs is more than the host's ${String(cpus)} cores; jobs will contend`,
    )
  if (n * MEMORY_BYTES > memBytes / 2) {
    out.push(
      `${String(n)} instances x ${saves.formatBytes(MEMORY_BYTES)} is more than half the host's ${saves.formatBytes(memBytes)} of memory`,
    )
  }
  return out
}

export const isResetFailure = (r: JobResult): boolean =>
  r.status === "error" && (r.error ?? "").startsWith("reset to ")

export function longestFirst(
  keys: readonly string[],
  lastMs: Readonly<Record<string, number>>,
): number[] {
  const t = (i: number): number =>
    lastMs[keys[i] ?? ""] ?? Number.POSITIVE_INFINITY
  return keys
    .map((_, i) => i)
    .sort((a, b) => (t(a) === t(b) ? a - b : t(b) - t(a)))
}

export interface ScheduleDeps<J> {
  readonly run: (job: J, instance: string) => Promise<JobResult>
  readonly recover: (instance: string) => Promise<void>
  readonly log: (instance: string, line: string) => void
  readonly abandoned: (job: J, why: string) => JobResult
}

export async function schedule<J>(
  jobs: readonly J[],
  instances: readonly string[],
  deps: ScheduleDeps<J>,
): Promise<JobResult[]> {
  const results: (JobResult | undefined)[] = jobs.map(() => undefined)
  const queue: { readonly index: number; readonly requeued: boolean }[] =
    jobs.map((_, index) => ({ index, requeued: false }))
  const alive = new Set(instances)

  const worker = async (instance: string): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const job = jobs[item.index] as J
      let r = await deps.run(job, instance)
      if (isResetFailure(r)) {
        deps.log(
          instance,
          `reset failed (${r.error ?? ""}); restarting the instance and trying again`,
        )
        await deps.recover(instance)
        r = await deps.run(job, instance)
      }
      if (isResetFailure(r)) {
        alive.delete(instance)
        if (!item.requeued && alive.size > 0) {
          deps.log(
            instance,
            `still cannot reset: retiring this instance; job #${String(item.index + 1)} goes back on the queue`,
          )
          queue.push({ index: item.index, requeued: true })
        } else {
          deps.log(instance, "still cannot reset: retiring this instance")
          results[item.index] = r
        }
        return
      }
      results[item.index] = r
    }
  }

  while (queue.length > 0 && alive.size > 0)
    await Promise.all([...alive].map(worker))
  return results.map(
    (r, i) =>
      r ??
      deps.abandoned(jobs[i] as J, "no instance in the pool could be reset"),
  )
}

const timesPath = (): string => resolve(home(), "runs", "job-times.json")

function readTimes(): Record<string, number> {
  try {
    const o = JSON.parse(readFileSync(timesPath(), "utf8")) as unknown
    return typeof o === "object" && o !== null
      ? (o as Record<string, number>)
      : {}
  } catch {
    return {}
  }
}

function writeTimes(results: readonly JobResult[]): void {
  const t = readTimes()
  for (const r of results)
    if (r.file !== "" && r.status !== "error") t[r.file] = r.totalMs
  try {
    mkdirSync(dirname(timesPath()), { recursive: true })
    writeFileSync(timesPath(), `${JSON.stringify(t, null, 2)}\n`)
  } catch {}
}

async function cloneGolden(
  from: string,
  to: string,
  name: string,
  log: (s: string) => void,
): Promise<boolean> {
  const src = saves.readSave(from, name)
  if (src === null) throw new Error(`"${from}" has no golden "${name}"`)
  const have = saves.readSave(to, name)
  if (have !== null) {
    const c = have.clonedFrom
    if (
      c === undefined ||
      (c.instance === from && c.createdAt === src.createdAt)
    )
      return true
  }
  try {
    await saves.cloneSave(from, to, name)
  } catch (error) {
    if (error instanceof saves.IncompatibleSave) {
      log(
        `cannot clone "${from}"'s golden to "${to}" (${error.message}); creating one there`,
      )
      return false
    }
    throw error
  }
  const token = readState(pathsFor(from))?.token
  if (token !== undefined) {
    const own = ensureState(pathsFor(to))
    writeState(pathsFor(to), { token, hostPort: own.hostPort })
  }
  log(`golden "${name}" cloned from "${from}" to "${to}"`)
  return true
}

async function ensurePoolGoldens(
  members: readonly string[],
  goldens: readonly string[],
  image: string | null,
  log: (s: string) => void,
): Promise<void> {
  const [first, ...rest] = members
  if (first === undefined) return
  for (const g of goldens) {
    await ensureGolden(first, g, log, image)
    const independent: string[] = []
    for (const m of rest)
      if (!(await cloneGolden(first, m, g, log))) independent.push(m)
    await Promise.all(
      independent.map(
        async (m) =>
          await ensureGolden(
            m,
            g,
            (s) => {
              log(`[${m}] ${s}`)
            },
            image,
          ),
      ),
    )
  }
}

async function hardStop(instance: string): Promise<void> {
  const p = pathsFor(instance)
  const pid = qemu.pidOf(p)
  if (pid !== null && qemu.isInstanceQemu(pid, p)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
    for (let i = 0; i < 100 && qemu.pidOf(p) !== null; i += 1) await sleep(100)
  }
  qemu.stopSidecars(p)
  await sleep(2000)
}

function stub(
  job: Job,
  instance: string,
  status: JobResult["status"],
  error: string,
  startedAt: number,
): JobResult {
  return {
    name: job.name,
    file: job.file,
    status,
    error,
    instance,
    golden: null,
    channel: "",
    resetMs: 0,
    stageMs: 0,
    stepsMs: 0,
    collectMs: 0,
    totalMs: Date.now() - startedAt,
    steps: [],
    artifacts: [],
    startedAt: new Date(startedAt).toISOString(),
  }
}

export interface PoolOptions {
  readonly size: number
  readonly prefix: string
  readonly golden: string | null
  readonly image: string | null
  readonly artifactsDir: string | null
  readonly keep: boolean
}

export interface PoolRun {
  readonly results: JobResult[]
  readonly setupMs: number
  readonly instances: readonly string[]
}

const tagged =
  (instance: string) =>
  (line: string): void => {
    for (const l of line.split("\n"))
      console.log(l === "" ? "" : `[${instance}] ${l}`)
  }

export async function runPool(
  jobs: readonly Job[],
  o: PoolOptions,
): Promise<PoolRun> {
  const t0 = Date.now()
  const members = poolMembers(o.prefix, o.size)
  for (const m of members) {
    const problem = instanceProblem(m)
    if (problem !== null) throw new Error(problem)
  }
  if (jobs.some((j) => !j.reset))
    throw new Error(
      "--pool runs every job from a golden; a job with `reset: false` depends on the one before it",
    )
  for (const w of resourceWarnings(o.size, availableParallelism(), totalmem()))
    console.log(`warning: ${w}`)
  const stamp = new Date()
    .toISOString()
    .replace(/[:]/g, "")
    .replace(/\..*$/, "")
  const artifactsDir = resolve(
    o.artifactsDir ?? resolve(home(), "runs", `${o.prefix}-pool`, stamp),
  )
  console.log(
    `winvm test: ${String(jobs.length)} job(s) over ${String(o.size)} instance(s) (${members.join(", ")}); artifacts in ${artifactsDir}`,
  )
  for (const m of members)
    if (await watcher.stopWatcher(m))
      console.log(`  stopped the idle watcher of "${m}"`)

  for (const job of jobs) for (const f of job.files) await resolveHostFiles(f)

  const image = o.image ?? readMeta(members[0] ?? "")?.image ?? null
  const goldens = [
    ...new Set(jobs.map((j) => o.golden ?? j.golden ?? DEFAULT_GOLDEN)),
  ]
  await ensurePoolGoldens(members, goldens, image, (s) => {
    console.log(s)
  })
  const setupMs = Date.now() - t0

  const run = async (job: Job, instance: string): Promise<JobResult> => {
    const started = Date.now()
    let cancelled = false
    const log = tagged(instance)
    const watchdogMs = job.timeoutMs + watchdogGraceMs()
    let timer: ReturnType<typeof setTimeout> | undefined
    const wedged = new Promise<"wedged">((res) => {
      timer = setTimeout(() => {
        res("wedged")
      }, watchdogMs)
    })
    const ran = runJob(job, {
      instance,
      golden: o.golden,
      artifactsDir,
      log: (l) => {
        if (!cancelled) log(l)
      },
      cancelled: () => cancelled,
    }).catch((error: unknown) =>
      stub(job, instance, "error", `runner failed: ${errMsg(error)}`, started),
    )
    const r = await Promise.race([ran, wedged])
    clearTimeout(timer)
    if (r !== "wedged") {
      if (r.error !== null) log(`  error: ${r.error}`)
      return r
    }
    cancelled = true
    log(
      `  watchdog: no result ${String(Math.round(watchdogMs / 1000))} s in; killing the instance (the next job resets it)`,
    )
    await hardStop(instance)
    return stub(
      job,
      instance,
      "error",
      `wedged: no result after ${String(Math.round(watchdogMs / 1000))} s; instance restarted`,
      started,
    )
  }

  const order = longestFirst(
    jobs.map((j) => j.file),
    readTimes(),
  )
  const queued = await schedule(
    order.map((i) => jobs[i] as Job),
    members,
    {
      run,
      recover: hardStop,
      log: (i, l) => {
        tagged(i)(l)
      },
      abandoned: (job, why) => stub(job, "", "error", why, Date.now()),
    },
  )
  const results: JobResult[] = new Array<JobResult>(jobs.length)
  order.forEach((jobIndex, k) => {
    results[jobIndex] = queued[k] as JobResult
  })
  writeTimes(results)

  if (o.keep) {
    console.log(`\n--keep: instances left running in their last job's state`)
  } else {
    await Promise.all(
      members.map(async (m) => {
        await withOperation(m, "stop", async () => {
          await saves.quitQemu(pathsFor(m))
        }).catch((error: unknown) => {
          console.warn(`warning: left "${m}" running: ${errMsg(error)}`)
        })
      }),
    )
  }
  return { results, setupMs, instances: members }
}

export function poolOptions(
  args: Args,
): PoolOptions | { readonly error: string } | null {
  const raw = args.flags.get("pool")
  if (raw === undefined) return null
  const err = poolSizeError(raw)
  if (err !== null) return { error: err }
  return {
    size: Number(raw),
    prefix: args.flags.get("pool-prefix") ?? "ci",
    golden: args.flags.get("golden") ?? null,
    image: args.flags.get("image") ?? process.env.WINVM_IMAGE ?? null,
    artifactsDir: args.flags.get("artifacts") ?? null,
    keep: args.flags.has("keep"),
  }
}
