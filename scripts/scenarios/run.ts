import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "@winvm/core/args"

import { must, smbMounts } from "./lib"
import { ALL, type Context, ready } from "./scenarios"

const args = parseArgs(process.argv.slice(2))
const name = args.flags.get("instance")
if (name === undefined || name === "default") {
  console.error("usage: bun scripts/scenarios/run.ts -i <scratch machine> [--only a,b] [--hold S] [--out DIR] [--real-xdg]")
  process.exit(2)
}
const names = Object.keys(ALL) as (keyof typeof ALL)[]
const only = args.flags.get("only")?.split(",") ?? names
const unknown = only.filter((n) => !(names as string[]).includes(n))
if (unknown.length > 0) {
  console.error(`unknown scenario(s): ${unknown.join(", ")} (known: ${names.join(", ")})`)
  process.exit(2)
}
const holdS = Number(args.flags.get("hold") ?? "60")
const out = resolve(args.flags.get("out") ?? resolve(tmpdir(), `winvm-scenarios-${new Date().toISOString().replace(/[:.]/g, "-")}`))
mkdirSync(out, { recursive: true })

let xdg: string | null = null
if (!args.flags.has("real-xdg")) {
  xdg = mkdtempSync(resolve(tmpdir(), "winvm-scen-xdg-"))
  process.env["XDG_CONFIG_HOME"] = resolve(xdg, "config")
  process.env["XDG_DATA_HOME"] = resolve(xdg, "data")
}

console.log(`scenarios on "${name}" · WINVM_HOME=${process.env["WINVM_HOME"] ?? "(default)"} · WINVM_RUNTIME=${process.env["WINVM_RUNTIME"] ?? "(default)"}`)
console.log(`evidence in ${out}\n`)

const ctx: Context = { name, holdS, out }
await ready(name)
const hadMounts = (await smbMounts(name)).length > 0
if (!hadMounts) await must(["files", "mount", "-i", name, "home", "--json"], { timeoutMs: 180_000 })

const results: { title: string; ok: boolean; skipped: string | null; checks: { name: string; ok: boolean; evidence: string }[]; notes: string[] }[] = []
for (const key of names.filter((n) => only.includes(n))) {
  const started = Date.now()
  console.log(key)
  const sc = await ALL[key](ctx)
  console.log(`  -> ${sc.skipped !== null ? "SKIPPED" : sc.ok ? "PASS" : "FAIL"} (${String(Math.round((Date.now() - started) / 1000))} s)\n`)
  results.push({ title: sc.title, ok: sc.ok, skipped: sc.skipped, checks: sc.checks, notes: sc.notes })
  await ready(name).catch((error: unknown) => { console.error(`could not get "${name}" ready again: ${String(error)}`) })
}

if (!hadMounts) await must(["files", "unmount", "-i", name, "--json"]).catch(() => undefined)
if (xdg !== null) rmSync(xdg, { recursive: true, force: true })

writeFileSync(resolve(out, "report.json"), `${JSON.stringify(results, null, 2)}\n`)
console.log("summary")
for (const r of results) console.log(`  ${r.skipped !== null ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.title}${r.skipped !== null ? ` (${r.skipped})` : ""}`)
console.log(`\n  ${resolve(out, "report.json")}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
