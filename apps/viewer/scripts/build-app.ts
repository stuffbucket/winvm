import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const VIEWER = resolve(import.meta.dir, "..")
const ROOT = resolve(VIEWER, "..", "..")
const CONF = resolve(VIEWER, "src-tauri", "tauri.conf.json")
const APP = resolve(VIEWER, "src-tauri", "target", "release", "bundle", "macos", "winvm.app")

function step(cmd: string, args: readonly string[], cwd = ROOT): void {
  const r = spawnSync(cmd, [...args], { cwd, stdio: "inherit", env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "15.0" } })
  if (r.status !== 0) {
    console.error(`::error::${cmd} ${args.join(" ")} failed`)
    process.exit(r.status ?? 1)
  }
}

const version = process.argv[2]
if (version !== undefined) {
  const conf = JSON.parse(readFileSync(CONF, "utf8")) as { version: string }
  conf.version = version
  writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`)
}
const want = (JSON.parse(readFileSync(CONF, "utf8")) as { version: string }).version

step("bun", [resolve(VIEWER, "scripts", "build-ui.ts")])
step("bun", [resolve(VIEWER, "scripts", "build-sidecar.ts")])
rmSync(APP, { recursive: true, force: true })
step("pnpm", ["exec", "tauri", "build", "--bundles", "app"], VIEWER)
step("bun", [resolve(VIEWER, "scripts", "stage.ts"), resolve(APP, "Contents", "Resources")])
step("bun", [resolve(VIEWER, "scripts", "sign-list.ts"), "--check", APP])

const got = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", resolve(APP, "Contents", "Info.plist")], {
  encoding: "utf8",
}).stdout.trim()
if (got !== want) {
  console.error(`::error::the app says version ${got}, expected ${want}`)
  process.exit(1)
}
if (!existsSync(resolve(APP, "Contents", "MacOS", "winvm"))) {
  console.error("::error::the app has no Contents/MacOS/winvm")
  process.exit(1)
}
console.log(APP)
