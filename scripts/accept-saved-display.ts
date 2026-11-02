#!/usr/bin/env bun
/** usage: bun scripts/accept-saved-display.ts /path/to/immutable/image-directory */
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"

import { measureOffset } from "../packages/core/src/clock"
import { ensureInstance } from "../packages/core/src/instance"
import { readDisplay } from "../packages/core/src/display"
import { pathsFor } from "../packages/core/src/paths"
import { quitQemu, readSave } from "../packages/core/src/saves"
import { stopService } from "../packages/core/src/service"

const source = process.argv[2]
if (source === undefined || !existsSync(resolve(source, "base.qcow2"))) {
  throw new Error("provide an immutable image directory containing base.qcow2 and image.json")
}
const state = mkdtempSync("/tmp/winvm-display-")
process.env["WINVM_HOME"] = state
const name = "accept-display"
const cli = resolve(import.meta.dir, "../apps/cli/src/winvm.ts")
const p = pathsFor(name)
const sizeA = { device: "virtio-gpu", width: 1920, height: 1080 } as const
const sizeB = { device: "virtio-gpu", width: 2560, height: 1440 } as const
let passed = false

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message)
}
function w(verb: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [cli, verb, "-i", name, ...args], { encoding: "utf8", timeout: 600_000 })
  console.log(`$ winvm ${verb} -i ${name} ${args.join(" ")}\n${r.stdout}${r.stderr}`)
  if (r.error !== undefined) throw r.error
  check(r.status === 0, `${verb} exited ${String(r.status)}`)
  return r.stdout
}
function screenshot(label: string): string {
  const file = resolve(state, `${label}.png`)
  w("screenshot", file)
  const png = readFileSync(file)
  check(png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "not a PNG")
  return `${String(png.readUInt32BE(16))}x${String(png.readUInt32BE(20))}`
}
function marker(value?: string): string {
  const path = "C:\\Windows\\Temp\\winvm-display-accept.txt"
  return w("exec", "--", "powershell.exe", "-NoProfile", "-Command", value === undefined
    ? `[IO.File]::ReadAllText('${path}')`
    : `[IO.File]::WriteAllText('${path}', '${value}')`).trim()
}

console.log(`disposable WINVM_HOME=${state}`)
try {
  const image = resolve(state, "images", "win11-arm64")
  mkdirSync(image, { recursive: true })
  const cloned = spawnSync("cp", ["-cp", resolve(source, "base.qcow2"), resolve(image, "base.qcow2")], { stdio: "inherit" })
  check(cloned.status === 0, "APFS base clone failed")
  chmodSync(resolve(image, "base.qcow2"), 0o444)
  copyFileSync(resolve(source, "image.json"), resolve(image, "image.json"))
  ensureInstance(name, "win11-arm64")
  w("display", "1920x1080")
  w("start", "--no-autosave", "--no-watch")
  w("display", "1920x1080")
  check(screenshot("before") === "1920x1080", "guest did not adopt the capture resolution")

  for (const format of ["zstd", "mapped"] as const) {
    const token = randomUUID()
    marker(token)
    w("save", format, "--format", format)
    const saved = readSave(name, format)
    check(JSON.stringify(saved?.display) === JSON.stringify(sizeA), "capture recorded the wrong display")
    marker("changed-after-save")
    w("display", "2560x1440")
    const listing = JSON.parse(w("saves", "--json")) as { name: string; compatible: boolean | null }[]
    check(listing.find((row) => row.name === format)?.compatible === true, "listing disagrees with restore")
    w("load", format, "--no-watch")
    check(JSON.stringify(readDisplay(p)) === JSON.stringify(sizeB), "restore overwrote the preference")
    const display = w("display")
    check(display.includes("running:    virtio-gpu 1920x1080"), "restore launched the wrong display")
    const status = JSON.parse(w("status", "--json")) as { screen: string }
    check(status.screen === "virtio-gpu 1920x1080", "status/viewer reports the preference instead of the running display")
    check(marker() === token, "restore did not recover the saved disk contents")
    const nonce = randomUUID()
    check(w("exec", "--", "cmd.exe", "/c", "echo", nonce).trim() === nonce, "restored guest did not answer a fresh nonce")
    check(Math.abs((await measureOffset(p)).offsetMs) < 5000, "restored guest clock differs by more than five seconds")
    check(screenshot(format) === "1920x1080", "restored framebuffer has the wrong dimensions")
    w("save", "again", "--format", format)
    check(readSave(name, "again")?.compat === saved?.compat, "post-restore capture hashed the pending preference")
    if (format === "mapped") {
      w("stop")
      w("destroy", "--keep-saves")
      w("load", format, "--no-watch")
      check(screenshot("recreated") === "1920x1080", "retained save lost its display after recreation")
      check(marker() === token, "recreated instance lost the saved disk contents")
    }
  }
  passed = true
  console.log("PASS: saved-display zstd/mapped restore, provenance, nonce, disk, clock, screenshot and recreation")
} finally {
  await quitQemu(p)
  stopService(p)
  if (passed) rmSync(state, { recursive: true, force: true })
  else console.error(`acceptance failed; stopped disposable VM retained at ${state}`)
}
