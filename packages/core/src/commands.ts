import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"
import * as agent from "./agent"
import * as agentcmds from "./agentcmds"
import type { Args } from "./args"
import {
  imageName,
  instanceName,
  isValidImageName,
  isValidInstanceName,
} from "./args"
import {
  CONFIG_KEYS,
  DEFAULTS,
  effectiveConfig,
  parseAssignment,
  readOverrides,
  writeAssignments,
} from "./config"
import { diagnose, formatFindings } from "./diagnose"
import { runningCommand } from "./display"
import {
  appendEntry,
  type Cursor,
  type Entry,
  endCursor,
  type Found,
  qmpEvent,
  readSince,
  waitForEvent,
} from "./eventlog"
import * as finder from "./finder"
import * as frozen from "./frozen"
import {
  checksReport,
  hostChecks,
  PWSH_SHA256,
  PWSH_URL,
  printChecks,
  requireHost,
  TOOLS_SHA256,
  TOOLS_URL,
} from "./host"
import * as input from "./input"
import { ensureInstance, makeVars, resetInstance, sealBase } from "./instance"
import { ensureKeeper } from "./keeper"
import { killKept, retireKeeper } from "./kept"
import { ManagementError, reconcileManagement } from "./lifecycle"
import * as machineinfo from "./machineinfo"
import {
  buildSeed,
  checkIsoIsArm64,
  ISO_SOURCE,
  makeResultVolume,
  readResult,
  resolveWindowsIso,
} from "./media"
import * as monitor from "./monitor"
import {
  INTERRUPTED,
  interruptedAfterRequest,
  irreversible,
  leaseHolder,
  STOP_UNFINISHED,
  takeInterrupts,
  withOperation,
} from "./operation"
import type { InstanceMeta, Paths } from "./paths"
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
  mediaDir,
  newImageMeta,
  pathsFor,
  readImageMeta,
  readMeta,
} from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as qmp from "./qmp"
import { ensureRuntime, findRuntime, runtimeBin } from "./runtime"
import * as savecmds from "./savecmds"
import * as saves from "./saves"
import { ensureService, stopService } from "./servicectl"
import * as share from "./share"
import { ensureShareMedia } from "./sharemedia"
import { download, du, run, sha256Of } from "./shell"
import * as snapshot from "./snapshot"
import * as timemachine from "./timemachine"
import * as watcher from "./watch"

const virtioBootFor = (meta: InstanceMeta): boolean =>
  readImageMeta(meta.image)?.virtioBoot === true

export function doctor(json = false): number {
  if (json) {
    const report = checksReport(hostChecks(), timemachine.summary())
    console.log(JSON.stringify(report, null, 2))
    return report.ready ? 0 : 1
  }
  const missing = printChecks(hostChecks())
  console.log(timemachine.summary())
  console.log(
    missing === 0
      ? `\nhost is ready · state: ${home()}`
      : `\n${String(missing)} prerequisite(s) missing`,
  )
  return missing === 0 ? 0 : 1
}

export function lsJson(): {
  images: { name: string; snapshots: boolean }[]
  instances: { name: string; image: string | null; running: boolean }[]
} {
  return {
    images: listImages().map((name) => ({
      name,
      snapshots: readImageMeta(name)?.virtioBoot === true,
    })),
    instances: listInstances().map((name) => ({
      name,
      image: readMeta(name)?.image ?? null,
      running: qemu.isRunning(pathsFor(name)),
    })),
  }
}

export function ls(json = false): number {
  if (json) {
    console.log(JSON.stringify(lsJson()))
    return 0
  }
  console.log(`state: ${home()}\n`)
  const images = listImages()
  console.log(
    images.length === 0 ? "images: (none — run `winvm build`)" : "images:",
  )
  for (const i of images) {
    const virtio =
      readImageMeta(i)?.virtioBoot === true
        ? "snapshots"
        : "no snapshots (pre-virtio)"
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
    const note =
      label === "windows ISO"
        ? "  (symlink; the ISO itself is not counted)"
        : ""
    console.log(`  ${label.padEnd(18)} ${du(path).padEnd(7)}${note}`)
  }

  console.log(`\ntotal under ${home()}: ${du(home())}`)
  return 0
}

export function rmi(args: Args): number {
  const image = args.positional[0] ?? imageName(args)
  if (!existsSync(basePath(image))) {
    console.error(`::error::no such image "${image}"`)
    return 1
  }
  const users = listInstances().filter((n) => readMeta(n)?.image === image)
  if (users.length > 0 && !args.flags.has("force")) {
    console.error(
      `::error::image "${image}" still backs ${users.length === 1 ? "instance" : "instances"} ${users.join(", ")} — ` +
        `destroy them first, or pass --force to remove it anyway`,
    )
    return 1
  }
  run("chmod", ["-R", "u+w", imageDir(image)])
  rmSync(imageDir(image), { recursive: true, force: true })
  console.log(`removed image "${image}"`)
  return 0
}

export function prune(args: Args): number {
  let freedAnything = false
  for (const name of listInstances().filter((n) => n.startsWith("build-"))) {
    const p = pathsFor(name)
    if (qemu.isRunning(p)) {
      console.log(
        `  keeping "${name}" — still running (pid ${String(qemu.pidOf(p))})`,
      )
      continue
    }
    const size = du(p.dir)
    qemu.stopSidecars(p)
    stopService(p)
    retireKeeper(name, p)
    rmSync(p.dir, { recursive: true, force: true })
    saves.removeAllSaves(name)
    console.log(`  removed scratch instance "${name}" (${size})`)
    freedAnything = true
  }
  if (args.flags.has("media")) {
    for (const path of [
      media.tools(),
      media.pwsh(),
      media.seed(),
      media.seedDir(),
    ]) {
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

export function setup(args: Args): number {
  try {
    const rt = ensureRuntime()
    console.log(`runtime ${rt.manifest?.version ?? "?"} in ${rt.dir}`)
    const keeper = ensureKeeper()
    if (keeper !== null) console.log(`keeper ${keeper.path}`)
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
  if (!args.flags.has("no-media")) {
    mkdirSync(mediaDir(), { recursive: true })
    try {
      download(TOOLS_URL, media.tools(), TOOLS_SHA256)
      download(PWSH_URL, media.pwsh(), PWSH_SHA256)
    } catch (error) {
      console.error(
        `::error::${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }
  }
  console.log("")
  return doctor()
}

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
    console.error(
      `::error::invalid image name "${image}" — letters, digits, ".", "_" and "-" only`,
    )
    return 1
  }
  if (existsSync(basePath(image))) {
    console.error(
      `::error::image "${image}" already exists at ${basePath(image)}`,
    )
    return 1
  }
  mkdirSync(imageDir(image), { recursive: true })
  if (run("mv", [from, basePath(image)]) !== 0) return 1
  sealBase(image)
  console.log(
    `adopted as image "${image}" (${du(basePath(image))}), now read-only`,
  )
  return 0
}

export async function build(args: Args): Promise<number> {
  requireHost()
  const image = imageName(args)
  if (!isValidImageName(image)) {
    console.error(
      `::error::invalid image name "${image}" — letters, digits, ".", "_" and "-" only`,
    )
    return 1
  }
  if (existsSync(basePath(image))) {
    console.error(
      `::error::image "${image}" already exists — use --image <other>, or remove it deliberately`,
    )
    return 1
  }
  const dependents = listInstances().filter(
    (n) => n !== `build-${image}` && readMeta(n)?.image === image,
  )
  if (dependents.length > 0) {
    console.error(
      `::error::instances ${dependents.join(", ")} name image "${image}" — build under another --image name`,
    )
    return 1
  }

  const scratch = `build-${image}`
  const p = pathsFor(scratch)

  if (qemu.isRunning(p)) {
    console.error(
      `::error::a build of "${image}" is already running (pid ${String(qemu.pidOf(p))}) — ` +
        `\`winvm kill -i ${scratch}\` if it is stuck`,
    )
    return 1
  }

  mkdirSync(mediaDir(), { recursive: true })
  const iso = resolveWindowsIso(args.flags.get("iso"))
  if (iso === null) {
    console.error(
      `::error::pass a Windows 11 ARM64 ISO: winvm build --iso <path>, or set WINVM_ISO\n${ISO_SOURCE}`,
    )
    return 1
  }
  if (!checkIsoIsArm64(iso)) return 1
  console.log("checksumming the ISO (it is read, never changed)")
  const isoSha256 = sha256Of(iso)
  if (resolve(iso) !== resolve(media.iso())) {
    rmSync(media.iso(), { force: true })
    run("ln", ["-s", iso, media.iso()])
  }

  download(TOOLS_URL, media.tools(), TOOLS_SHA256)
  download(PWSH_URL, media.pwsh(), PWSH_SHA256)
  let shareMedia: string | undefined
  if (share.runtimeSupport().ok) {
    try {
      shareMedia = await ensureShareMedia()
    } catch (error) {
      console.warn(
        `warning: no shared folder in this image (${error instanceof Error ? error.message : String(error)}); \`winvm share install\` adds it later`,
      )
    }
  }
  buildSeed(args.flags.get("payload"), args.flags.get("bun"), shareMedia)

  stopService(p)
  rmSync(p.dir, { recursive: true, force: true })
  mkdirSync(p.tpmDir, { recursive: true })
  run(runtimeBin("qemu-img"), ["create", "-f", "qcow2", p.overlay, "64G"])
  run(runtimeBin("qemu-img"), ["create", "-f", "qcow2", p.prime, "64M"])
  makeVars(p.vars)
  makeResultVolume(p.result)
  const meta: InstanceMeta = {
    image,
    vnc: allocateVnc(),
    created: new Date().toISOString(),
  }
  writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`)

  const reap = (): void => {
    const pid = qemu.pidOf(p)
    if (pid !== null) process.kill(pid, "SIGKILL")
    qemu.stopSidecars(p)
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      reap()
      console.error(
        `\n::error::build interrupted — guest killed, scratch instance "${scratch}" kept`,
      )
      process.exit(1)
    })
  }

  console.log(
    `installing Windows (unattended, ~20 min) · watch: winvm open -i ${scratch}`,
  )
  try {
    await launchInstaller(scratch, p, meta)
  } catch (error) {
    qemu.stopSidecars(p)
    console.error(
      `::error::could not start the installer VM: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }

  const installerWriting = (): boolean => {
    try {
      return statSync(p.overlay).size > 300_000_000
    } catch {
      return false
    }
  }
  void (async () => {
    if (!(await qemu.waitForSerial(p, "winvm-keypress-needed", 10 * 60_000))) {
      console.warn(
        "warning: the firmware never asked for a keypress; the install may stall at the boot prompt",
      )
      return
    }
    const { keys, answered } = await qmp.answerBootPrompt(
      p.qmp,
      resolve(p.dir, "boot-prompt.ppm"),
    )
    if (answered)
      console.log(
        `boot prompt answered (${String(keys)} key${keys === 1 ? "" : "s"})`,
      )
    else
      console.warn(
        `warning: the boot prompt was not seen to take a key (${String(keys)} sent)`,
      )
    for (let waited = 0; waited < 300_000; waited += 5000) {
      if (installerWriting()) return
      await new Promise((r) => setTimeout(r, 5000))
    }
    console.error(
      "::error::the installer never started writing — the boot prompt appears to have gone unanswered",
    )
  })().catch((error: unknown) => {
    console.warn(
      `warning: could not answer the boot prompt: ${error instanceof Error ? error.message : String(error)}`,
    )
  })

  const guestFailed = (why: string): number => {
    console.error(`::error::${why}`)
    reap()
    const result = readResult(p.result)
    for (const line of result.log.trimEnd().split("\n").slice(-20)) {
      if (line.trim() !== "") console.error(`  | ${line}`)
    }
    const findings = diagnose(scratch)
    if (findings.length > 0)
      console.error(`\n${formatFindings(scratch, findings)}\n`)
    console.error(
      `  firmware log: ${p.serial}\n` +
        `  scratch instance "${scratch}" kept for inspection — \`winvm destroy -i ${scratch}\` when done`,
    )
    return 1
  }

  if (!(await qga.waitFor(p.qga, 45 * 60_000))) {
    return guestFailed(
      "the guest agent never came up, so provisioning did not get far enough to install it",
    )
  }

  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const ask = async (command: string): Promise<string | null> => {
    try {
      return (
        await qga.exec(p.qga, ps, ["-NoProfile", "-Command", command])
      ).stdout.trim()
    } catch {
      return null
    }
  }

  const provisionDeadline = Date.now() + 60 * 60_000
  let provisioned = false
  while (Date.now() < provisionDeadline) {
    if ((await ask("Test-Path C:\\winvm-provisioned.txt")) === "True") {
      provisioned = true
      break
    }
    await new Promise((r) => setTimeout(r, 10_000))
  }
  if (!provisioned)
    return guestFailed("provisioning never reported that it finished")

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
  try {
    await qga.shutdown(p.qga)
  } catch (error) {
    return guestFailed(
      `the guest could not be asked to shut down after provisioning: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const stopDeadline = Date.now() + 10 * 60_000
  while (Date.now() < stopDeadline) {
    if (!qemu.isRunning(p)) {
      if (existsSync(basePath(image))) {
        console.error(
          `::error::image "${image}" appeared while this build ran; not replacing it. ` +
            `The new disk is kept at ${p.overlay}`,
        )
        return 1
      }
      mkdirSync(imageDir(image), { recursive: true })
      if (
        run("mv", ["-n", p.overlay, basePath(image)]) !== 0 ||
        existsSync(p.overlay)
      ) {
        console.error(
          `::error::could not move the new disk into place; it is kept at ${p.overlay}`,
        )
        return 1
      }
      sealBase(image)
      const imageMeta = newImageMeta({
        virtioBoot,
        created: new Date().toISOString(),
        runtime: findRuntime()?.manifest?.version ?? "override",
        isoSha256,
        guestToolsSha256: TOOLS_SHA256,
      })
      writeFileSync(
        imageMetaPath(image),
        `${JSON.stringify(imageMeta, null, 2)}\n`,
      )
      qemu.stopSidecars(p)
      stopService(p)
      retireKeeper(scratch, p)
      rmSync(p.dir, { recursive: true, force: true })
      console.log(
        `base image ready: ${basePath(image)} (${du(basePath(image))})`,
      )
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
  return guestFailed("the guest did not shut down after provisioning")
}

export const launchInstaller = async (
  scratch: string,
  p: Paths,
  meta: InstanceMeta,
): Promise<void> => {
  await withOperation(scratch, "build", async () => {
    await qemu.launch(scratch, p, meta, {
      installMedia: true,
      ephemeral: false,
      virtioBoot: false,
    })
  })
}

const NO_LOGON_MS = 120_000

export function create(args: Args): number {
  requireHost()
  const name = instanceName(args)
  if (!isValidInstanceName(name)) {
    console.error(
      `::error::"${name}" is not a name winvm takes: letters, digits, ".", "-" and "_", starting with a letter or digit, up to 64`,
    )
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

export interface RunningStartSeams {
  readonly reconcile?: (name: string, p: Paths) => Promise<unknown>
  readonly startWatcher?: (name: string, args: Args) => void
  readonly frozenState?: (p: Paths) => Promise<frozen.Frozen | null>
  readonly afterUp?: (name: string) => Promise<void>
}

export async function startRunning(
  name: string,
  args: Args,
  seams: RunningStartSeams = {},
): Promise<number> {
  const p = pathsFor(name)
  const reconcile = seams.reconcile ?? reconcileManagement
  const startWatcher = seams.startWatcher ?? watcher.startWatcherFor
  const frozenState = seams.frozenState ?? ((q: Paths) => frozen.frozenState(q))
  const afterUp = seams.afterUp ?? ((n: string) => finder.afterUp(n))
  console.log(`instance "${name}" already running`)
  try {
    await reconcile(name, p)
  } catch (error) {
    if (!(error instanceof ManagementError)) throw error
    console.error(`::error::${error.message}`)
    return 1
  }
  startWatcher(name, args)
  if ((await frozenState(p)) === null) await afterUp(name)
  return 0
}

export async function start(args: Args): Promise<number> {
  requireHost()
  const name = instanceName(args)
  const p = pathsFor(name)
  if (qemu.isRunning(p)) return await startRunning(name, args)
  const recalled = await savecmds.recallStow(name, args)
  if (recalled === 0) watcher.startWatcherFor(name, args)
  if (recalled !== null) return recalled
  const isNew = readMeta(name) === null
  if (isNew && !isValidInstanceName(name)) {
    console.error(
      `::error::"${name}" is not a name winvm takes: letters, digits, ".", "-" and "_", starting with a letter or digit, up to 64`,
    )
    return 1
  }
  ensureInstance(name, imageName(args))
  if (isNew) savecmds.markPristine(name)
  const meta = readMeta(name)
  if (meta === null) return 1
  const stranded = saves.strandedNote(name, saves.strandedByDevices(name))
  if (stranded !== null) console.log(stranded)

  const virtioBoot = virtioBootFor(meta)
  try {
    await qemu.launch(name, p, meta, {
      installMedia: false,
      ephemeral: args.flags.has("ephemeral"),
      virtioBoot,
    })
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
  process.stdout.write("booting")
  const ready = await qga.untilReady(p.qga, 600_000, {
    noLogonMs: NO_LOGON_MS,
    log: (line) => process.stdout.write(`\n${line}\n`),
  })
  process.stdout.write("\n")
  if (ready === "no-logon") {
    const file = resolve(
      p.dir,
      "screenshots",
      `${new Date().toISOString().replace(/[:]/g, "").replace(/\..*$/, "").replace("T", "-")}-no-logon.png`,
    )
    const shot = await input.screenshot(p, file).then(
      () => file,
      () => null,
    )
    console.error(
      `::error::the guest is up but no one logged on in ${String(NO_LOGON_MS / 1000)} s — it is most likely at the sign-in screen. ` +
        (shot === null
          ? `Look at it with \`winvm screenshot -i ${name}\``
          : `Screen: ${shot}`),
    )
    return 1
  }
  if (ready !== "ready") {
    console.error(
      `::error::guest never became ready. Look at it with \`winvm open -i ${name}\` or ${p.serial}`,
    )
    return 1
  }
  console.log(
    `instance "${name}" up (vnc :${String(readMeta(name)?.vnc ?? meta.vnc)})`,
  )
  await savecmds.afterBoot(name, args)
  await finder.afterUp(name)
  watcher.startWatcherFor(name, args)
  return 0
}

export async function snap(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  const meta = readMeta(name)
  if (meta === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  if (!qemu.isRunning(p)) {
    console.error(
      `::error::instance "${name}" is not running — a snapshot captures a LIVE guest`,
    )
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
  if (!(await qga.waitReady(p.qga, 120_000))) {
    console.error(
      `::error::guest "${name}" is not ready — snapshotting one that is still booting wedges it`,
    )
    return 1
  }
  watcher.touchActivity(name)
  const started = Date.now()
  await snapshot.save(p, tag)
  console.log(`snapshot "${tag}" taken in ${String(Date.now() - started)} ms`)
  return 0
}

export async function rewind(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  const meta = readMeta(name)
  if (meta === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  const rewatch = watcher.rewatchAfterRestore(name, args)
  finder.beforeDown(name)
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
      console.error(
        `::error::instance "${name}" has no snapshot "${tag}" — \`winvm snapshots -i ${name}\``,
      )
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
      console.error(
        `::error::${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }
  } else {
    try {
      await snapshot.load(p, tag)
    } catch (error) {
      console.error(
        `::error::${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }
  }

  if (!(await qga.waitResponsive(p.qga, 120_000))) {
    console.error(
      `::error::guest did not come back after the rewind — see ${p.serial}`,
    )
    return 1
  }
  console.log(
    `rewound "${name}" to "${tag}" in ${String(Date.now() - started)} ms`,
  )
  await savecmds.afterRewind(name)
  await finder.afterUp(name)
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
  const rows = qemu.isRunning(p) ? await snapshot.listLive(p) : snapshot.list(p)
  if (rows.length === 0) {
    console.log(`instance "${name}" has no snapshots`)
    return 0
  }
  for (const s of rows)
    console.log(`  ${s.tag.padEnd(18)} ${s.vmSize.padStart(9)}  ${s.date}`)
  return 0
}

const STOP_DEADLINE_MS = 180_000
const STOP_POLL_MS = 3000
const FORCE_AFTER_MS = 60_000
const EXIT_GRACE_MS = 15_000
const EXIT_POLL_MS = 250
const POWERDOWN_TIMEOUT_MS = 10_000
const FORCE_MIN_LEFT_MS = 10_000
const MAX_SIGHTINGS = 12

export interface StopCommandSeams {
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly pidOf?: (p: Paths) => number | null
  readonly isRunning?: (p: Paths) => boolean
  readonly frozenState?: (p: Paths) => Promise<frozen.Frozen | null>
  readonly resume?: (p: Paths) => Promise<void>
  readonly hold?: (p: Paths) => Promise<void>
  readonly ensureService?: (name: string, p: Paths) => Promise<unknown>
  readonly powerdown?: (p: Paths) => Promise<void>
  readonly untilEvent?: (
    name: string,
    matches: (e: Entry) => boolean,
    since: Cursor,
    until: number,
  ) => Promise<Found<Entry> | null>
  readonly waitFor?: (
    sockPath: string,
    timeoutMs: number,
    o?: qga.WaitOptions,
  ) => Promise<boolean>
  readonly shutdown?: (sockPath: string) => Promise<void>
  readonly watcherPid?: (name: string) => number | null
  readonly stopWatcher?: (name: string) => Promise<boolean>
  readonly ensureWatcher?: (name: string) => number | null
  readonly beforeDown?: (name: string) => void
  readonly afterUp?: (name: string) => Promise<void>
  readonly stopSidecars?: (p: Paths) => void
  readonly irreversible?: (
    name: string,
    recovery: readonly string[],
  ) => () => void
  readonly interrupts?: (name: string) => {
    readonly signal: AbortSignal
    readonly release: () => void
  }
}

class StopInterrupted extends Error {
  readonly by: string

  constructor(by: string) {
    super(`stop interrupted by ${by}`)
    this.name = "StopInterrupted"
    this.by = by
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const seconds = (ms: number): string => String(Math.round(ms / 1000))

const shutdownEvent = qmpEvent("SHUTDOWN")

const qemuClosed = (e: Entry): boolean =>
  e.kind === "disconnected" && e.reason === "qemu-closed"

const qemuGoing = (e: Entry): boolean => shutdownEvent(e) || qemuClosed(e)

function sighting(e: Entry): string | null {
  switch (e.kind) {
    case "qmp": {
      const d = e.data ?? {}
      if (e.event === "VSERPORT_CHANGE")
        return `VSERPORT_CHANGE ${typeof d.id === "string" ? d.id : "?"} ${d.open === true ? "opened" : "closed"}`
      return typeof d.reason === "string" ? `${e.event} (${d.reason})` : e.event
    }
    case "sync":
      return `sync ${e.status ?? e.error ?? "?"}`
    case "disconnected":
      return `disconnected (${e.reason})`
    case "op":
    case "service":
    case "warning":
    case "keeper":
      return null
  }
}

function leftRunning(
  name: string,
  pid: number | null,
  original: frozen.Frozen | null,
): readonly string[] {
  const again =
    original === null
      ? ""
      : `, then \`winvm ${original === "paused" ? "pause" : "sleep"} -i ${name}\` to freeze it again`
  return [
    `Nothing was undone after the request. QEMU is still running${pid === null ? "" : ` (pid ${String(pid)})`}.` +
      (original === null
        ? ""
        : ` Windows was ${original}, and stop resumed it to shut it down.`) +
      " The watcher (autosave, idle sleep) and the guest's Finder drives were taken down for the shutdown and are still down.",
    `Still shutting down (installing updates, say)? Wait, and follow it with \`winvm status -i ${name}\`.`,
    `Want it back as it was? \`winvm start -i ${name}\` restarts the watcher and mounts the drives again${again}.`,
    `Stuck? \`winvm kill -i ${name}\` powers it off at once, and anything unsaved in Windows is lost.`,
  ]
}

function sightings(entries: readonly Entry[]): string {
  const seen = entries.map(sighting).filter((s): s is string => s !== null)
  if (seen.length === 0) return "nothing from QEMU"
  const shown = seen.slice(0, MAX_SIGHTINGS).join(", ")
  return seen.length > MAX_SIGHTINGS
    ? `${shown} and ${String(seen.length - MAX_SIGHTINGS)} more`
    : shown
}

export const stop = (args: Args): Promise<number> => stopWith(args)

export async function stopWith(
  args: Args,
  seams: StopCommandSeams = {},
): Promise<number> {
  const name = instanceName(args)
  const interrupts = (seams.interrupts ?? ((n) => takeInterrupts(n, "stop")))(
    name,
  )
  const settle = { disarm: (): void => undefined }
  try {
    return await stopRun(args, seams, interrupts.signal, settle)
  } finally {
    settle.disarm()
    interrupts.release()
  }
}

async function stopRun(
  args: Args,
  seams: StopCommandSeams,
  interrupted: AbortSignal,
  settle: { disarm: () => void },
): Promise<number> {
  const now = seams.now ?? Date.now
  const sleep =
    seams.sleep ??
    ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const isRunning = seams.isRunning ?? qemu.isRunning
  const pidOf = seams.pidOf ?? qemu.pidOf
  const waitFor = seams.waitFor ?? qga.waitFor
  const shutdown = seams.shutdown ?? ((sock: string) => qga.shutdown(sock))
  const stopWatcher =
    seams.stopWatcher ?? ((n: string) => watcher.stopWatcher(n))
  const beforeDown =
    seams.beforeDown ??
    ((n: string) => {
      finder.beforeDown(n)
    })
  const stopSidecars = seams.stopSidecars ?? qemu.stopSidecars
  const markIrreversible = seams.irreversible ?? irreversible
  const frozenState = seams.frozenState ?? ((p: Paths) => frozen.frozenState(p))
  const resume =
    seams.resume ??
    (async (p: Paths): Promise<void> => void (await qmp.execute(p.qmp, "cont")))
  const hold =
    seams.hold ??
    (async (p: Paths): Promise<void> => void (await qmp.execute(p.qmp, "stop")))
  const service =
    seams.ensureService ?? ((n: string, p: Paths) => ensureService(n, p))
  const powerdown =
    seams.powerdown ??
    (async (p: Paths): Promise<void> =>
      void (await monitor.qmpCommand(
        p.qmp,
        "system_powerdown",
        undefined,
        POWERDOWN_TIMEOUT_MS,
      )))
  const untilEvent =
    seams.untilEvent ??
    ((
      n: string,
      matches: (e: Entry) => boolean,
      since: Cursor,
      until: number,
    ): Promise<Found<Entry> | null> =>
      waitForEvent(n, matches, Date.now() + (until - now()), { since }))
  const afterUp = seams.afterUp ?? ((n: string) => finder.afterUp(n))
  const ensureWatcher = seams.ensureWatcher ?? watcher.ensureWatcher
  const watcherPid = seams.watcherPid ?? ((n: string) => watcher.watcherPid(n))
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!isRunning(p)) {
    console.log(`instance "${name}" is not running`)
    return 0
  }
  const pid = pidOf(p)
  const original = await frozenState(p)
  const hadWatcher = watcherPid(name) !== null
  let resumed = false
  const attempt = async (what: string, f: () => unknown): Promise<void> => {
    try {
      await f()
    } catch (error) {
      console.warn(`warning: could not ${what}: ${errorText(error)}`)
    }
  }
  const rollback = async (): Promise<void> => {
    if (original === null || resumed)
      await attempt("remount the guest's drives", () => afterUp(name))
    if (original !== null && pid !== null && pidOf(p) === pid) {
      await attempt("pause the guest again", () => hold(p))
      if (original === "asleep" && resumed) frozen.markAsleep(p, pid)
    }
    if (hadWatcher)
      await attempt("restart the watcher", () => ensureWatcher(name))
  }

  const interruptedBy = (): string => String(interrupted.reason)
  const checkpoint = (): void => {
    if (interrupted.aborted) throw new StopInterrupted(interruptedBy())
  }

  let deadline: number
  let since: Cursor
  let unconfirmed: string | null = null
  try {
    checkpoint()
    await stopWatcher(name)
    checkpoint()
    beforeDown(name)
    deadline = now() + STOP_DEADLINE_MS
    await service(name, p)
    checkpoint()
    since = endCursor(name)
    if (original !== null) {
      await resume(p)
      resumed = true
      frozen.clearAsleep(p)
      checkpoint()
    }
    try {
      await powerdown(p)
    } catch (error) {
      if (error instanceof monitor.QmpNotDelivered) throw error
      unconfirmed = errorText(error)
    }
  } catch (error) {
    await rollback()
    if (error instanceof StopInterrupted) {
      console.error(
        `::error::stop interrupted by ${error.by} before it asked Windows to shut down; the watcher and the guest's drives were put back` +
          (original === null ? "" : `, and the guest was left ${original}`),
      )
      return INTERRUPTED
    }
    console.error(`::error::${errorText(error)}`)
    return 1
  }

  const afterRequest = leftRunning(name, pidOf(p), original)
  settle.disarm = markIrreversible(name, afterRequest)
  if (interrupted.aborted) {
    console.error(interruptedAfterRequest("stop", interruptedBy()))
    for (const line of afterRequest) console.error(`  ${line}`)
    return STOP_UNFINISHED
  }
  const requestedAt = now()
  const forceAt = requestedAt + FORCE_AFTER_MS
  const forced: { note: string | null } = { note: null }
  const done = new AbortController()
  const warn = (line: string): void => {
    if (!done.signal.aborted) console.warn(`warning: ${line}`)
  }
  const force = async (): Promise<void> => {
    console.log(
      `Windows has not shut down ${seconds(now() - requestedAt)} s after the power-button request; ` +
        "asking its guest agent to force the shutdown, which closes open apps without saving",
    )
    forced.note =
      "guest-shutdown (forced) was still waiting for the guest agent"
    const ready = await waitFor(p.qga, deadline - now(), {
      signal: done.signal,
    })
    if (done.signal.aborted) return
    if (!ready) {
      forced.note =
        "guest-shutdown (forced) was not sent: the guest agent did not answer"
      warn(forced.note)
      return
    }
    if (deadline - now() < FORCE_MIN_LEFT_MS) {
      forced.note =
        "guest-shutdown (forced) was not sent: the guest agent answered with too little time left to see it through"
      warn(forced.note)
      return
    }
    const at = seconds(now() - requestedAt)
    forced.note = `guest-shutdown (forced) sent at ${at} s, with no answer yet`
    appendEntry(name, {
      kind: "warning",
      what: "stop forced a shutdown through the guest agent (guest-shutdown), which closes open apps without saving",
      operation: "stop",
      afterSeconds: Number(at),
    })
    try {
      await shutdown(p.qga)
      forced.note = `guest-shutdown (forced) at ${at} s`
    } catch (error) {
      forced.note = `guest-shutdown (forced) at ${at} s failed: ${errorText(error)}`
      warn(forced.note)
    }
  }

  let at = since
  let seen: Entry | null = null
  let closed = false
  let gap = false
  let exitBy = deadline
  let forcing = false
  try {
    while (isRunning(p)) {
      if (now() >= exitBy) {
        const left = leftRunning(name, pidOf(p), original)
        if (seen !== null) {
          console.error(
            `::error::QEMU recorded ${sighting(seen) ?? "SHUTDOWN"} but has not exited`,
          )
          for (const line of left) console.error(`  ${line}`)
          return STOP_UNFINISHED
        }
        const sent = [
          unconfirmed === null
            ? "system_powerdown (the ACPI power button)"
            : `system_powerdown (the ACPI power button), which QEMU did not confirm: ${unconfirmed}`,
        ]
        if (forced.note !== null) sent.push(forced.note)
        const record = readSince(name, since)
        const holes =
          gap || record.gap
            ? " (the record has a gap, so this may not be everything)"
            : ""
        console.error(
          `::error::guest did not shut down within ${seconds(STOP_DEADLINE_MS)} s. ` +
            `Sent: ${sent.join("; ")}. ` +
            `Seen since: ${sightings(record.entries)}${holes}.`,
        )
        for (const line of left) console.error(`  ${line}`)
        return STOP_UNFINISHED
      }
      if (closed) {
        await sleep(Math.min(EXIT_POLL_MS, exitBy - now()))
        continue
      }
      if (seen === null && !forcing && now() >= forceAt) {
        forcing = true
        void force().catch((error: unknown) => {
          forced.note = `guest-shutdown (forced) failed: ${errorText(error)}`
        })
      }
      const found = await untilEvent(
        name,
        seen === null ? qemuGoing : qemuClosed,
        at,
        Math.min(exitBy, now() + STOP_POLL_MS),
      )
      if (found === null) continue
      at = found.cursor
      gap ||= found.gap
      if (seen === null) {
        seen = found.entry
        exitBy = Math.max(deadline, now() + EXIT_GRACE_MS)
      }
      if (qemuClosed(found.entry)) closed = true
    }
  } finally {
    done.abort()
  }
  stopSidecars(p)
  console.log(`instance "${name}" stopped`)
  return 0
}

export async function reboot(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(
      `::error::instance "${name}" is not running — \`winvm start -i ${name}\``,
    )
    return 1
  }
  const s = Number(args.flags.get("timeout") ?? 600)
  if (!Number.isFinite(s) || s <= 0) {
    console.error(
      `::error::--timeout wants seconds, got "${args.flags.get("timeout") ?? ""}"`,
    )
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
  finder.beforeDown(name)
  const outcome = await watcher.whileActive(
    name,
    (async (): Promise<qga.Readiness | { readonly refused: string }> => {
      try {
        await qga.reboot(p.qga)
      } catch (error) {
        return { refused: errorText(error) }
      }
      process.stdout.write("rebooting")
      return await qga.untilNewBoot(p.qga, before, deadline - Date.now(), {
        noLogonMs: NO_LOGON_MS,
        log: (line) => process.stdout.write(`\n${line}\n`),
      })
    })(),
  )
  if (typeof outcome === "object") {
    console.error(
      `::error::the guest did not take the restart: ${outcome.refused}`,
    )
    await finder.afterUp(name)
    return 1
  }
  process.stdout.write("\n")
  if (outcome !== "ready") {
    console.error(
      outcome === "no-logon"
        ? `::error::the guest restarted but no one logged on in ${String(NO_LOGON_MS / 1000)} s — \`winvm screenshot -i ${name}\``
        : `::error::the guest was not back within ${String(s)} s. Look at it with \`winvm open -i ${name}\` or ${p.serial}`,
    )
    return 1
  }
  if (
    agent.readState(p) !== null &&
    (await agent.connect(name, { timeoutMs: 60_000 })) === null
  ) {
    console.warn(
      `warning: the in-guest agent did not answer within 60 s of logon — \`winvm agent status -i ${name}\``,
    )
  }
  await finder.afterUp(name)
  console.log(
    `instance "${name}" rebooted in ${String(Math.round((Date.now() - t0) / 1000))} s`,
  )
  return 0
}

export async function kill(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  const pid = qemu.pidOf(p)
  const holder = leaseHolder(name)
  if (pid === null && holder !== null) {
    console.error(
      `::error::"${name}" has no QEMU running, and its ${holder.operation} (pid ${String(holder.pid)}) is still in progress; nothing was killed`,
    )
    return 1
  }
  if (pid === null) {
    qemu.stopSidecars(p)
    stopService(p)
    finder.cleanStale(name)
    console.log(`instance "${name}" is not running`)
    return 0
  }
  if (runningCommand(pid) === null) {
    console.error(
      `::error::could not read the command line of pid ${String(pid)}, named by ${p.pid}; nothing was killed. Try again`,
    )
    return 1
  }
  if (!qemu.isInstanceQemu(pid, p)) {
    console.error(
      `::error::${p.pid} names pid ${String(pid)}, which is not the QEMU of "${name}"; nothing was killed. ` +
        `If no QEMU of "${name}" is running, remove that file`,
    )
    return 1
  }
  finder.beforeDown(name)
  if (!(await killKept(p, pid))) process.kill(pid, "SIGKILL")
  rmSync(p.pid, { force: true })
  qemu.stopSidecars(p)
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
  finder.cleanStale(name)
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
  qemu.stopSidecars(p)
  retireKeeper(name, p)
  finder.cleanStale(name)
  const size = du(instanceDir(name))
  rmSync(instanceDir(name), { recursive: true, force: true })
  console.log(`destroyed instance "${name}" (${size}; image untouched)`)
  if (!existsSync(saves.savesDir(name))) return 0
  const kept = saves.listSaves(name)
  if (args.flags.has("keep-saves")) {
    console.log(
      `  kept its ${plural(kept.length, "save")} in ${saves.savesDir(name)}`,
    )
    return 0
  }
  const savesSize = du(saves.savesDir(name))
  saves.removeAllSaves(name)
  console.log(`  and its ${plural(kept.length, "save")} (${savesSize})`)
  return 0
}

const plural = (n: number, noun: string): string =>
  `${String(n)} ${noun}${n === 1 ? "" : "s"}`

export async function exec(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(
      `::error::instance "${name}" is not running — \`winvm start -i ${name}\``,
    )
    return 1
  }
  const argv = args.rest.length > 0 ? args.rest : args.positional
  const [program, ...rest] = argv
  if (program === undefined) {
    console.error(
      "::error::usage: winvm exec [-i name] [--timeout S] -- <program> [args...]",
    )
    return 1
  }
  try {
    agentcmds.execTimeoutMs(args)
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
  const r = await watcher.whileActive(
    name,
    agentcmds.exec(name, args, program, rest),
  )
  if (r.stdout !== "") process.stdout.write(r.stdout)
  if (r.stderr !== "") process.stderr.write(r.stderr)
  return r.exitcode
}

export async function smoke(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running`)
    return 1
  }
  watcher.touchActivity(name)
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const archCode = (
    await qga.exec(p.qga, ps, [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Processor).Architecture",
    ])
  ).stdout.trim()
  const archName =
    archCode === "12"
      ? "ARM64"
      : archCode === "9"
        ? "x64"
        : `unknown(${archCode})`
  const envArch = (
    await qga.exec(p.qga, ps, [
      "-NoProfile",
      "-Command",
      "$env:PROCESSOR_ARCHITECTURE",
    ])
  ).stdout.trim()
  console.log(
    `guest cpu -> ${archName}   (exec environment reports ${envArch}; qemu-ga is emulated x64)`,
  )

  const probe =
    args.flags.get("probe") ?? "C:\\payload\\bun-windows-aarch64\\bun.exe"
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

  console.log(
    `guest probe -> ${got}${expected === undefined ? "" : ` (expected ${expected})`}`,
  )
  if (expected !== undefined && got !== expected) {
    console.error(`::error::guest reported ${got}, expected ${expected}`)
    return 1
  }
  return 0
}

export function diagnoseCmd(args: Args): number {
  const name = instanceName(args)
  for (const dir of finder.cleanStale(name))
    console.log(
      `unmounted ${dir}, left behind by a guest that is no longer running`,
    )
  const findings = diagnose(name)
  console.log(formatFindings(name, findings))
  return findings.some((f) => f.severity === "error") ? 1 : 0
}

export async function watchCmd(args: Args): Promise<number> {
  const name = instanceName(args)
  if (args.flags.has("stop")) {
    const stopped = await watcher.stopWatcher(name)
    console.log(
      stopped
        ? `stopped the watcher for "${name}"`
        : `instance "${name}" has no watcher running`,
    )
    return 0
  }
  if (args.flags.has("status")) {
    const pid = watcher.watcherPid(name)
    const st = watcher.readWatchState(name)
    if (st === null) console.log(`instance "${name}" has never been watched`)
    else
      console.log(
        JSON.stringify(
          pid === null ? { ...st, state: "stopped" } : st,
          null,
          2,
        ),
      )
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

export function configCmd(args: Args): number {
  const name = instanceName(args)
  let sized: string | null = null
  if (args.positional.length > 0) {
    if (readMeta(name) === null) {
      console.error(`::error::no such instance "${name}"`)
      return 1
    }
    try {
      const parsed = args.positional
        .filter((a) => !machineinfo.isHardwareKey(a))
        .map(parseAssignment)
      const hw = args.positional.filter(machineinfo.isHardwareKey)
      if (hw.length > 0) sized = machineinfo.setHardware(name, hw)
      if (parsed.length > 0) writeAssignments(name, parsed)
    } catch (error) {
      console.error(
        `::error::${error instanceof Error ? error.message : String(error)}`,
      )
      return 1
    }
  }
  const eff = effectiveConfig(name)
  const set = readOverrides(name)
  console.log(`instance "${name}":`)
  for (const k of CONFIG_KEYS) {
    const show = (v: unknown): string =>
      typeof v === "string" ? JSON.stringify(v) : String(v)
    const note = Object.hasOwn(set, k)
      ? `(default ${show(DEFAULTS[k])})`
      : "(default)"
    console.log(`  ${k.padEnd(22)} ${show(eff[k]).padEnd(6)} ${note}`)
  }
  if (readMeta(name) !== null)
    for (const l of machineinfo.hardwareLines(name)) console.log(l)
  if (sized !== null) console.log(`\n${sized}`)
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
  "  exec    [-i name] [--qga] -- <cmd>  run a command in the guest (via the agent when installed)\n" +
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
  "  files   open|mount|unmount|status [-i name] [c|home] [--json]   the guest's C:\\ and home folder in Finder,\n" +
  "                                mounted on ~/winvm/<name>/{C,Home}; open mounts if needed (--path GUEST_PATH: a folder in it)\n" +
  "  launch  [-i name] -- <program> [args]         start it on the guest's desktop, detached\n" +
  "  terminal [-i name] [--shell pwsh|powershell|cmd] [--cwd PATH]   a guest shell, in this terminal\n" +
  "          [--connect --json]    print the WebSocket URL and subprotocols for another client\n" +
  "          --shells [--json]     which shells the guest has (PowerShell 7 may be missing)\n" +
  "  smoke   [-i name] [--expect <v> | --expect-file <path>] [--probe <exe>]\n" +
  "  snapshot [-i name] [tag]      capture the running guest, RAM and all\n" +
  "           [--delete]           remove that snapshot instead\n" +
  "  rewind  [-i name] [tag] [--no-watch]  put the guest back: snapshot <tag> (default fresh),\n" +
  "                                else the save of that name (default: the automatic baseline)\n" +
  "  save    [-i name] [name] [--fast]  save the running guest to files (default name: a timestamp)\n" +
  "  load    [-i name] [name] [--no-watch]  load a save, running or stopped (default: the newest)\n" +
  "                                into a stopped instance it starts the watcher, like start\n" +
  "  saves   [-i name] [rm <name>] [--json]  list saves (kind, size, compatible) or delete one (and its note)\n" +
  "  saves note [-i name] <save> [--title T] [--text TEXT|-] [--tags a,b,c] [--clear] [--json]\n" +
  "                                show a save's note, or set it (--text - reads stdin;\n" +
  "                                --text=<markdown> is the safe form when it may start with -)\n" +
  "  golden  create|reset [-i name] [--name golden]  settled mapped-ram save; reset to it in ~1 s\n" +
  "  pause | resume [-i name]      freeze / unfreeze the guest (resume fixes its clock)\n" +
  "  sleep | wake [-i name]        lock Windows, then freeze it as asleep / resume it\n" +
  "  lock    [-i name]             Windows back to its lock screen (sign in again with Enter)\n" +
  "  stow    [-i name]             save and shut QEMU down; the next start recalls it\n" +
  "  clock   [-i name] [--check]   guest-vs-host clock offset, and fix it\n" +
  "  status  [-i name] [--json]    what it's doing; with no -i and several instances, a table.\n" +
  "                                Only reads: it never stops, starts or replaces anything\n" +
  "  reconcile [-i name]           bring the control service and watcher up to this build, restart\n" +
  "                                missing ones and unmount drives a gone guest left; no -i: all\n" +
  "  events  [-i name] [--json]    the instances' event records (QEMU events, operations);\n" +
  "          [--follow] [--since c]  keep following / resume after a line's cursor (or `start`)\n" +
  "  info    [-i name] [--json]    processors, memory and disk (running, and set for the next start),\n" +
  "                                and the network: addresses and the ports forwarded into Windows\n" +
  "  open    [-i name] [--web]     show the screen in Screen Sharing, or (--web) the browser;\n" +
  "          [--json]              or print the VNC ports and password for a client\n" +
  "          [--print]             print the URL instead of opening it\n" +
  "  web     [--port n] [--stop]   the browser view's local server, in the foreground\n" +
  "  screenshot [-i name] [file.png]  save the screen (default: <instance>/screenshots/)\n" +
  '  type    [-i name] "text"      type into the guest (US layout)\n' +
  "  key     [-i name] <combo>...  e.g. ctrl-alt-delete, win-r, enter, f5\n" +
  "  click   [-i name] <x> <y> [--right|--middle] [--double]   screenshot pixels\n" +
  "          [-i name] --text TEXT [--wait S]   OCR the screen, click the middle of TEXT\n" +
  "  ocr     [-i name] [--find TEXT] [--wait S] [--fast] [--json] [--image f.png]\n" +
  "                                the screen's text and boxes (macOS Vision)\n" +
  "  toasts  [-i name] [--since T] [--app A] [--find TEXT] [--wait S] [--json]\n" +
  "                                notifications apps raised (T: ISO time, or 90s/5m/2h ago)\n" +
  "  move    [-i name] <x> <y>     move the pointer\n" +
  "  scroll  [-i name] <n>         n wheel notches, positive is down (or: up|down [n])\n" +
  "  share   [-i name] [status] [--json]   the Mac folder Windows sees as a drive (default Z:)\n" +
  "          [-i name] set PATH [--letter Z] [--readonly] | clear   takes effect at the next start\n" +
  "          [-i name] install [--restart]   set up Windows' side once (restarts Windows)\n" +
  "  display [-i name] [WxH] [--scale PCT]   resize the running screen live (virtio-gpu)\n" +
  "          [-i name] virtio-gpu|ramfb       set a stopped instance's cold-boot display device\n" +
  "                                (new file saves restore on the display they were taken on)\n" +
  "  webview [-i name] enable <exe> | targets | eval <js> | click|wait|text <selector>\n" +
  "                                drive WebView2 windows over DevTools (winvm webview for more)\n" +
  "  ui      [-i name] <verb> [selector]   find and click windows, controls, the tray (winvm ui help)\n" +
  "  cua serve [-i name] [--port N] [--size WxH]   Claude computer-use endpoint on 127.0.0.1 (bearer token)\n" +
  '  cua run [-i name] "<task>" [--model M] [--max-steps N] [--extras]   a computer-use agent loop\n' +
  "  mcp     [-i name]             the guest as an MCP server on stdio, for Claude Code and Claude Desktop\n" +
  "  mcp install|uninstall claude-code|claude-desktop [-i name] [--json]   add it to Claude, or take it out\n" +
  "  mcp status [-i name] [--json] whether Claude Code and Claude Desktop have it\n" +
  "  timemachine [--yes]           exclude the VM files from Time Machine backups\n" +
  "  snapshots [-i name]           list them\n" +
  "  reset   [-i name]             discard changes, back to the base image\n" +
  "  rmi <image> [--force]         remove a base image (undoes its read-only seal)\n" +
  "  prune [--media]               drop leftover build scratch instances, and cached media\n" +
  "  stop | kill [-i name]\n" +
  "  destroy [-i name] [--keep-saves]  remove the instance and its saves\n" +
  "  watch   [-i name]             run the idle watcher in the foreground (start runs it in the background)\n" +
  "          [--stop | --status]   end it / print its state\n" +
  "  config  [-i name] [key=value ...]  autosave/stow/watch settings and the app's title; bare prints them\n" +
  "          [-i name] cpus=N memory=8G  processors and memory, from the next time Windows starts\n" +
  "  settings [key=value ...] [--json]  your own settings, for every instance (viewer.pauseOverlay);\n" +
  "                                in $XDG_CONFIG_HOME/winvm/settings.json (default ~/.config/winvm)\n" +
  "          [--section NAME [--set JSON]]   one part the app keeps there (checkpoints), as JSON\n" +
  "  run     <job.yml>... [-i name] [--golden NAME] [--keep] [--junit f] [--json f] [--artifacts dir]\n" +
  '                                run CI jobs, each from a golden save (instance default "ci")\n' +
  "          [--pool N] [--pool-prefix ci]   on N instances at once (ci-1 … ci-N)\n" +
  "  test    <dir>... [same flags] every *.yml in the directory, in order\n\n" +
  "  state:    WINVM_HOME       (default ~/.local/state/winvm)\n" +
  "  iso:      WINVM_ISO        (else asked once, then remembered)\n" +
  '  instance: WINVM_INSTANCE / -i   (default "default")\n' +
  '  image:    WINVM_IMAGE / --image (default "win11-arm64")\n'
