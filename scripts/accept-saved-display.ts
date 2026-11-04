#!/usr/bin/env bun
/**
 * Disposable acceptance run for saved-display restore, against a real guest.
 *
 *   bun scripts/accept-saved-display.ts /path/to/immutable/image-directory
 *
 * The image directory must hold `base.qcow2` and `image.json` and must NOT be
 * an instance anyone is using: it is APFS-cloned (never opened for writing)
 * into a fresh temporary WINVM_HOME, so a run never reads or changes the
 * person's own machines, saves or settings. The temporary home is removed when
 * the run passes and kept, with its VM stopped, when it fails.
 *
 * What it proves, for zstd and mapped-ram saves, in both directions between
 * the two display devices (a save taken on A, the cold-boot preference then
 * set to B, the save loaded):
 *
 *   - the manifest records the running display profile (A);
 *   - `saves --json` calls the save compatible while the preference is B;
 *   - loading leaves the preference (display.json) byte-for-byte B;
 *   - `display --json` and `status --json` report the running device A;
 *   - the disk holds the save's marker, and the guest answers a fresh nonce;
 *   - the guest clock is within five seconds of the host's;
 *   - a screenshot is a nonempty PNG;
 *   - a save made after the restore records and hashes A again;
 *   - a retained save recreates a destroyed instance on its own display.
 *
 * Needs the built runtime (qemu, virtiofsd) the CLI normally uses, and tens of
 * minutes for the cold boots. Not part of `pnpm check`.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const source = process.argv[2]
if (source === undefined || !existsSync(resolve(source, "base.qcow2")) || !existsSync(resolve(source, "image.json"))) {
  console.error("usage: bun scripts/accept-saved-display.ts /path/to/immutable/image-directory   (base.qcow2 and image.json)")
  process.exit(2)
}

// Everything the run touches lives under one temporary root. Set before the
// winvm modules are loaded: they read these when asked for a path.
const state = mkdtempSync(resolve(tmpdir(), "winvm-display-"))
process.env["WINVM_HOME"] = resolve(state, "home")
process.env["XDG_CONFIG_HOME"] = resolve(state, "xdg-config")
process.env["XDG_DATA_HOME"] = resolve(state, "xdg-data")

const { measureOffset } = await import("../packages/core/src/clock")
const { RAMFB, VIRTIO_GPU, describeDisplay, displayPath, readDisplay } = await import("../packages/core/src/display")
type DisplayConfig = import("../packages/core/src/display").DisplayConfig
const { ensureInstance } = await import("../packages/core/src/instance")
const { pathsFor } = await import("../packages/core/src/paths")
const { stopSidecars } = await import("../packages/core/src/qemu")
const { quitQemu, readSave } = await import("../packages/core/src/saves")
const { stopService } = await import("../packages/core/src/service")

const name = "accept-display"
const imageName = "win11-arm64"
const cli = resolve(import.meta.dir, "../apps/cli/src/winvm.ts")
const p = pathsFor(name)
const MARKER = "C:\\Windows\\Temp\\winvm-display-accept.txt"
let passed = false

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message)
}
function pass(message: string): void {
  console.log(`PASS ${message}`)
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** One CLI verb against the disposable instance; throws unless it exits 0. */
function w(verb: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [cli, verb, "-i", name, ...args], { encoding: "utf8", timeout: 900_000 })
  console.log(`$ winvm ${verb} -i ${name} ${args.join(" ")}\n${r.stdout}${r.stderr}`)
  if (r.error !== undefined) throw r.error
  check(r.status === 0, `${verb} ${args.join(" ")} exited ${String(r.status)}`)
  return r.stdout
}

function marker(value?: string): string {
  return w(
    "exec",
    "--",
    "powershell.exe",
    "-NoProfile",
    "-Command",
    value === undefined ? `[IO.File]::ReadAllText('${MARKER}')` : `[IO.File]::WriteAllText('${MARKER}', '${value}')`,
  ).trim()
}

function screenshot(label: string): string {
  const file = resolve(state, `${label}.png`)
  w("screenshot", file)
  const png = readFileSync(file)
  check(png.length > 0 && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", `${label}: screenshot is not a PNG`)
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)]
  check(width > 0 && height > 0, `${label}: screenshot has no pixels`)
  return `${String(width)}x${String(height)}`
}

const preferenceFile = (): string => readFileSync(displayPath(p), "utf8")

/** Everything that must hold once `save` has been loaded and the guest is up on `running` while the preference is `preference`. */
async function verifyRestored(save: string, token: string, running: DisplayConfig, preference: DisplayConfig, preferenceBytes: string): Promise<void> {
  check(preferenceFile() === preferenceBytes && same(readDisplay(p), preference), `${save}: loading rewrote the display preference`)
  pass(`${save}: preference unchanged (${preference.device})`)

  const display = JSON.parse(w("display", "--json")) as { configured: string; running: string | null }
  check(display.configured === preference.device, `${save}: display reports configured ${display.configured}`)
  check(display.running === running.device, `${save}: display reports running ${String(display.running)}, not ${running.device}`)
  const status = JSON.parse(w("status", "--json")) as { screen: string | null }
  check(status.screen === describeDisplay(running), `${save}: status reports ${String(status.screen)}, not the running ${running.device}`)
  pass(`${save}: running device ${running.device} (display and status)`)

  check(marker() === token, `${save}: restore did not recover the saved disk contents`)
  pass(`${save}: disk marker`)
  const nonce = randomUUID()
  check(w("exec", "--", "cmd.exe", "/c", "echo", nonce).trim() === nonce, `${save}: restored guest did not answer a fresh command nonce`)
  pass(`${save}: fresh command nonce`)
  const offset = (await measureOffset(p)).offsetMs
  check(Math.abs(offset) < 5000, `${save}: guest clock is ${String(offset)} ms from the host`)
  pass(`${save}: guest clock within 5 s (${String(offset)} ms)`)
  pass(`${save}: screenshot ${screenshot(save)}`)
}

/**
 * Boot on `a`, take a zstd and a mapped save, switch the preference to `b`
 * while stopped, then load each: the first into the stopped instance, the
 * second into the running one. `recreate` also destroys the instance (keeping
 * its saves) and loads the mapped save into the recreated one.
 */
async function direction(a: DisplayConfig, b: DisplayConfig, recreate: boolean): Promise<void> {
  const tag = `${a.device}-to-${b.device}`
  console.log(`\n== ${tag}: saves taken on ${a.device}, preference switched to ${b.device} ==`)
  w("start", "--no-autosave", "--no-watch")
  check(w("display", "--json").includes(`"running":"${a.device}"`), `${tag}: cold boot did not run ${a.device}`)

  const saved = new Map<string, { token: string; compat: string }>()
  for (const format of ["zstd", "mapped"] as const) {
    const save = `${tag}-${format}`
    const token = randomUUID()
    marker(token)
    w("save", save, "--format", format)
    const m = readSave(name, save)
    if (m === null || m.display === undefined || !same(m.display, a)) {
      throw new Error(`${save}: manifest recorded ${JSON.stringify(m?.display)}, not ${a.device}`)
    }
    pass(`${save}: manifest display ${a.device}`)
    saved.set(save, { token, compat: m.compat })
    marker("changed-after-save")
  }

  w("stop")
  w("display", b.device)
  const preferenceBytes = preferenceFile()
  check(same(readDisplay(p), b), `${tag}: could not switch the preference to ${b.device}`)
  const listing = JSON.parse(w("saves", "--json")) as { name: string; compatible: boolean | null }[]
  for (const save of saved.keys()) {
    check(listing.find((row) => row.name === save)?.compatible === true, `${save}: saves --json disagrees with restore under ${b.device}`)
  }
  pass(`${tag}: both saves listed compatible under the other preference`)

  for (const [save, { token, compat }] of saved) {
    w("load", save, "--no-watch")
    await verifyRestored(save, token, a, b, preferenceBytes)
    const again = `${save}-again`
    w("save", again, "--format", save.endsWith("mapped") ? "mapped" : "zstd")
    const m = readSave(name, again)
    check(m !== null && same(m.display, a) && m.compat === compat, `${again}: post-restore save did not record and hash ${a.device} again`)
    pass(`${again}: post-restore save records and hashes ${a.device}`)
  }

  if (!recreate) return
  const save = `${tag}-mapped`
  const { token } = saved.get(save) ?? { token: "" }
  w("stop")
  w("destroy", "--keep-saves")
  check(readSave(name, save) !== null, `${save}: destroy --keep-saves did not keep the save`)
  w("load", save, "--no-watch")
  check(w("display", "--json").includes(`"running":"${a.device}"`), `${save}: recreated instance did not run the retained save's ${a.device}`)
  check(marker() === token, `${save}: recreated instance lost the saved disk contents`)
  pass(`${save}: retained save recreated the instance on ${a.device} (screenshot ${screenshot(`${save}-recreated`)})`)
}

console.log(`disposable root: ${state}`)
try {
  const images = resolve(process.env["WINVM_HOME"] ?? "", "images", imageName)
  mkdirSync(images, { recursive: true })
  // An APFS clone: the immutable source is read, never written.
  const cloned = spawnSync("cp", ["-c", resolve(source, "base.qcow2"), resolve(images, "base.qcow2")], { stdio: "inherit" })
  check(cloned.status === 0, "APFS clone of base.qcow2 failed (the source must be on the same APFS volume as the temp directory)")
  chmodSync(resolve(images, "base.qcow2"), 0o444)
  copyFileSync(resolve(source, "image.json"), resolve(images, "image.json"))
  check(statSync(resolve(images, "base.qcow2")).size > 0, "cloned base image is empty")

  ensureInstance(name, imageName, VIRTIO_GPU)
  await direction(VIRTIO_GPU, RAMFB, false)

  // The instance now prefers ramfb: stop the restored guest and cold boot it there.
  w("stop")
  check(same(readDisplay(p), RAMFB), "the preference should still be ramfb for the second direction")
  await direction(RAMFB, VIRTIO_GPU, true)

  passed = true
  console.log("\nPASS saved-display acceptance: zstd and mapped capture, restore, provenance, preference, status, disk, nonce, clock, screenshot, post-restore save, recreation")
} finally {
  try {
    await quitQemu(p)
  } catch (error) {
    console.error(`could not quit the disposable QEMU: ${String(error)}`)
  }
  try {
    stopSidecars(p)
    stopService(p)
  } catch (error) {
    console.error(`could not stop the disposable sidecars: ${String(error)}`)
  }
  if (passed) rmSync(state, { recursive: true, force: true })
  else console.error(`acceptance failed; the stopped disposable machine is kept at ${state} for diagnosis`)
}
