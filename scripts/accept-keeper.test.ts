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
  "reports what the control service saw: its signals, the host end and its stow",
  () => {
    writeFileSync(resolve(run, "child.beat"), "1794929319\n1794929320\n")
    writeFileSync(
      resolve(run, "service.beat"),
      [
        "start 1794929300 ppid 77 keeper 77",
        "1794929301",
        "signal SIGTERM 1794929320",
        "host-ending 1794929320 deadline-ms 1794929367000 budget-ms 55000",
        "1794929321",
        "stowed 1794929324",
        "stopped 1794929325",
        "",
      ].join("\n"),
    )
    const { status, out } = report()
    expect(status).toBe(0)
    expect(out).toContain("--- control service")
    expect(out).toContain("  start 1794929300 ppid 77 keeper 77")
    expect(out).toContain("  signal SIGTERM 1794929320")
    expect(out).toContain(
      "  host-ending 1794929320 deadline-ms 1794929367000 budget-ms 55000",
    )
    expect(out).toContain("  stowed 1794929324")
    expect(out).toContain("  stopped 1794929325")
    expect(out).toContain("2 beats")
    expect(out).toContain("--- keeper.log")
  },
)

it.if(onMac)("reports a control service that never started", () => {
  writeFileSync(resolve(run, "child.beat"), "1794929319\n")
  const { out } = report()
  expect(out).toContain("--- control service\n  none")
})

it.if(onMac)("reports a run with no files at all", () => {
  const { status, out } = report()
  expect(status).toBe(0)
  expect(out).toContain("--- child heartbeat\n  none")
})

it("tells the user the one-time setup before the steps", () => {
  const usage = spawnSync("bash", [SCRIPT], { encoding: "utf8" }).stdout
  expect(usage).toContain("mise trust native/keeper/mise.toml")
  expect(usage).toContain("pnpm install --frozen-lockfile")
  expect(usage).toContain("control service")
})
