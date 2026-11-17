import { afterEach, beforeEach, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const SCRIPT = resolve(import.meta.dir, "accept-keeper.sh")
const onMac = process.platform === "darwin"
let run = ""

beforeEach(() => {
  run = mkdtempSync(resolve(tmpdir(), "winvm-accept-keeper-"))
  mkdirSync(resolve(run, "keeper"))
})

afterEach(() => {
  rmSync(run, { recursive: true, force: true })
})

const report = (): { status: number | null; out: string } => {
  const r = spawnSync("bash", [SCRIPT, "report", run], { encoding: "utf8" })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

it.if(onMac)(
  "reports a stop action that was killed before its first beat",
  () => {
    writeFileSync(resolve(run, "child.beat"), "1794929319\n1794929320\n")
    writeFileSync(
      resolve(run, "stop.beat"),
      "start 1794929320 deadline-ms 1794929370000\n",
    )
    const { status, out } = report()
    expect(status).toBe(0)
    expect(out).toContain("--- stop action")
    expect(out).toContain("start 1794929320 deadline-ms 1794929370000")
    expect(out).toContain("no beats")
    expect(out).toContain("--- keeper.log")
  },
)

it.if(onMac)("reports a run with no files at all", () => {
  const { status, out } = report()
  expect(status).toBe(0)
  expect(out).toContain("--- child heartbeat\n  none")
})

it("tells the user the one-time setup before the steps", () => {
  const usage = spawnSync("bash", [SCRIPT], { encoding: "utf8" }).stdout
  expect(usage).toContain("mise trust native/keeper/mise.toml")
  expect(usage).toContain("pnpm install --frozen-lockfile")
})
