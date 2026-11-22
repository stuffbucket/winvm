import { spawn } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

interface Job {
  readonly pid: number
  readonly program: string
}

const jobs = resolve(tmpdir(), "winvm-fake-launchd")
const [verb = "", target = "", plist = ""] = process.argv.slice(2)
const jobFile = (label: string): string => resolve(jobs, `${label}.json`)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readJob(label: string): Job | null {
  try {
    const job = JSON.parse(readFileSync(jobFile(label), "utf8")) as Job
    if (alive(job.pid)) return job
  } catch {
    return null
  }
  rmSync(jobFile(label), { force: true })
  return null
}

const fromXml = (text: string): string =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

function stringAfter(xml: string, key: string): string {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
    xml,
  )
  return fromXml(m?.[1] ?? "")
}

function bootstrap(path: string): number {
  const xml = readFileSync(path, "utf8")
  const label = stringAfter(xml, "Label")
  if (readJob(label) !== null) {
    console.error(`Bootstrap failed: 5: Input/output error (${label})`)
    return 5
  }
  const listed =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1]
  const argv = [...(listed ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(
    (m) => fromXml(m[1] ?? ""),
  )
  const [program, ...rest] = argv
  if (program === undefined) return 1
  const log = openSync(stringAfter(xml, "StandardOutPath"), "a")
  const child = spawn(program, rest, {
    cwd: stringAfter(xml, "WorkingDirectory"),
    detached: true,
    stdio: ["ignore", log, log],
  })
  closeSync(log)
  child.unref()
  if (child.pid === undefined) return 1
  mkdirSync(jobs, { recursive: true })
  writeFileSync(
    jobFile(label),
    JSON.stringify({ pid: child.pid, program } satisfies Job),
  )
  return 0
}

function bootout(label: string): number {
  const job = readJob(label)
  rmSync(jobFile(label), { force: true })
  if (job === null) return 113
  process.kill(job.pid, "SIGTERM")
  return 0
}

function print(of: string): number {
  const label = of.split("/").slice(2).join("/")
  if (label === "") {
    const labels = existsSync(jobs)
      ? readdirSync(jobs)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -".json".length))
      : []
    for (const l of labels) {
      const job = readJob(l)
      if (job !== null) console.log(`\t\t${String(job.pid)} 0 ${l}`)
    }
    return 0
  }
  const job = readJob(label)
  if (job === null) return 113
  console.log(
    `\tstate = running\n\tprogram = ${job.program}\n\tpid = ${String(job.pid)}\n\truns = 1`,
  )
  return 0
}

const code =
  verb === "bootstrap"
    ? bootstrap(plist)
    : verb === "bootout"
      ? bootout(target.split("/").slice(2).join("/"))
      : verb === "print"
        ? print(target)
        : 64
process.exit(code)
