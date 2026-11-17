import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
  spawnSync,
} from "node:child_process"
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs"

import { restoreForward } from "./agentfwd"
import type { DisplayConfig } from "./display"
import { displayArgs, RAMFB, readDisplay, runningCommand } from "./display"
import type { Hardware } from "./hardware"
import { readHardware } from "./hardware"
import { requireFirmware, tpmTisHasPpi } from "./host"
import { type FoundKeeper, KeeperBusy, type KeeperChild } from "./keeper"
import * as kept from "./kept"
import { LeaseNotHeld } from "./operation"
import type { InstanceMeta, Paths } from "./paths"
import { media } from "./paths"
import * as qga from "./qga"
import * as qmp from "./qmp"
import { runtimeBin } from "./runtime"
import { ensureService } from "./servicectl"
import * as share from "./share"
import { applyPassword, ensureFreeDisplay, vncArg } from "./vnc"

export interface LaunchOptions {
  readonly installMedia: boolean
  readonly ephemeral: boolean
  readonly virtioBoot: boolean
  readonly loadvm?: string
  readonly incoming?: string
  readonly shareDevices?: share.DeviceSet
  readonly display?: DisplayConfig
  readonly hardware?: Hardware
}

export function launchDevices(
  p: Paths,
  o: Pick<LaunchOptions, "installMedia" | "display" | "shareDevices">,
): {
  readonly display: DisplayConfig
  readonly devices: share.DeviceSet
} {
  const display = o.installMedia ? RAMFB : (o.display ?? readDisplay(p))
  return {
    display,
    devices: o.shareDevices ?? share.devicesFor(display, o.installMedia),
  }
}

export function qemuArgs(
  name: string,
  p: Paths,
  meta: InstanceMeta,
  o: LaunchOptions,
): readonly string[] {
  const diskBootIndex = o.installMedia ? 1 : 0
  const { display, devices } = launchDevices(p, o)
  const hw = o.hardware ?? readHardware(p)
  const a: string[] = [
    "-name",
    `winvm-${name}`,
    "-machine",
    devices === "none" ? "virt,accel=hvf" : share.MACHINE_WITH_SHM,
    "-cpu",
    "host",
    "-smp",
    String(hw.cpus),
    "-m",
    String(hw.memoryMiB),
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${requireFirmware().code}`,
    "-drive",
    `if=pflash,format=qcow2,file=${p.vars}`,
    // <https://qemu-project.gitlab.io/qemu/system/devices/usb.html>; the NEC
    // against 10.x <https://gitlab.com/qemu-project/qemu/-/issues/3241>.
    "-device",
    "qemu-xhci,id=usb-bus",
    "-drive",
    `if=none,media=disk,id=hd0,file=${p.overlay}`,
    ...(o.virtioBoot
      ? [
          "-device",
          `virtio-blk-pci,drive=hd0,bootindex=${String(diskBootIndex)}`,
        ]
      : [
          "-device",
          `nvme,drive=hd0,serial=winvm,bootindex=${String(diskBootIndex)}`,
        ]),
    "-device",
    "usb-kbd,bus=usb-bus.0",
    "-device",
    "usb-tablet,bus=usb-bus.0",
    "-netdev",
    "user,id=net0",
    "-device",
    "virtio-net-pci,netdev=net0",
    "-device",
    "virtio-serial",
    "-chardev",
    `socket,path=${p.qgaQemu},server=on,wait=off,id=${qga.CHARDEV}`,
    "-device",
    `virtserialport,chardev=${qga.CHARDEV},name=org.qemu.guest_agent.0`,
    "-chardev",
    `socket,id=chrtpm,path=${p.tpmSock}`,
    "-tpmdev",
    "emulator,id=tpm0,chardev=chrtpm",
    "-device",
    `tpm-tis-device,tpmdev=tpm0${tpmTisHasPpi() ? ",ppi=off" : ""}`,
    "-rtc",
    "base=utc,clock=host",
    ...displayArgs(display),
    ...share.deviceArgs(p, devices, hw.memoryMiB),
    "-display",
    "none",
    "-vnc",
    vncArg(meta.vnc),
    "-qmp",
    `unix:${p.qmpQemu},server=on,wait=off`,
    "-serial",
    `file:${p.serial}`,
    "-pidfile",
    p.pid,
  ]
  if (o.ephemeral) a.push("-snapshot")
  if (o.loadvm !== undefined) a.push("-loadvm", o.loadvm)
  if (o.incoming !== undefined) a.push("-incoming", o.incoming)
  if (o.installMedia) {
    a.push(
      // <https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system>.
      "-drive",
      `if=none,media=disk,id=res0,format=raw,file=${p.result}`,
      "-device",
      "usb-storage,drive=res0,removable=true,bus=usb-bus.0",
      "-drive",
      `if=none,media=cdrom,id=cd0,file=${media.iso()},readonly=on`,
      "-device",
      "usb-storage,drive=cd0,bootindex=0,bus=usb-bus.0",
      "-drive",
      `if=none,media=cdrom,id=cd1,file=${media.tools()},readonly=on`,
      "-device",
      "usb-storage,drive=cd1,bus=usb-bus.0",
      "-drive",
      `if=none,media=cdrom,id=cd2,file=${media.seed()},readonly=on`,
      "-device",
      "usb-storage,drive=cd2,bus=usb-bus.0",
      "-drive",
      `if=none,media=disk,id=prime0,file=${p.prime}`,
      "-device",
      "virtio-blk-pci,drive=prime0",
    )
  }
  return a
}

export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

let spawner: Spawner = spawn

export function setSpawner(next: Spawner = spawn): Spawner {
  const previous = spawner
  spawner = next
  return previous
}

function swtpmPids(p: Paths): readonly number[] {
  const dir = p.tpmDir.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")
  const r = spawnSync(
    "pgrep",
    ["-f", `(^|/)swtpm socket --tpmstate dir=${dir} `],
    { encoding: "utf8" },
  )
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((l) => Number.parseInt(l, 10))
    .filter((n) => Number.isFinite(n))
}

export function stopSwtpm(p: Paths): void {
  for (const pid of swtpmPids(p)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  rmSync(p.tpmSock, { force: true })
}

export function stopSidecars(p: Paths): void {
  stopSwtpm(p)
  share.stopVirtiofsd(p)
}

const swtpmArgs = (p: Paths): readonly string[] => [
  "socket",
  "--tpmstate",
  `dir=${p.tpmDir}`,
  "--ctrl",
  `type=unixio,path=${p.tpmSock},terminate`,
  "--tpm2",
]

async function untilFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

async function startSwtpm(p: Paths): Promise<void> {
  stopSwtpm(p)
  for (let i = 0; i < 50 && swtpmPids(p).length > 0; i += 1)
    await new Promise((r) => setTimeout(r, 20))
  const proc = spawner(runtimeBin("swtpm"), [...swtpmArgs(p)], {
    detached: true,
    stdio: "ignore",
  })
  proc.unref()
  if (!(await untilFile(p.tpmSock, 10_000))) throw swtpmMissing(p)
}

const swtpmMissing = (p: Paths): Error =>
  new Error(`swtpm never created ${p.tpmSock} — check \`winvm doctor\``)

export type Settle = (survived: () => void) => () => void

const SETTLE_MS = 2000
const settleByClock: Settle = (survived) => {
  const timer = setTimeout(survived, SETTLE_MS)
  return () => {
    clearTimeout(timer)
  }
}
let settle: Settle = settleByClock

export function setSettle(next: Settle = settleByClock): Settle {
  const previous = settle
  settle = next
  return previous
}

export async function launch(
  name: string,
  p: Paths,
  meta: InstanceMeta,
  o: LaunchOptions,
): Promise<void> {
  const use = kept.keeperUse()
  if (use.kind === "keeper") {
    const failed = await kept.openKeeper(name, p, use.keeper).then(
      () => null,
      (error: unknown) => error,
    )
    if (failed === null) {
      await launchKept(name, p, meta, o, use.keeper)
      return
    }
    if (failed instanceof LeaseNotHeld || failed instanceof KeeperBusy)
      throw failed
    console.warn(
      `warning: winvm's keeper did not start (${failed instanceof Error ? failed.message : String(failed)}); starting QEMU without it, so it is not protected if the Mac shuts down`,
    )
  }
  await startSwtpm(p)
  const { display, devices } = launchDevices(p, o)
  if (devices !== "none") {
    try {
      await share.startVirtiofsd(p)
    } catch (error) {
      stopSidecars(p)
      throw error
    }
  }
  if (existsSync(p.serial)) renameSync(p.serial, p.serialPrev)
  rmSync(p.qemuLog, { force: true })
  if (o.incoming !== undefined) rmSync(p.qmpQemu, { force: true })
  await ensureService(name, p)
  const m = await ensureFreeDisplay(name, p, meta)

  const log = openSync(p.qemuLog, "w")
  const proc = spawner(
    runtimeBin("qemu-system-aarch64"),
    [...qemuArgs(name, p, m, { ...o, display, shareDevices: devices })],
    {
      detached: true,
      stdio: ["ignore", log, log],
    },
  )
  closeSync(log)
  proc.unref()

  const exited = new Promise<"exited">((res) =>
    proc.on("exit", () => {
      res("exited")
    }),
  )
  if ((await settled(p, o, exited)) === "alive") {
    await afterLaunch(p)
    return
  }

  stopSidecars(p)
  throw exitedImmediately(p)
}

const REAPED_MS = 5000

async function launchKept(
  name: string,
  p: Paths,
  meta: InstanceMeta,
  o: LaunchOptions,
  keeper: FoundKeeper,
): Promise<void> {
  const { display, devices } = launchDevices(p, o)
  const still = await kept.untilChildGone(p, REAPED_MS)
  if (still !== null)
    throw new Error(
      `winvm's keeper still runs QEMU (pid ${String(still.pid)}) for "${name}"; \`winvm kill -i ${name}\` ends it`,
    )
  if (existsSync(p.serial)) renameSync(p.serial, p.serialPrev)
  rmSync(p.qemuLog, { force: true })
  if (o.incoming !== undefined) rmSync(p.qmpQemu, { force: true })
  await ensureService(name, p)
  const m = await ensureFreeDisplay(name, p, meta)
  await kept.openKeeper(name, p, keeper)
  stopSidecars(p)
  const env = keptEnv()
  const umask = process.umask()
  const sidecar = async (
    child: KeeperChild & { readonly name: string },
  ): Promise<number> => {
    const spec = { ...child, umask }
    try {
      return await kept.launchSidecar(p, spec)
    } catch (error) {
      if (error instanceof kept.KeeperRefused) throw error
      await kept.openKeeper(name, p, keeper)
      return await kept.launchSidecar(p, spec)
    }
  }
  try {
    await sidecar({
      name: "swtpm",
      argv: [runtimeBin("swtpm"), ...swtpmArgs(p)],
      env,
    })
    if (!(await untilFile(p.tpmSock, 10_000))) throw swtpmMissing(p)
    if (devices !== "none") {
      const daemon = share.prepareVirtiofsd(p)
      const pid = await sidecar({
        name: "virtiofsd",
        argv: daemon.argv,
        env,
        log: daemon.log,
      })
      await share.untilServing(
        p,
        { served: daemon.served, pid },
        async () =>
          !((await kept.keeperHello(p))?.sidecars ?? []).some(
            (s) => s.pid === pid,
          ),
      )
    }
  } catch (error) {
    await kept.killKept(p, null)
    throw error
  }

  const monitor = kept.keeperMonitor(p)
  const pid = await kept.launchChild(p, {
    name: "qemu",
    argv: [
      runtimeBin("qemu-system-aarch64"),
      ...qemuArgs(name, p, m, { ...o, display, shareDevices: devices }),
      "-qmp",
      `unix:${monitor},server=on,wait=off`,
    ],
    env,
    log: p.qemuLog,
    pidfile: p.pid,
    qmp: monitor,
    umask,
  })
  let gone = false
  const exited = (async (): Promise<"exited"> => {
    while (!gone) {
      const hello = await kept.keeperHello(p)
      if (hello !== null && hello.child?.pid !== pid) return "exited"
      await new Promise((r) => setTimeout(r, 50))
    }
    return await new Promise<never>(() => undefined)
  })()
  const outcome = await settled(p, o, exited)
  gone = true
  if (outcome === "alive") {
    await afterLaunch(p)
    return
  }
  await kept.killKept(p, null)
  throw exitedImmediately(p)
}

const keptEnv = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )

async function settled(
  p: Paths,
  o: LaunchOptions,
  exited: Promise<"exited">,
): Promise<"alive" | "exited"> {
  let unsettle = (): void => undefined
  const survived = new Promise<"alive">((res) => {
    unsettle = settle(() => {
      res("alive")
    })
  })
  let stop = false
  const answering =
    o.incoming === undefined
      ? new Promise<never>(() => undefined)
      : monitorAnswers(p, () => stop)
  const outcome = await Promise.race([exited, survived, answering])
  stop = true
  unsettle()
  return outcome
}

async function afterLaunch(p: Paths): Promise<void> {
  await applyPassword(p).catch((error: unknown) => {
    console.warn(
      `warning: could not set the VNC password: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  await restoreForward(p)
}

function exitedImmediately(p: Paths): Error {
  const why = readTextOr(p.qemuLog, "").trim()
  return new Error(
    `qemu exited immediately${why === "" ? "" : `:\n  ${why.split("\n").join("\n  ")}`}`,
  )
}

async function monitorAnswers(
  p: Paths,
  stopped: () => boolean,
): Promise<"alive"> {
  while (!stopped()) {
    if (existsSync(p.qmp)) {
      try {
        await qmp.execute(p.qmp, "query-status", undefined, 5000)
        return "alive"
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  return await new Promise<never>(() => undefined)
}

function readTextOr(
  path: string,
  fallback: string,
  encoding: BufferEncoding = "utf8",
): string {
  try {
    return readFileSync(path, encoding)
  } catch {
    return fallback
  }
}

export async function waitForSerial(
  p: Paths,
  marker: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (
      readTextOr(p.serial, "", "latin1").replaceAll("\0", "").includes(marker)
    )
      return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

export function pidOf(p: Paths): number | null {
  let text: string
  try {
    text = readFileSync(p.pid, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const pid = Number.parseInt(text.trim(), 10)
  if (!Number.isFinite(pid)) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    rmSync(p.pid, { force: true })
    return null
  }
}

export const isRunning = (p: Paths): boolean => pidOf(p) !== null

export const isQemuCommandOf = (command: string, p: Paths): boolean =>
  /(^|[\s/])qemu-system-[A-Za-z0-9_]+(\s|$)/.test(command) &&
  `${command} `.includes(` -pidfile ${p.pid} `)

export function isInstanceQemu(
  pid: number,
  p: Paths,
  commandOf: (pid: number) => string | null = runningCommand,
): boolean {
  const command = commandOf(pid)
  return command !== null && isQemuCommandOf(command, p)
}
