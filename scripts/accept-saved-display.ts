#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { resolve } from "node:path"

import { exitOnSignals, finish, once, runtimePin, socketPathProblem, type TerminationSignal } from "./accept-saved-display-lib.ts"

const source = process.argv[2]
if (source === undefined || !existsSync(resolve(source, "base.qcow2")) || !existsSync(resolve(source, "image.json"))) {
  console.error("usage: bun scripts/accept-saved-display.ts /path/to/immutable/image-directory   (base.qcow2 and image.json)")
  process.exit(2)
}

function refuse(message: string): never {
  console.error(`::error::${message}`)
  process.exit(2)
}

const runtime = await import("@winvm/core/runtime")
const found = runtime.findRuntime()
if (found === null) refuse("winvm's runtime is not installed: run `winvm setup`, or set WINVM_RUNTIME or WINVM_RUNTIME_CACHE")
Object.assign(process.env, runtimePin(process.env, runtime.runtimeCache()))

const state = mkdtempSync("/tmp/wd-")
process.env["WINVM_HOME"] = resolve(state, "home")
process.env["XDG_CONFIG_HOME"] = resolve(state, "xdg-config")
process.env["XDG_DATA_HOME"] = resolve(state, "xdg-data")

const { measureOffset } = await import("@winvm/core/clock")
const { RAMFB, VIRTIO_GPU, describeDisplay, displayPath, readDisplay } = await import("@winvm/core/display")
type DisplayConfig = import("@winvm/core/display").DisplayConfig
const { ensureInstance } = await import("@winvm/core/instance")
const { pathsFor } = await import("@winvm/core/paths")
const { stopSidecars } = await import("@winvm/core/qemu")
const { quitQemu, readSave } = await import("@winvm/core/saves")
const { stopService } = await import("@winvm/core/servicectl")
const { virtiofsdSocket } = await import("@winvm/core/share")

const name = "accept-display"
const imageName = "win11-arm64"
const cli = resolve(import.meta.dir, "../apps/cli/src/winvm.ts")
const p = pathsFor(name)
const MARKER = "C:\\Windows\\Temp\\winvm-display-accept.txt"

if (runtime.findRuntime()?.dir !== found.dir) {
  rmSync(state, { recursive: true, force: true })
  refuse("winvm's runtime is no longer found once XDG_DATA_HOME is redirected; set WINVM_RUNTIME")
}
const socketProblem = socketPathProblem([p.qga, p.qmp, p.qgaQemu, p.qmpQemu, p.control, p.tpmSock, virtiofsdSocket(p)])
if (socketProblem !== null) {
  rmSync(state, { recursive: true, force: true })
  refuse(socketProblem)
}

let passed = false
let interrupted = null as TerminationSignal | null
let child: ChildProcess | null = null
let stopped = false

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message)
}
function pass(message: string): void {
  console.log(`PASS ${message}`)
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function w(verb: string, ...args: string[]): Promise<string> {
  if (interrupted !== null) throw new Error(`interrupted by ${interrupted}`)
  const argv = [cli, verb, "-i", name, ...args]
  const done = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const proc = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] })
    child = proc
    let stdout = ""
    let stderr = ""
    proc.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d))
    proc.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d))
    const timer = setTimeout(() => proc.kill("SIGKILL"), 900_000)
    proc.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    proc.once("close", (status) => {
      clearTimeout(timer)
      child = null
      resolveRun({ status, stdout, stderr })
    })
  })
  console.log(`$ winvm ${verb} -i ${name} ${args.join(" ")}\n${done.stdout}${done.stderr}`)
  check(done.status === 0, `${verb} ${args.join(" ")} exited ${String(done.status)}`)
  return done.stdout
}

async function runningDevice(): Promise<string | null> {
  const shown = JSON.parse(await w("display", "--json")) as { running: string | null }
  return shown.running
}

async function marker(value?: string): Promise<string> {
  return (
    await w(
      "exec",
      "--",
      "powershell.exe",
      "-NoProfile",
      "-Command",
      value === undefined ? `[IO.File]::ReadAllText('${MARKER}')` : `[IO.File]::WriteAllText('${MARKER}', '${value}')`,
    )
  ).trim()
}

async function screenshot(label: string): Promise<string> {
  const file = resolve(state, `${label}.png`)
  await w("screenshot", file)
  const png = readFileSync(file)
  check(png.length > 0 && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", `${label}: screenshot is not a PNG`)
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)]
  check(width > 0 && height > 0, `${label}: screenshot has no pixels`)
  return `${String(width)}x${String(height)}`
}

const preferenceFile = (): string => readFileSync(displayPath(p), "utf8")

async function verifyRestored(save: string, token: string, running: DisplayConfig, preference: DisplayConfig, preferenceBytes: string): Promise<void> {
  check(preferenceFile() === preferenceBytes && same(readDisplay(p), preference), `${save}: loading rewrote the display preference`)
  pass(`${save}: preference unchanged (${preference.device})`)

  const display = JSON.parse(await w("display", "--json")) as { configured: string; running: string | null }
  check(display.configured === preference.device, `${save}: display reports configured ${display.configured}`)
  check(display.running === running.device, `${save}: display reports running ${String(display.running)}, not ${running.device}`)
  const status = JSON.parse(await w("status", "--json")) as { screen: string | null }
  check(status.screen === describeDisplay(running), `${save}: status reports ${String(status.screen)}, not the running ${running.device}`)
  pass(`${save}: running device ${running.device} (display and status)`)

  check((await marker()) === token, `${save}: restore did not recover the saved disk contents`)
  pass(`${save}: disk marker`)
  const nonce = randomUUID()
  check((await w("exec", "--", "cmd.exe", "/c", "echo", nonce)).trim() === nonce, `${save}: restored guest did not answer a fresh command nonce`)
  pass(`${save}: fresh command nonce`)
  const offset = (await measureOffset(p)).offsetMs
  check(Math.abs(offset) < 5000, `${save}: guest clock is ${String(offset)} ms from the host`)
  pass(`${save}: guest clock within 5 s (${String(offset)} ms)`)
  pass(`${save}: screenshot ${await screenshot(save)}`)
}

async function direction(a: DisplayConfig, b: DisplayConfig, recreate: boolean): Promise<void> {
  const tag = `${a.device}-to-${b.device}`
  console.log(`\n== ${tag}: saves taken on ${a.device}, preference switched to ${b.device} ==`)
  await w("start", "--no-autosave", "--no-watch")
  check((await runningDevice()) === a.device, `${tag}: cold boot did not run ${a.device}`)

  const saved = new Map<string, { token: string; compat: string }>()
  for (const format of ["zstd", "mapped"] as const) {
    const save = `${tag}-${format}`
    const token = randomUUID()
    await marker(token)
    await w("save", save, "--format", format)
    const m = readSave(name, save)
    if (m === null || m.display === undefined || !same(m.display, a)) {
      throw new Error(`${save}: manifest recorded ${JSON.stringify(m?.display)}, not ${a.device}`)
    }
    pass(`${save}: manifest display ${a.device}`)
    saved.set(save, { token, compat: m.compat })
    await marker("changed-after-save")
  }

  await w("stop")
  await w("display", b.device)
  const preferenceBytes = preferenceFile()
  check(same(readDisplay(p), b), `${tag}: could not switch the preference to ${b.device}`)
  const listing = JSON.parse(await w("saves", "--json")) as { name: string; compatible: boolean | null }[]
  for (const save of saved.keys()) {
    check(listing.find((row) => row.name === save)?.compatible === true, `${save}: saves --json disagrees with restore under ${b.device}`)
  }
  pass(`${tag}: both saves listed compatible under the other preference`)

  for (const [save, { token, compat }] of saved) {
    await w("load", save, "--no-watch")
    await verifyRestored(save, token, a, b, preferenceBytes)
    const again = `${save}-again`
    await w("save", again, "--format", save.endsWith("mapped") ? "mapped" : "zstd")
    const m = readSave(name, again)
    check(m !== null && same(m.display, a) && m.compat === compat, `${again}: post-restore save did not record and hash ${a.device} again`)
    pass(`${again}: post-restore save records and hashes ${a.device}`)
  }

  if (!recreate) return
  const save = `${tag}-mapped`
  const { token } = saved.get(save) ?? { token: "" }
  await w("stop")
  await w("destroy", "--keep-saves")
  check(readSave(name, save) !== null, `${save}: destroy --keep-saves did not keep the save`)
  await w("load", save, "--no-watch")
  check((await runningDevice()) === a.device, `${save}: recreated instance did not run the retained save's ${a.device}`)
  check((await marker()) === token, `${save}: recreated instance lost the saved disk contents`)
  pass(`${save}: retained save recreated the instance on ${a.device} (screenshot ${await screenshot(`${save}-recreated`)})`)
}

const cleanup = once(async (): Promise<void> => {
  const proc: ChildProcess | null = child
  proc?.kill("SIGKILL")
  let ok = true
  try {
    await quitQemu(p)
  } catch (error) {
    ok = false
    console.error(`could not quit the disposable QEMU: ${String(error)}`)
  }
  try {
    stopSidecars(p)
    stopService(p)
  } catch (error) {
    ok = false
    console.error(`could not stop the disposable sidecars: ${String(error)}`)
  }
  stopped = ok
  if (finish({ passed, interrupted, stopped: ok }).removeRoot) rmSync(state, { recursive: true, force: true })
})

const retained = (): string =>
  `the disposable machine is kept at ${state} for diagnosis` +
  (stopped ? " (its processes are stopped)" : "; its processes may still be running: check `ps` for qemu, swtpm and virtiofsd using it")

exitOnSignals(process, {
  interrupted: (signal) => {
    interrupted = signal
    passed = false
  },
  cleanup,
  report: (signal) => { console.error(`interrupted by ${signal}; ${retained()}`) },
  exit: (code) => process.exit(code),
})

console.log(`disposable root: ${state}`)
try {
  const images = resolve(process.env["WINVM_HOME"] ?? "", "images", imageName)
  mkdirSync(images, { recursive: true })
  const cloned = spawnSync("cp", ["-c", resolve(source, "base.qcow2"), resolve(images, "base.qcow2")], { stdio: "inherit" })
  check(cloned.status === 0, "APFS clone of base.qcow2 failed (the image directory must be on the same APFS volume as /tmp)")
  chmodSync(resolve(images, "base.qcow2"), 0o444)
  copyFileSync(resolve(source, "image.json"), resolve(images, "image.json"))
  check(statSync(resolve(images, "base.qcow2")).size > 0, "cloned base image is empty")

  ensureInstance(name, imageName, VIRTIO_GPU)
  await direction(VIRTIO_GPU, RAMFB, false)

  await w("stop")
  check(same(readDisplay(p), RAMFB), "the preference should still be ramfb for the second direction")
  await direction(RAMFB, VIRTIO_GPU, true)

  check(interrupted === null, `interrupted by ${String(interrupted)}`)
  passed = true
  console.log("\nPASS saved-display acceptance: zstd and mapped capture, restore, provenance, preference, status, disk, nonce, clock, screenshot, post-restore save, recreation")
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await cleanup()
  const end = finish({ passed, interrupted, stopped })
  if (passed && !end.passed) console.error("every check passed, but the disposable processes could not all be confirmed stopped")
  passed = end.passed
  if (!passed) console.error(`acceptance failed; ${retained()}`)
}
process.exit(finish({ passed, interrupted, stopped }).exitCode)
