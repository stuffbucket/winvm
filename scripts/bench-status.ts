/**
 * Stopped-machine status overhead, in fresh Bun processes. No VM is started;
 * all instance/config state is temporary. Run before/after a status change:
 *
 *   mise exec -- bun scripts/bench-status.ts [samples=9]
 *
 * gatherMs excludes module loading and process startup; processMs includes both.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const samples = Number(process.argv[2] ?? "9")
if (!Number.isInteger(samples) || samples < 3 || samples > 1000) throw new Error("samples must be a whole number from 3 to 1000")

const home = mkdtempSync(resolve(tmpdir(), "winvm-status-bench-"))
const instance = resolve(home, "instances", "dev-status-bench")
const modulePath = resolve(import.meta.dir, "../packages/core/src/status.ts")
const code = `
import { gather } from ${JSON.stringify(modulePath)};
const start = performance.now();
const result = await gather("dev-status-bench", false);
console.log(JSON.stringify({ ms: performance.now() - start, cpus: result.cpus, memoryMiB: result.memoryMiB, state: result.state }));
`
const stats = (runs: number[]): { min: number; median: number; max: number } => {
  const sorted = [...runs].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0
  return { min: sorted[0] ?? 0, median, max: sorted.at(-1) ?? 0 }
}

try {
  mkdirSync(instance, { recursive: true })
  writeFileSync(resolve(instance, "instance.json"), JSON.stringify({ image: "win11-arm64", vnc: 9, created: "" }))
  writeFileSync(resolve(instance, "hardware.json"), JSON.stringify({ cpus: 6, memoryMiB: 8192 }))
  const gatherMs: number[] = []
  const processMs: number[] = []
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now()
    const r = spawnSync(process.execPath, ["--eval", code], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, WINVM_HOME: home, XDG_CONFIG_HOME: resolve(home, "config") },
    })
    processMs.push(performance.now() - started)
    if (r.status !== 0) throw r.error ?? new Error(r.stderr || `status process exited ${String(r.status)}`)
    const result = JSON.parse(r.stdout) as { ms: number; cpus: number; memoryMiB: number; state: string }
    if (result.state !== "stopped" || result.cpus !== 6 || result.memoryMiB !== 8192 || !Number.isFinite(result.ms)) {
      throw new Error(`unexpected status result: ${r.stdout}`)
    }
    gatherMs.push(result.ms)
  }
  console.log(JSON.stringify({ samples, scenario: "stopped status; fresh Bun process per sample; no guest", gatherMs: stats(gatherMs), processMs: stats(processMs) }, null, 2))
} finally {
  rmSync(home, { recursive: true, force: true })
}
