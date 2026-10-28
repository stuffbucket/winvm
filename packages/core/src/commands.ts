/**
 * The verbs. Each one is short enough to read in full; anything that needed
 * more room lives in a sibling module.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Args } from "./args"
import { imageName, instanceName, isValidImageName, isValidInstanceName } from "./args"
import { PWSH_SHA256, PWSH_URL, TOOLS_SHA256, TOOLS_URL, checksReport, download, du, hostChecks, printChecks, requireHost, run, sha256Of } from "./host"
import { diagnose, formatFindings } from "./diagnose"
import { ensureInstance, makeVars, resetInstance, sealBase } from "./instance"
import { ISO_SOURCE, buildSeed, checkIsoIsArm64, makeResultVolume, readResult, resolveWindowsIso } from "./media"
import type { InstanceMeta } from "./paths"
import {
  allocateVnc,
  basePath,
  home,
  imageDir,
  imageMetaPath,
  instanceDir,
  listImages,
  listInstances,
  media,
  newImageMeta,
  mediaDir,
  pathsFor,
  readImageMeta,
  readMeta,
} from "./paths"
import * as agent from "./agent"
import * as agentcmds from "./agentcmds"
import * as input from "./input"
import * as qemu from "./qemu"
import * as qmp from "./qmp"
import * as qga from "./qga"
import * as saves from "./saves"
import * as savecmds from "./savecmds"
import * as snapshot from "./snapshot"
import * as timemachine from "./timemachine"
import { ensureService, readService, stopService } from "./service"
import { ensureRuntime, findRuntime, runtimeBin } from "./runtime"
import * as watcher from "./watch"
import { CONFIG_KEYS, DEFAULTS, effectiveConfig, parseAssignment, readOverrides, writeAssignments } from "./config"

/**
 * Whether this instance's image can boot on virtio-blk, which is what live
 * snapshots require. Images built before that change have no metadata and no
 * viostor boot-start driver, so they keep booting on NVMe rather than
 * bluescreening with INACCESSIBLE_BOOT_DEVICE.
 */
const virtioBootFor = (meta: InstanceMeta): boolean => readImageMeta(meta.image)?.virtioBoot === true

export function doctor(json = false): number {
  if (json) {
    const report = checksReport(hostChecks(), timemachine.summary())
    console.log(JSON.stringify(report, null, 2))
    return report.ready ? 0 : 1
  }
  const missing = printChecks(hostChecks())
  console.log(timemachine.summary())
  console.log(missing === 0 ? `\nhost is ready · state: ${home()}` : `\n${String(missing)} prerequisite(s) missing`)
  return missing === 0 ? 0 : 1
}

/** `ls --json`: the images an instance can be made from, and the instances, without sizes (du is slow). */
export function lsJson(): { images: { name: string; snapshots: boolean }[]; instances: { name: string; image: string | null; running: boolean }[] } {
  return {
    images: listImages().map((name) => ({ name, snapshots: readImageMeta(name)?.virtioBoot === true })),
    instances: listInstances().map((name) => ({ name, image: readMeta(name)?.image ?? null, running: qemu.isRunning(pathsFor(name)) })),
  }
}

export function ls(json = false): number {
  if (json) {
    console.log(JSON.stringify(lsJson()))
    return 0
  }
  console.log(`state: ${home()}\n`)
  const images = listImages()
  console.log(images.length === 0 ? "images: (none — run `winvm build`)" : "images:")
  for (const i of images) {
    const virtio = readImageMeta(i)?.virtioBoot === true ? "snapshots" : "no snapshots (pre-virtio)"
    console.log(`  ${i.padEnd(18)} ${du(basePath(i)).padEnd(7)} ${virtio}`)
  }

  const names = listInstances()
  console.log(names.length === 0 ? "\ninstances: (none)" : "\ninstances:")
  for (const n of names) {
    const m = readMeta(n)
    const p = pathsFor(n)
    const pid = qemu.pidOf(p)
    const state = pid === null ? "stopped" : `running (pid ${String(pid)})`
    console.log(
      `  ${n.padEnd(18)} ${du(p.overlay).padEnd(7)} image=${m?.image ?? "?"} vnc=:${String(m?.vnc)} ${state}`,
    )
  }

  // MEDIA USED TO BE INVISIBLE HERE, and it is not small: the guest-tools ISO is
  // ~121 MB and the seed is rebuilt every build. The Windows ISO is a symlink,
  // so its size is reported as the link's, not the ~8 GB it points at — say so
  // rather than appear to account for it.
  console.log("\nmedia:")
  const entries: readonly [string, string][] = [
    ["windows ISO", media.iso()],
    ["guest tools", media.tools()],
    ["PowerShell 7", media.pwsh()],
    ["seed ISO", media.seed()],
    ["seed contents", media.seedDir()],
  ]
  for (const [label, path] of entries) {
    if (!existsSync(path)) continue
    const note = label === "windows ISO" ? "  (symlink; the ISO itself is not counted)" : ""
    console.log(`  ${label.padEnd(18)} ${du(path).padEnd(7)}${note}`)
  }

  console.log(`\ntotal under ${home()}: ${du(home())}`)
  return 0
}

/**
 * Remove a base image. There was no way to do this: bases are sealed read-only,
 * so the only route was `rm -rf` by hand on a `chmod 444` file.
 */
export function rmi(args: Args): number {
  const image = args.positional[0] ?? imageName(args)
  if (!existsSync(basePath(image))) {
    console.error(`::error::no such image "${image}"`)
    return 1
  }
  // Overlays name their backing file absolutely; deleting it under a live
  // instance leaves a disk that cannot be opened and says nothing useful.
  const users = listInstances().filter((n) => readMeta(n)?.image === image)
  if (users.length > 0 && !args.flags.has("force")) {
    console.error(
      `::error::image "${image}" still backs ${users.length === 1 ? "instance" : "instances"} ${users.join(", ")} — ` +
        `destroy them first, or pass --force to remove it anyway`,
    )
    return 1
  }
  // Undo the seal before removing: the file is deliberately 444.
  run("chmod", ["-R", "u+w", imageDir(image)])
  rmSync(imageDir(image), { recursive: true, force: true })
  console.log(`removed image "${image}"`)
  return 0
}

/**
 * Reclaim what accumulates: scratch instances a build left behind, and the
 * cached media that can simply be fetched or rebuilt again.
 */
export function prune(args: Args): number {
  let freedAnything = false
  for (const name of listInstances().filter((n) => n.startsWith("build-"))) {
    const p = pathsFor(name)
    if (qemu.isRunning(p)) {
      console.log(`  keeping "${name}" — still running (pid ${String(qemu.pidOf(p))})`)
      continue
    }
    const size = du(p.dir)
    qemu.stopSwtpm(p)
    stopService(p)
    rmSync(p.dir, { recursive: true, force: true })
    saves.removeAllSaves(name)
    console.log(`  removed scratch instance "${name}" (${size})`)
    freedAnything = true
  }
  if (args.flags.has("media")) {
    // The tools ISO is re-downloaded and verified against its pin; the seed is
    // rebuilt from assets on every build. Neither is precious. The Windows ISO
    // is the user's own file and is only ever symlinked, so it is left alone.
    for (const path of [media.tools(), media.pwsh(), media.seed(), media.seedDir()]) {
      if (!existsSync(path)) continue
      const size = du(path)
      rmSync(path, { recursive: true, force: true })
      console.log(`  removed ${path} (${size})`)
      freedAnything = true
    }
  }
  if (!freedAnything) console.log("nothing to prune")
  else console.log(`\ntotal under ${home()}: ${du(home())}`)
  return 0
}

/**
 * Install what the host is missing. Deliberately a SEPARATE verb from `doctor`,
 * which stays a pure check — this repository's own preflight says it plainly:
 * "A check that silently mutates the environment is its own defect."
 */
export async function setup(args: Args): Promise<number> {
  try {
    const rt = await ensureRuntime()
    console.log(`runtime ${rt.manifest?.version ?? "?"} in ${rt.dir}`)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  // Fetch and verify the guest tools now, so the first build does not stop to do
  // it — and so a broken pin is found here rather than 20 minutes into an install.
  if (!args.flags.has("no-media")) {
    mkdirSync(mediaDir(), { recursive: true })
    try {
      download(TOOLS_URL, media.tools(), TOOLS_SHA256)
      download(PWSH_URL, media.pwsh(), PWSH_SHA256)
    } catch (error) {
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  console.log("")
  return doctor()
}

/**
 * Adopt an already-installed disk as a base image — how you avoid reinstalling
 * when a good guest already exists, and how a flat single-disk layout migrates
 * into base+overlay.
 */
export function adopt(args: Args): number {
  requireHost()
  const src = args.positional[0]
  if (src === undefined) {
    console.error("::error::usage: winvm adopt <disk.qcow2> [--image <name>]")
    return 1
  }
  const from = resolve(src)
  if (!existsSync(from)) {
    console.error(`::error::no such disk: ${from}`)
    return 1
  }
  const image = imageName(args)
  if (!isValidImageName(image)) {
    console.error(`::error::invalid image name "${image}" — letters, digits, ".", "_" and "-" only`)
    return 1
  }
  if (existsSync(basePath(image))) {
    console.error(`::error::image "${image}" already exists at ${basePath(image)}`)
    return 1
  }
  mkdirSync(imageDir(image), { recursive: true })
  // Rename rather than copy: these files are tens of GB, and a copy would need
  // the space twice over.
  if (run("mv", [from, basePath(image)]) !== 0) return 1
  sealBase(image)
  console.log(`adopted as image "${image}" (${du(basePath(image))}), now read-only`)
  return 0
}

export async function build(args: Args): Promise<number> {
  requireHost()
  const image = imageName(args)
  if (!isValidImageName(image)) {
    console.error(`::error::invalid image name "${image}" — letters, digits, ".", "_" and "-" only`)
    return 1
  }
  if (existsSync(basePath(image))) {
    console.error(`::error::image "${image}" already exists — use --image <other>, or remove it deliberately`)
    return 1
  }
  // AN INSTANCE THAT NAMES THIS IMAGE PINS IT, EVEN IF ITS BASE IS GONE. Its
  // overlay records the base by absolute path, so a fresh build at that path
  // would silently become the backing file of an overlay written against a
  // different disk — a corrupt instance that still boots far enough to mislead.
  const dependents = listInstances().filter((n) => n !== `build-${image}` && readMeta(n)?.image === image)
  if (dependents.length > 0) {
    console.error(
      `::error::instances ${dependents.join(", ")} name image "${image}" — build under another --image name`,
    )
    return 1
  }

  // Build in a scratch instance so a failed install cannot leave a half-made
  // base image that later runs would happily use.
  const scratch = `build-${image}`
  const p = pathsFor(scratch)

  // A BUILD THAT ENDED BADLY VERY LIKELY LEFT ITS GUEST RUNNING. `launch`
  // detaches, so Ctrl-C kills this script and nothing else; the hour-long
  // timeout used to return without reaping either. Recreating the overlay under
  // a live QEMU corrupts it, and a second QEMU sharing this instance's pidfile,
  // sockets and TPM state stalls with no error anywhere. Refuse, and say how out.
  //
  // CHECKED BEFORE ANY MEDIA IS TOUCHED, because buildSeed rewrites the SHARED
  // seed ISO — which a build already in flight has attached as a CD.
  if (qemu.isRunning(p)) {
    console.error(
      `::error::a build of "${image}" is already running (pid ${String(qemu.pidOf(p))}) — ` +
        `\`winvm kill -i ${scratch}\` if it is stuck`,
    )
    return 1
  }

  mkdirSync(mediaDir(), { recursive: true })
  // Resolved from a flag, an env var, whatever a previous build recorded, the
  // obvious folders, or a prompt — see resolveWindowsIso. None of that is ever
  // written into the repository.
  const iso = resolveWindowsIso(args.flags.get("iso"))
  if (iso === null) {
    console.error(`::error::pass a Windows 11 ARM64 ISO: winvm build --iso <path>, or set WINVM_ISO\n${ISO_SOURCE}`)
    return 1
  }
  // Checked BEFORE the install, because the alternative is finding out twelve
  // minutes in that this was the x64 ISO.
  if (!checkIsoIsArm64(iso)) return 1
  console.log("checksumming the ISO (it is read, never changed)")
  const isoSha256 = sha256Of(iso)
  if (resolve(iso) !== resolve(media.iso())) {
    // Symlinked, never copied: ~8 GB, and it belongs to the user.
    rmSync(media.iso(), { force: true })
    run("ln", ["-s", iso, media.iso()])
  }

  download(TOOLS_URL, media.tools(), TOOLS_SHA256)
  download(PWSH_URL, media.pwsh(), PWSH_SHA256)
  buildSeed(args.flags.get("payload"), args.flags.get("bun"))

  // Start from nothing. Anything kept from a failed build is a way for this one
  // to behave like that one: the result volume carries the answer file and the
  // provisioning scripts (so an edited asset would not reach the guest, and the
  // old transcript would be read as this run's), and TPM state and firmware
  // variables persist outside the disk image.
  stopService(p)
  rmSync(p.dir, { recursive: true, force: true })
  mkdirSync(p.tpmDir, { recursive: true })
  run(runtimeBin("qemu-img"), ["create", "-f", "qcow2", p.overlay, "64G"])
  // The scratch virtio-blk disk. Tiny and never read: its only job is to be a
  // virtio-blk device, so PnP installs viostor and marks it boot-start, which is
  // what lets the finished image run (and therefore snapshot) on virtio-blk.
  run(runtimeBin("qemu-img"), ["create", "-f", "qcow2", p.prime, "64M"])
  makeVars(p.vars)
  makeResultVolume(p.result)
  const meta: InstanceMeta = { image, vnc: allocateVnc(), created: new Date().toISOString() }
  writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`)

  // Never leave a guest behind. Without this an interrupted build keeps a VM
  // running invisibly — still writing to a disk this process has stopped
  // watching — and the next build collides with it.
  const reap = (): void => {
    const pid = qemu.pidOf(p)
    if (pid !== null) process.kill(pid, "SIGKILL")
    qemu.stopSwtpm(p)
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      reap()
      console.error(`\n::error::build interrupted — guest killed, scratch instance "${scratch}" kept`)
      process.exit(1)
    })
  }

  console.log(`installing Windows (unattended, ~20 min) · watch: winvm open -i ${scratch}`)
  try {
    // Installs on NVMe — WinPE has no virtio-blk driver. See qemuArgs.
    await qemu.launch(scratch, p, meta, { installMedia: true, ephemeral: false, virtioBoot: false })
  } catch (error) {
    qemu.stopSwtpm(p)
    console.error(`::error::could not start the installer VM: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  // ANSWER "Press any key to boot from CD or DVD" — ONCE THE FIRMWARE SAYS SO,
  // AND ONLY WHILE IT IS STILL ON SCREEN.
  //
  // Two rules, both learned the hard way:
  //
  //   1. Wait for the EVENT. startup.nsh prints `winvm-keypress-needed` on the
  //      firmware console immediately before launching the only boot image that
  //      asks for a key. That is a causal signal; a timer is not. The prompt
  //      itself is drawn on the graphical console and never reaches serial, so
  //      this handshake is the only thing serial has to observe.
  //
  //   2. Never send a key the prompt will not take. Surplus keystrokes are not
  //      discarded once Windows is booting — they queue and are delivered to
  //      Windows Setup's GUI, where Enter activates Support and Cancel and the
  //      install quits. Holding Enter until the disk grew sent ~250 of them; a
  //      fixed five over ten seconds still failed ~2 builds in 3, because Setup
  //      was up before the fifth. answerBootPrompt watches the prompt itself and
  //      stops for good the moment it takes a key.
  //
  // Later reboots need no keyboard at all: startup.nsh finds Windows Boot
  // Manager on the ESP by then and prefers it over the installer.
  const installerWriting = (): boolean => {
    try {
      return statSync(p.overlay).size > 300_000_000
    } catch {
      return false
    }
  }
  void (async () => {
    if (!(await qemu.waitForSerial(p, "winvm-keypress-needed", 10 * 60_000))) {
      console.warn("warning: the firmware never asked for a keypress; the install may stall at the boot prompt")
      return
    }
    const { keys, answered } = await qmp.answerBootPrompt(p.qmp, resolve(p.dir, "boot-prompt.ppm"))
    if (answered) console.log(`boot prompt answered (${String(keys)} key${keys === 1 ? "" : "s"})`)
    else console.warn(`warning: the boot prompt was not seen to take a key (${String(keys)} sent)`)
    // Confirm the keys did their job, so a prompt that went unanswered is named
    // now rather than surfacing an hour later as a bare timeout.
    for (let waited = 0; waited < 300_000; waited += 5000) {
      if (installerWriting()) return
      await new Promise((r) => setTimeout(r, 5000))
    }
    console.error("::error::the installer never started writing — the boot prompt appears to have gone unanswered")
  })().catch((error: unknown) => {
    console.warn(`warning: could not answer the boot prompt: ${error instanceof Error ? error.message : String(error)}`)
  })

  // THE HOST SHUTS THE GUEST DOWN; THE GUEST NO LONGER SHUTS ITSELF DOWN.
  //
  // provision.ps1 used to end in `Stop-Computer -Force`, which let this loop
  // treat "QEMU exited" as "the install finished". Microsoft is explicit that
  // terminating the machine from a Setup script is unsafe — "You should not
  // reboot the system by adding a command such as shutdown -r. This will put
  // the system in a bad state" — and the signal was ambiguous anyway: a crash,
  // a `winvm kill` and a successful provision all end with QEMU gone.
  //
  // Now the sequence says what it means. Wait for the agent (provisioning is
  // what installs it), wait for provisioning to declare itself finished, ask the
  // guest what it is, then shut it down in an orderly way.
  const guestFailed = (why: string): number => {
    console.error(`::error::${why}`)
    reap()
    const result = readResult(p.result)
    for (const line of result.log.trimEnd().split("\n").slice(-20)) {
      if (line.trim() !== "") console.error(`  | ${line}`)
    }
    // Run the post-mortem HERE rather than leaving it for someone to think of.
    // The artifacts are at their most informative right now, and every failure
    // this has ever had looked identical from the outside.
    const findings = diagnose(scratch)
    if (findings.length > 0) console.error(`\n${formatFindings(scratch, findings)}\n`)
    console.error(
      `  firmware log: ${p.serial}\n` +
        `  scratch instance "${scratch}" kept for inspection — \`winvm destroy -i ${scratch}\` when done`,
    )
    return 1
  }

  // The agent only exists once the guest tools are installed, which is most of
  // the way through provisioning — so this doubles as progress.
  if (!(await qga.waitFor(p.qga, 45 * 60_000))) {
    return guestFailed("the guest agent never came up, so provisioning did not get far enough to install it")
  }

  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  // TOLERATES THE AGENT DISAPPEARING, because it will. Provisioning installs
  // vioserial — the driver underneath the very channel this speaks over — so the
  // agent drops and returns mid-run. An unguarded call here throws right at the
  // moment provisioning is doing its job, and the whole build dies reporting a
  // timeout while the install underneath it was perfectly healthy.
  const ask = async (command: string): Promise<string | null> => {
    try {
      return (await qga.exec(p.qga, ps, ["-NoProfile", "-Command", command])).stdout.trim()
    } catch {
      return null
    }
  }

  // provision.ps1 writes its marker last, immediately before reporting success.
  // An hour, not half: it now also drains the .NET native-image queue, which is
  // minutes of compilation per framework under emulation.
  const provisionDeadline = Date.now() + 60 * 60_000
  let provisioned = false
  while (Date.now() < provisionDeadline) {
    if ((await ask("Test-Path C:\\winvm-provisioned.txt")) === "True") {
      provisioned = true
      break
    }
    await new Promise((r) => setTimeout(r, 10_000))
  }
  if (!provisioned) return guestFailed("provisioning never reported that it finished")

  // Asked of the guest directly rather than read off a file it wrote earlier:
  // this is the property that decides whether instances may boot on virtio-blk,
  // and it is cheap to be certain about.
  // Retried, because `ask` returns null on a transient agent dropout and a null
  // here would quietly stamp the image as snapshot-incapable for the rest of its
  // life. A wrong answer is much more expensive than another round trip.
  let virtioAnswer: string | null = null
  for (let attempt = 0; attempt < 5 && virtioAnswer === null; attempt += 1) {
    virtioAnswer = await ask(
      "$s = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\viostor' -ErrorAction SilentlyContinue; " +
        "if ($s -and $s.Start -eq 0) { 'yes' } else { 'no' }",
    )
    if (virtioAnswer === null) await new Promise((r) => setTimeout(r, 5000))
  }
  const virtioBoot = virtioAnswer === "yes"

  console.log("provisioning finished; shutting the guest down")
  await qga.shutdown(p.qga)
  const stopDeadline = Date.now() + 10 * 60_000
  while (Date.now() < stopDeadline) {
    if (!qemu.isRunning(p)) {
      // Checked AGAIN at the end: a build takes half an hour, and another one
      // (or an `adopt`) may have claimed the name meanwhile. Never replace a
      // base image that overlays may already reference.
      if (existsSync(basePath(image))) {
        console.error(
          `::error::image "${image}" appeared while this build ran; not replacing it. ` +
            `The new disk is kept at ${p.overlay}`,
        )
        return 1
      }
      mkdirSync(imageDir(image), { recursive: true })
      if (run("mv", ["-n", p.overlay, basePath(image)]) !== 0 || existsSync(p.overlay)) {
        console.error(`::error::could not move the new disk into place; it is kept at ${p.overlay}`)
        return 1
      }
      sealBase(image)
      // Recorded because it cannot be read back off a disk image later.
      const imageMeta = newImageMeta({
        virtioBoot,
        created: new Date().toISOString(),
        runtime: findRuntime()?.manifest?.version ?? "override",
        isoSha256,
        guestToolsSha256: TOOLS_SHA256,
      })
      writeFileSync(imageMetaPath(image), `${JSON.stringify(imageMeta, null, 2)}\n`)
      qemu.stopSwtpm(p)
      stopService(p)
      rmSync(p.dir, { recursive: true, force: true })
      console.log(`base image ready: ${basePath(image)} (${du(basePath(image))})`)
      console.log(
        virtioBoot
          ? "snapshots: available (`winvm snapshot` / `winvm rewind`)"
          : "snapshots: UNAVAILABLE — viostor did not come out boot-start, so this image boots on NVMe",
      )
      console.log("next: winvm start")
      return 0
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  // guestFailed reaps before it reports: leaving the guest running is what
  // poisons the next build.
  return guestFailed("the guest did not shut down after provisioning")
}

/** How long `start` lets an answering guest sit with no one logged on before giving up. */
const NO_LOGON_MS = 120_000

/**
 * `winvm create [-i name] [--image NAME]`: a new instance from an image,
 * not started (`start` creates one too, and boots it). Refuses a name that
 * is taken or not a plain name (isValidInstanceName).
 */
export function create(args: Args): number {
  requireHost()
  const name = instanceName(args)
  if (!isValidInstanceName(name)) {
    console.error(`::error::"${name}" is not a name winvm takes: letters, digits, ".", "-" and "_", starting with a letter or digit, up to 64`)
    return 1
  }
  if (readMeta(name) !== null) {
    console.error(`::error::instance "${name}" already exists`)
    return 1
  }
  const image = imageName(args)
  ensureInstance(name, image)
  savecmds.markPristine(name)
  console.log(`\`winvm start -i ${name}\` boots it`)
  return 0
}

export async function start(args: Args): Promise<number> {
  requireHost()
  const name = instanceName(args)
  const p = pathsFor(name)
  if (qemu.isRunning(p)) {
    console.log(`instance "${name}" already running`)
    if (existsSync(p.qmpQemu) && readService(p) === null) await ensureService(name, p)
    watcher.startWatcherFor(name, args)
    return 0
  }
  // A stow save present: recall it (seconds) instead of booting.
  const recalled = await savecmds.recallStow(name, args)
  if (recalled === 0) watcher.startWatcherFor(name, args)
  if (recalled !== null) return recalled
  const isNew = readMeta(name) === null
  if (isNew && !isValidInstanceName(name)) {
    console.error(`::error::"${name}" is not a name winvm takes: letters, digits, ".", "-" and "_", starting with a letter or digit, up to 64`)
    return 1
  }
  ensureInstance(name, imageName(args))
  if (isNew) savecmds.markPristine(name)
  const meta = readMeta(name)
  if (meta === null) return 1

  const virtioBoot = virtioBootFor(meta)
  try {
    await qemu.launch(name, p, meta, {
      installMedia: false,
      ephemeral: args.flags.has("ephemeral"),
      virtioBoot,
    })
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  process.stdout.write("booting")
  // READY, NOT MERELY ANSWERING. `guest-ping` succeeds while the screen still
  // reads "Just a moment..."; anything issued then races the rest of the boot.
  //
  // NOT TEN MINUTES AT A SIGN-IN SCREEN. A guest that answers but has had no
  // one logged on for NO_LOGON_MS will not get there by itself (an interrupted
  // audit-mode logon is repaired on the way, see qga.repairAudit), so say so,
  // with the screen to look at.
  const ready = await qga.untilReady(p.qga, 600_000, {
    noLogonMs: NO_LOGON_MS,
    log: (line) => process.stdout.write(`\n${line}\n`),
  })
  process.stdout.write("\n")
  if (ready === "no-logon") {
    const file = resolve(p.dir, "screenshots", `${new Date().toISOString().replace(/[:]/g, "").replace(/\..*$/, "").replace("T", "-")}-no-logon.png`)
    const shot = await input.screenshot(p, file).then(
      () => file,
      () => null,
    )
    console.error(
      `::error::the guest is up but no one logged on in ${String(NO_LOGON_MS / 1000)} s — it is most likely at the sign-in screen. ` +
        (shot === null ? `Look at it with \`winvm screenshot -i ${name}\`` : `Screen: ${shot}`),
    )
    return 1
  }
  if (ready !== "ready") {
    console.error(
      `::error::guest never became ready. Look at it with \`winvm open -i ${name}\` or ${p.serial}`,
    )
    return 1
  }
  console.log(`instance "${name}" up (vnc :${String(readMeta(name)?.vnc ?? meta.vnc)})`)
  // Clock and time zone; and on an instance's first boot, the automatic
  // "baseline" save (--no-autosave skips it).
  //
  // THE BASELINE IS TAKEN ONLY HERE, AFTER waitReady, and must stay so. An
  // automatic snapshot on first boot was tried before waitReady existed and
  // was a mistake in two ways: it froze the guest at whatever point boot had
  // reached, so it captured a machine still starting; and doing that to a
  // half-booted Windows LIVELOCKED it — four vCPUs at 100%, no disk I/O, no
  // recovery. Gated on the real account having logged on, it is safe.
  await savecmds.afterBoot(name, args)
  // AFTER the baseline save, so the watcher's idle clock starts from a guest at
  // rest and the baseline's own work is not counted as use.
  watcher.startWatcherFor(name, args)
  return 0
}

/** Capture the running guest, RAM and all. */
export async function snap(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  const meta = readMeta(name)
  if (meta === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running — a snapshot captures a LIVE guest`)
    return 1
  }
  if (!virtioBootFor(meta)) {
    console.error(
      `::error::image "${meta.image}" predates virtio boot, so its guest runs on NVMe — a device QEMU ` +
        "cannot snapshot. Rebuild the image (`winvm build --image <name>`) to enable snapshots.",
    )
    return 1
  }
  const tag = args.positional[0] ?? snapshot.DEFAULT_TAG
  if (args.flags.has("delete")) {
    await snapshot.remove(p, tag)
    console.log(`deleted snapshot "${tag}"`)
    return 0
  }
  // REFUSE TO FREEZE A GUEST THAT IS NOT READY. Snapshotting a still-booting
  // Windows livelocks it: every vCPU spins, no disk I/O, and the instance is
  // only recoverable by killing it. A snapshot of a half-booted machine would
  // not be worth restoring anyway.
  if (!(await qga.waitReady(p.qga, 120_000))) {
    console.error(`::error::guest "${name}" is not ready — snapshotting one that is still booting wedges it`)
    return 1
  }
  watcher.touchActivity(name)
  const started = Date.now()
  await snapshot.save(p, tag)
  console.log(`snapshot "${tag}" taken in ${String(Date.now() - started)} ms`)
  return 0
}

/**
 * Put the guest back to a snapshot.
 *
 * Works whether or not it is running: a stopped instance is started directly
 * into the saved state (`-loadvm`), which skips booting entirely.
 */
export async function rewind(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  const meta = readMeta(name)
  if (meta === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  const rewatch = watcher.rewatchAfterRestore(name, args)
  // No internal snapshot of that tag: a save of that name (default "baseline").
  const viaSave = await savecmds.rewindViaSave(name, args.positional[0])
  if (viaSave === 0) {
    watcher.touchActivity(name)
    rewatch()
  }
  if (viaSave !== null) return viaSave
  const tag = args.positional[0] ?? snapshot.DEFAULT_TAG
  const started = Date.now()

  if (!qemu.isRunning(p)) {
    if (!snapshot.has(p, tag)) {
      console.error(`::error::instance "${name}" has no snapshot "${tag}" — \`winvm snapshots -i ${name}\``)
      return 1
    }
    try {
      await qemu.launch(name, p, meta, {
        installMedia: false,
        ephemeral: false,
        virtioBoot: virtioBootFor(meta),
        loadvm: tag,
      })
    } catch (error) {
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  } else {
    try {
      await snapshot.load(p, tag)
    } catch (error) {
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  // WAIT FOR THE GUEST, DO NOT SLEEP. `loadvm` returns once QEMU has restored
  // the state, which is before the guest agent can serve anything. A fixed
  // sleep that is a little too short produces the worst possible result: a
  // command answered from across the restore, making a rewind that DID work
  // look like one that changed nothing.
  if (!(await qga.waitResponsive(p.qga, 120_000))) {
    console.error(`::error::guest did not come back after the rewind — see ${p.serial}`)
    return 1
  }
  console.log(`rewound "${name}" to "${tag}" in ${String(Date.now() - started)} ms`)
  await savecmds.afterRewind(name)
  watcher.touchActivity(name)
  rewatch()
  return 0
}

export async function snapshots(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (readMeta(name) === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  // A running QEMU holds the disk, so qemu-img cannot open it; the monitor is
  // the only way in. Both listings go through the same row parser so the output
  // does not change shape depending on whether the guest happens to be up.
  const rows = qemu.isRunning(p) ? await snapshot.listLive(p) : snapshot.list(p)
  if (rows.length === 0) {
    console.log(`instance "${name}" has no snapshots`)
    return 0
  }
  for (const s of rows) console.log(`  ${s.tag.padEnd(18)} ${s.vmSize.padStart(9)}  ${s.date}`)
  return 0
}

export async function stop(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.log(`instance "${name}" is not running`)
    return 0
  }
  // First, so it cannot decide to autosave a guest that is shutting down.
  await watcher.stopWatcher(name)
  await qga.shutdown(p.qga)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (!qemu.isRunning(p)) {
      qemu.stopSwtpm(p)
      console.log(`instance "${name}" stopped`)
      return 0
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.error("::error::guest did not shut down — `winvm kill` if it is wedged")
  return 1
}

/**
 * Restart Windows in a running instance, and wait until it is ready again.
 *
 * The guest restarts; QEMU does not. So an --ephemeral instance keeps what it
 * has written, the agent's port forward stays, and the agent comes back at
 * logon (its Run key). The old boot keeps answering for a while after the
 * request, so "ready" means a NEW boot (LastBootUpTime changed) whose real
 * account has logged on (qga.untilReady, which also repairs an interrupted
 * audit-mode logon).
 */
export async function reboot(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running — \`winvm start -i ${name}\``)
    return 1
  }
  const s = Number(args.flags.get("timeout") ?? 600)
  if (!Number.isFinite(s) || s <= 0) {
    console.error(`::error::--timeout wants seconds, got "${args.flags.get("timeout") ?? ""}"`)
    return 1
  }
  const before = await qga.bootTime(p.qga)
  if (before === null) {
    console.error(
      `::error::the guest is not answering qemu-ga, so a restart can be neither asked for nor confirmed — ` +
        `\`winvm kill -i ${name}\` and \`winvm start -i ${name}\` if it is wedged`,
    )
    return 1
  }
  const t0 = Date.now()
  const deadline = t0 + s * 1000
  // Activity throughout, so the watcher neither saves nor stows a guest mid-restart.
  const outcome = await watcher.whileActive(
    name,
    (async (): Promise<qga.Readiness> => {
      await qga.reboot(p.qga)
      process.stdout.write("rebooting")
      return await qga.untilNewBoot(p.qga, before, deadline - Date.now(), {
        noLogonMs: NO_LOGON_MS,
        log: (line) => process.stdout.write(`\n${line}\n`),
      })
    })(),
  )
  process.stdout.write("\n")
  if (outcome !== "ready") {
    console.error(
      outcome === "no-logon"
        ? `::error::the guest restarted but no one logged on in ${String(NO_LOGON_MS / 1000)} s — \`winvm screenshot -i ${name}\``
        : `::error::the guest was not back within ${String(s)} s. Look at it with \`winvm open -i ${name}\` or ${p.serial}`,
    )
    return 1
  }
  if (agent.readState(p) !== null && (await agent.connect(name, { timeoutMs: 60_000 })) === null) {
    console.warn(`warning: the in-guest agent did not answer within 60 s of logon — \`winvm agent status -i ${name}\``)
  }
  console.log(`instance "${name}" rebooted in ${String(Math.round((Date.now() - t0) / 1000))} s`)
  return 0
}

export function kill(args: Args): number {
  const name = instanceName(args)
  const p = pathsFor(name)
  const pid = qemu.pidOf(p)
  if (pid === null) {
    // Still worth a sweep: a launch that failed, or an older winvm, can leave
    // the TPM emulator running with no guest.
    qemu.stopSwtpm(p)
    stopService(p)
    console.log(`instance "${name}" is not running`)
    return 0
  }
  process.kill(pid, "SIGKILL")
  rmSync(p.pid, { force: true })
  qemu.stopSwtpm(p)
  stopService(p)
  void watcher.stopWatcher(name)
  console.log(`killed instance "${name}"`)
  return 0
}

export function reset(args: Args): number {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is running — stop it first`)
    return 1
  }
  const meta = readMeta(name)
  if (meta === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  resetInstance(name, meta)
  savecmds.afterReset(name)
  console.log(`instance "${name}" reset to image "${meta.image}"`)
  return 0
}

export function destroy(args: Args): number {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is running — stop it first`)
    return 1
  }
  if (readMeta(name) === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  stopService(p)
  qemu.stopSwtpm(p)
  const size = du(instanceDir(name))
  rmSync(instanceDir(name), { recursive: true, force: true })
  console.log(`destroyed instance "${name}" (${size}; image untouched)`)
  if (!existsSync(saves.savesDir(name))) return 0
  const kept = saves.listSaves(name)
  if (args.flags.has("keep-saves")) {
    // `load` recreates the instance from one of them.
    console.log(`  kept its ${plural(kept.length, "save")} in ${saves.savesDir(name)}`)
    return 0
  }
  // du counts the APFS-cloned disks in full, so this can be more than the
  // space actually returned while the clones still share blocks.
  const savesSize = du(saves.savesDir(name))
  saves.removeAllSaves(name)
  console.log(`  and its ${plural(kept.length, "save")} (${savesSize})`)
  return 0
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? "" : "s"}`

export async function exec(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running — \`winvm start -i ${name}\``)
    return 1
  }
  const argv = args.rest.length > 0 ? args.rest : args.positional
  const [program, ...rest] = argv
  if (program === undefined) {
    console.error("::error::usage: winvm exec [-i name] [--timeout S] -- <program> [args...]")
    return 1
  }
  try {
    agentcmds.execTimeoutMs(args)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  // Activity for the whole run, so the watcher never saves or stows mid-command.
  const r = await watcher.whileActive(name, agentcmds.exec(name, args, program, rest))
  if (r.stdout !== "") process.stdout.write(r.stdout)
  if (r.stderr !== "") process.stderr.write(r.stderr)
  return r.exitcode
}

/**
 * Report what the guest is, and optionally assert a staged tool's version.
 *
 * The expectation is supplied BY THE CALLER (`--expect`, or `--expect-file`
 * naming a file relative to the working directory). This tool reads no project
 * file of its own — that is what keeps it usable outside a repository.
 */
export async function smoke(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running`)
    return 1
  }
  watcher.touchActivity(name)
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  // ARCHITECTURE MUST COME FROM THE HARDWARE, NOT THE ENVIRONMENT.
  //
  // `$env:PROCESSOR_ARCHITECTURE` reports AMD64 on this ARM64 guest, because
  // qemu-ga is the x86-64 build (UTM's installer has no ARM64 branch for it)
  // and every process it spawns inherits that emulated environment. Win32_
  // Processor.Architecture comes from the OS: 12 is ARM64, 9 is x64.
  //
  // The practical consequence is worth knowing: anything run through
  // `winvm exec` sees an emulated x64 environment, so tools that branch on
  // PROCESSOR_ARCHITECTURE will take their x64 path. Native ARM64 binaries
  // still execute natively — Bun reports arch "arm64" from the same session.
  const archCode = (
    await qga.exec(p.qga, ps, ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Architecture"])
  ).stdout.trim()
  const archName = archCode === "12" ? "ARM64" : archCode === "9" ? "x64" : `unknown(${archCode})`
  const envArch = (
    await qga.exec(p.qga, ps, ["-NoProfile", "-Command", "$env:PROCESSOR_ARCHITECTURE"])
  ).stdout.trim()
  console.log(`guest cpu -> ${archName}   (exec environment reports ${envArch}; qemu-ga is emulated x64)`)

  const probe = args.flags.get("probe") ?? "C:\\payload\\bun-windows-aarch64\\bun.exe"
  const versionArg = args.flags.get("version-arg") ?? "--version"
  const got = (
    await qga.exec(p.qga, ps, [
      "-NoProfile",
      "-Command",
      `if (Test-Path '${probe}') { & '${probe}' ${versionArg} } else { 'absent' }`,
    ])
  ).stdout.trim()

  let expected = args.flags.get("expect")
  const expectFile = args.flags.get("expect-file")
  if (expected === undefined && expectFile !== undefined) {
    const f = resolve(expectFile)
    if (!existsSync(f)) {
      console.error(`::error::--expect-file ${f} does not exist`)
      return 1
    }
    expected = readFileSync(f, "utf8").trim()
  }

  console.log(`guest probe -> ${got}${expected === undefined ? "" : ` (expected ${expected})`}`)
  if (expected !== undefined && got !== expected) {
    console.error(`::error::guest reported ${got}, expected ${expected}`)
    return 1
  }
  return 0
}

/**
 * Explain a guest that misbehaved, from its files.
 *
 * Separate from `doctor`, which checks the HOST before anything runs. This reads
 * what a guest left behind afterwards, and works on one that is dead or wedged.
 */
export function diagnoseCmd(args: Args): number {
  const name = instanceName(args)
  const findings = diagnose(name)
  console.log(formatFindings(name, findings))
  return findings.some((f) => f.severity === "error") ? 1 : 0
}

/**
 * `winvm watch [-i name]` runs the watcher in the foreground (it is what
 * `start` launches detached). `--stop` ends a running one; `--status` prints
 * its watch.json.
 */
export async function watchCmd(args: Args): Promise<number> {
  const name = instanceName(args)
  if (args.flags.has("stop")) {
    const stopped = await watcher.stopWatcher(name)
    console.log(stopped ? `stopped the watcher for "${name}"` : `instance "${name}" has no watcher running`)
    return 0
  }
  if (args.flags.has("status")) {
    const pid = watcher.watcherPid(name)
    const st = watcher.readWatchState(name)
    if (st === null) console.log(`instance "${name}" has never been watched`)
    else console.log(JSON.stringify(pid === null ? { ...st, state: "stopped" } : st, null, 2))
    return 0
  }
  const interval = args.flags.get("interval")
  const tickMs = interval === undefined ? undefined : Number(interval) * 1000
  if (tickMs !== undefined && !(tickMs >= 1000)) {
    console.error("::error::--interval is a number of seconds, at least 1")
    return 1
  }
  return await watcher.watch(name, {
    ...(tickMs === undefined ? {} : { timing: { tickMs } }),
  })
}

/** `winvm config [-i name] [key=value ...]`: set, then print the effective settings. */
export function configCmd(args: Args): number {
  const name = instanceName(args)
  if (args.positional.length > 0) {
    if (readMeta(name) === null) {
      console.error(`::error::no such instance "${name}"`)
      return 1
    }
    try {
      writeAssignments(name, args.positional.map(parseAssignment))
    } catch (error) {
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  const eff = effectiveConfig(name)
  const set = readOverrides(name)
  console.log(`instance "${name}":`)
  for (const k of CONFIG_KEYS) {
    const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : String(v))
    const note = Object.hasOwn(set, k) ? `(default ${show(DEFAULTS[k])})` : "(default)"
    console.log(`  ${k.padEnd(22)} ${show(eff[k]).padEnd(6)} ${note}`)
  }
  return 0
}

export const USAGE =
  "winvm <command>\n\n" +
  "  setup                         install missing host prerequisites, fetch pinned media\n" +
  "  doctor  [--json]              check host prerequisites (the HOST, before anything runs)\n" +
  "  diagnose [-i name]            explain a guest that misbehaved, from its files\n" +
  "  build --iso <win11.iso>       build a base image (once, ~20 min)\n" +
  "        [--payload <dir>] [--bun <version>] [--image <name>]\n" +
  "  adopt <disk.qcow2>            adopt an installed disk as a base image\n" +
  "  ls                            images and instances, with disk usage (--json: names only)\n" +
  "  create  [-i name] [--image NAME]   a new instance from an image, not started\n" +
  "  start   [-i name] [--ephemeral] [--no-autosave] [--boot] [--no-watch]\n" +
  "                                recalls a stow save if present (--boot: discard it, boot cold)\n" +
  "                                --no-autosave: no baseline save on the first boot (idle\n" +
  "                                autosaves are `config autosave.enabled=false`)\n" +
  "                                --no-watch: no idle watcher (no autosave, stow or clock sync)\n" +
  "  exec    [-i name] [--qga] [--timeout S] -- <cmd>  run a command in the guest (via the agent when installed);\n" +
  "                                exits with its code, or 124 when --timeout (default 900) kills it\n" +
  "  agent   [-i name] install | status [--json]   the in-guest agent (fast exec, files, GUI)\n" +
  "          [-i name] connect [--json]   update it if need be, then print its address and token\n" +
  "  put     [-i name] <host path> <guest path>    copy a file, or a folder and all in it, into the guest\n" +
  "  get     [-i name] <guest path> <host path>    copy a file, or a folder and all in it, out of the guest\n" +
  "  dir     [-i name] [path] [--all] [--places] [--json]   a guest folder (default the Desktop);\n" +
  "                                --all: hidden files too; --places: the known folders\n" +
  "  mkdir   [-i name] <guest path> [--json]       a new folder in the guest\n" +
  "  mv      [-i name] <from> <to> [--json]        rename, or move into the folder <to>; replaces nothing\n" +
  "  cp      [-i name] <from> <to> [--json]        copy in the guest, a file or a whole folder; replaces nothing\n" +
  "  rm      [-i name] <guest path>... [--permanently] [--json]   to the Recycle Bin (--permanently: for good)\n" +
  "  launch  [-i name] -- <program> [args]         start it on the guest's desktop, detached\n" +
  "  script  [-i name] [--timeout S] <file.ps1|.cmd|.bat> [-- args]   copy it to C:\\winvm\\scripts and run it\n" +
  "                                (.ps1: Windows PowerShell 5.1); its output and exit code, as exec\n" +
  "  terminal [-i name] [--shell pwsh|powershell|cmd] [--cwd PATH]   a guest shell, in this terminal\n" +
  "          [--connect --json]    print the WebSocket URL and subprotocols for another client\n" +
  "          --shells [--json]     which shells the guest has (PowerShell 7 may be missing)\n" +
  "  smoke   [-i name] [--expect <v> | --expect-file <path>] [--probe <exe>]\n" +
  "  snapshot [-i name] [tag]      capture the running guest, RAM and all\n" +
  "           [--delete]           remove that snapshot instead\n" +
  "  rewind  [-i name] [tag] [--no-watch]  put the guest back: snapshot <tag> (default fresh),\n" +
  "                                else the save of that name (default: the automatic baseline)\n" +
  "  save    [-i name] [name] [--fast] [--note TEXT]  save the running guest to files (default name: a timestamp)\n" +
  "  load    [-i name] [name] [--no-watch]  load a save, running or stopped (default: the newest)\n" +
  "                                into a stopped instance it starts the watcher, like start\n" +
  "  saves   [-i name] [rm <name>] [--json]  list saves (kind, size, compatible) or delete one\n" +
  "  golden  create|reset [-i name] [--name golden]  settled mapped-ram save; reset to it in ~1 s\n" +
  "  pause | resume [-i name]      freeze / unfreeze the guest (resume fixes its clock)\n" +
  "  stow    [-i name]             save and shut QEMU down; the next start recalls it\n" +
  "  clock   [-i name] [--check]   guest-vs-host clock offset, and fix it\n" +
  "  status  [-i name] [--json]    what it's doing; with no -i and several instances, a table\n" +
  "  open    [-i name] [--web]     show the screen in Screen Sharing, or (--web) the browser;\n" +
  "          [--json]              or print the VNC ports and password for a client\n" +
  "          [--print]             print the URL instead of opening it\n" +
  "  web     [--port n] [--stop]   the browser view's local server, in the foreground\n" +
  "  screenshot [-i name] [file.png]  save the screen (default: <instance>/screenshots/)\n" +
  "  type    [-i name] \"text\"      type into the guest (US layout)\n" +
  "  key     [-i name] <combo>...  e.g. ctrl-alt-delete, win-r, enter, f5\n" +
  "  click   [-i name] <x> <y> [--right|--middle] [--double]   screenshot pixels\n" +
  "          [-i name] --text TEXT [--wait S]   OCR the screen, click the middle of TEXT\n" +
  "  ocr     [-i name] [--find TEXT] [--wait S] [--fast] [--json] [--image f.png]\n" +
  "                                the screen's text and boxes (macOS Vision)\n" +
  "  toasts  [-i name] [--since T] [--app A] [--find TEXT] [--wait S] [--json]\n" +
  "                                notifications apps raised (T: ISO time, or 90s/5m/2h ago)\n" +
  "  move    [-i name] <x> <y>     move the pointer\n" +
  "  scroll  [-i name] <n>         n wheel notches, positive is down (or: up|down [n])\n" +
  "  display [-i name] [WxH] [--scale PCT]   resize the running screen live (virtio-gpu)\n" +
  "          [-i name] virtio-gpu|ramfb       switch a stopped instance's display device\n" +
  "  webview [-i name] enable <exe> | targets | eval <js> | click|wait|text <selector>\n" +
  "                                drive WebView2 windows over DevTools (winvm webview for more)\n" +
  "  ui      [-i name] <verb> [selector]   find and click windows, controls, the tray (winvm ui help)\n" +
  "  cua serve [-i name] [--port N] [--size WxH]   Claude computer-use endpoint on 127.0.0.1 (bearer token)\n" +
  "  cua run [-i name] \"<task>\" [--model M] [--max-steps N] [--extras]   a computer-use agent loop\n" +
  "  mcp     [-i name]             the guest as an MCP server on stdio, for Claude Code and Claude Desktop\n" +
  "  mcp install|uninstall claude-code|claude-desktop [-i name] [--json]   add it to Claude, or take it out\n" +
  "  mcp status [-i name] [--json] whether Claude Code and Claude Desktop have it\n" +
  "  timemachine [--yes]           exclude the VM files from Time Machine backups\n" +
  "  skills  [status] [--json]     winvm's agent skills: where Claude Code, Codex and Copilot see them\n" +
  "  skills  install|uninstall [--claude-code] [--codex] [--copilot] [--agents] [--all] [--json]\n" +
  "                                link them into ~/.claude/skills and ~/.agents/skills (no flag: --all)\n" +
  "  skills  pack [--out DIR] [--json]   one zip per skill, to upload to Claude Desktop\n" +
  "  skills  path                  print the folder they are in\n" +
  "  snapshots [-i name]           list them\n" +
  "  reset   [-i name]             discard changes, back to the base image\n" +
  "  rmi <image> [--force]         remove a base image (undoes its read-only seal)\n" +
  "  prune [--media]               drop leftover build scratch instances, and cached media\n" +
  "  stop | kill [-i name]\n" +
  "  destroy [-i name] [--keep-saves]  remove the instance and its saves\n" +
  "  watch   [-i name]             run the idle watcher in the foreground (start runs it in the background)\n" +
  "          [--stop | --status]   end it / print its state\n" +
  "  config  [-i name] [key=value ...]  autosave/stow/watch settings and the app's title; bare prints them\n" +
  "  run     <job.yml>... [-i name] [--golden NAME] [--keep] [--junit f] [--json f] [--artifacts dir]\n" +
  "                                run CI jobs, each from a golden save (instance default \"ci\")\n" +
  "          [--pool N] [--pool-prefix ci]   on N instances at once (ci-1 … ci-N)\n" +
  "  test    <dir>... [same flags] every *.yml in the directory, in order\n\n" +
  "  state:    WINVM_HOME       (default ~/.local/state/winvm)\n" +
  "  iso:      WINVM_ISO        (else asked once, then remembered)\n" +
  "  instance: WINVM_INSTANCE / -i   (default \"default\")\n" +
  "  image:    WINVM_IMAGE / --image (default \"win11-arm64\")\n"
