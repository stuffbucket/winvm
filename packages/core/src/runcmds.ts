import { readdirSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Args } from "./args"
import { parseArgs } from "./args"
import * as commands from "./commands"
import type { Job } from "./job"
import { JobError, readJob } from "./job"
import { InstanceBusy, withOperation } from "./operation"
import { home, pathsFor } from "./paths"
import * as qemu from "./qemu"
import { poolOptions, runPool } from "./pool"
import type { JobResult, RunSummary } from "./report"
import { formatSummary, poolStats, toJson, toJunit } from "./report"
import { DEFAULT_GOLDEN, ensureGolden, instanceProblem, runJob } from "./runner"
import * as saves from "./saves"
import * as watcher from "./watch"

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 2
}

const stamp = (d: Date): string => d.toISOString().replace(/[:]/g, "").replace(/\..*$/, "")

export function jobFiles(paths: readonly string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      out.push(
        ...readdirSync(p)
          .filter((n) => /\.ya?ml$/.test(n) && !n.startsWith("."))
          .sort()
          .map((n) => resolve(p, n)),
      )
    } else {
      out.push(resolve(p))
    }
  }
  return out
}

function report(summary: RunSummary, args: Args): number {
  console.log(formatSummary(summary))
  const junit = args.flags.get("junit")
  if (junit !== undefined) {
    writeFileSync(junit, toJunit(summary))
    console.log(`junit: ${resolve(junit)}`)
  }
  const json = args.flags.get("json")
  if (json !== undefined) {
    writeFileSync(json, toJson(summary))
    console.log(`json: ${resolve(json)}`)
  }
  return summary.jobs.every((r) => r.status === "passed") ? 0 : 1
}

async function runAll(files: readonly string[], args: Args): Promise<number> {
  const wall0 = Date.now()
  const pool = poolOptions(args)
  if (pool !== null) {
    if ("error" in pool) return fail(pool.error)
    let jobs: Job[]
    try {
      jobs = files.map(readJob)
    } catch (error) {
      return fail(error instanceof JobError ? error.message : errMsg(error))
    }
    if (jobs.length === 0) return fail("no jobs to run")
    try {
      const r = await runPool(jobs, pool)
      return report({ jobs: r.results, wallMs: Date.now() - wall0, setupMs: r.setupMs, pool: poolStats(r.results, r.instances) }, args)
    } catch (error) {
      return fail(errMsg(error))
    }
  }
  const instance = args.flags.get("instance") ?? process.env["WINVM_INSTANCE"] ?? "ci"
  const goldenFlag = args.flags.get("golden") ?? null
  const artifactsDir = resolve(args.flags.get("artifacts") ?? resolve(home(), "runs", instance, stamp(new Date())))
  const problem = instanceProblem(instance)
  if (problem !== null) return fail(problem)

  let jobs: Job[]
  try {
    jobs = files.map(readJob)
  } catch (error) {
    return fail(error instanceof JobError ? error.message : errMsg(error))
  }
  if (jobs.length === 0) return fail("no jobs to run")

  console.log(`winvm run: ${String(jobs.length)} job(s) on instance "${instance}"; artifacts in ${artifactsDir}`)
  if (await watcher.stopWatcher(instance)) console.log(`  stopped the idle watcher of "${instance}"`)

  const boot = async (name: string): Promise<number> =>
    await withOperation(name, "start", async () => await commands.start(parseArgs(["-i", name, "--no-watch", "--no-autosave"]))).catch(
      (error: unknown) => {
        if (!(error instanceof InstanceBusy)) throw error
        return fail(error.message)
      },
    )
  const goldens = [...new Set(jobs.filter((j) => j.reset).map((j) => goldenFlag ?? j.golden ?? DEFAULT_GOLDEN))]
  try {
    for (const g of goldens) await ensureGolden(instance, g, (s) => { console.log(s) })
  } catch (error) {
    return fail(errMsg(error))
  }
  if (!qemu.isRunning(pathsFor(instance)) && jobs.some((j) => !j.reset) && (await boot(instance)) !== 0) {
    return fail(`could not start instance "${instance}"`)
  }
  const setupMs = Date.now() - wall0

  const results: JobResult[] = []
  for (const job of jobs) {
    results.push(await runJob(job, { instance, golden: goldenFlag, artifactsDir, log: (s) => { console.log(s) } }))
    const last = results.at(-1)
    if (last?.error !== null && last?.error !== undefined) console.log(`  error: ${last.error}`)
  }

  const p = pathsFor(instance)
  if (args.flags.has("keep")) {
    console.log(`\n--keep: instance "${instance}" left running in the last job's state (\`winvm open -i ${instance}\`)`)
  } else if (qemu.isRunning(p)) {
    await withOperation(instance, "stop", async () => { await saves.quitQemu(p) }).catch((error: unknown) => {
      if (!(error instanceof InstanceBusy)) throw error
      console.warn(`warning: left "${instance}" running: ${error.message}`)
    })
  }

  return report({ jobs: results, wallMs: Date.now() - wall0, setupMs }, args)
}

export async function run(args: Args): Promise<number> {
  if (args.positional.length === 0) return fail("usage: winvm run <job.yml>... [-i name] [--golden NAME] [--keep] [--junit f] [--json f] [--artifacts dir]")
  let files: string[]
  try {
    files = jobFiles(args.positional)
  } catch (error) {
    return fail(errMsg(error))
  }
  return await runAll(files, args)
}

export async function test(args: Args): Promise<number> {
  const dirs = args.positional.length === 0 ? ["."] : args.positional
  let files: string[]
  try {
    files = jobFiles(dirs)
  } catch (error) {
    return fail(errMsg(error))
  }
  return await runAll(files, args)
}
