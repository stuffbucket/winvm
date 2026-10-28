import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"

import { ensureRuntime, findRuntime, verifyRuntime } from "../../../packages/core/src/runtime"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const CORE = resolve(ROOT, "packages", "core")

const resources = process.argv[2]
if (resources === undefined) {
  console.error("usage: bun apps/viewer/scripts/stage.ts <App.app/Contents/Resources>")
  process.exit(2)
}

const winvm = resolve(resources, "winvm")
rmSync(winvm, { recursive: true, force: true })
mkdirSync(resolve(winvm, "packages", "core", "src"), { recursive: true })
cpSync(resolve(ROOT, ".bun-version"), resolve(winvm, ".bun-version"))
cpSync(resolve(CORE, "package.json"), resolve(winvm, "packages", "core", "package.json"))
cpSync(resolve(CORE, "src", "guestagent.ts"), resolve(winvm, "packages", "core", "src", "guestagent.ts"))
for (const dir of ["assets", "firmware", "web"]) {
  cpSync(resolve(CORE, dir), resolve(winvm, "packages", "core", dir), { recursive: true })
}
// The agent skills (`winvm skills`), found at <package>/../../skills.
cpSync(resolve(ROOT, "skills"), resolve(winvm, "skills"), { recursive: true, dereference: true })

const rt = (process.env["WINVM_RUNTIME"] ?? "") !== "" ? findRuntime() : await ensureRuntime()
if (rt === null || rt.manifest === null) {
  console.error("no runtime with a manifest to bundle")
  process.exit(1)
}
const problems = verifyRuntime({ ...rt, source: "cache" })
if (problems.length > 0) {
  console.error(`the runtime in ${rt.dir} does not verify: ${problems.join("; ")}`)
  process.exit(1)
}
const runtime = resolve(resources, "runtime")
rmSync(runtime, { recursive: true, force: true })
if (spawnSync("cp", ["-R", rt.dir, runtime], { stdio: "inherit" }).status !== 0) process.exit(1)
console.log(`staged winvm data and runtime ${rt.manifest.version} into ${resources}`)
