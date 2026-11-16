import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync } from "node:fs"

import { restoreForward } from "./agentfwd"
import { requireFirmware, tpmTisHasPpi } from "./host"
import { runtimeBin } from "./runtime"
import { ensureService } from "./servicectl"
import type { InstanceMeta, Paths } from "./paths"
import { media } from "./paths"
import type { DisplayConfig } from "./display"
import { RAMFB, displayArgs, readDisplay, runningCommand } from "./display"
import type { Hardware } from "./hardware"
import { readHardware } from "./hardware"
import * as share from "./share"
import * as qga from "./qga"
import * as qmp from "./qmp"
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

export function launchDevices(p: Paths, o: Pick<LaunchOptions, "installMedia" | "display" | "shareDevices">): {
  readonly display: DisplayConfig
  readonly devices: share.DeviceSet
} {
  const display = o.installMedia ? RAMFB : (o.display ?? readDisplay(p))
  return { display, devices: o.shareDevices ?? share.devicesFor(display, o.installMedia) }
}

export function qemuArgs(name: string, p: Paths, meta: InstanceMeta, o: LaunchOptions): readonly string[] {
  const diskBootIndex = o.installMedia ? 1 : 0
  const { display, devices } = launchDevices(p, o)
  const hw = o.hardware ?? readHardware(p)
  const a: string[] = [
    "-name", `winvm-${name}`,
    "-machine", devices === "none" ? "virt,accel=hvf" : share.MACHINE_WITH_SHM,
    "-cpu", "host",
    "-smp", String(hw.cpus),
    "-m", String(hw.memoryMiB),
    "-drive", `if=pflash,format=raw,readonly=on,file=${requireFirmware().code}`,
    "-drive", `if=pflash,format=qcow2,file=${p.vars}`,
    // <https://qemu-project.gitlab.io/qemu/system/devices/usb.html>; the NEC
    // against 10.x <https://gitlab.com/qemu-project/qemu/-/issues/3241>.
    "-device", "qemu-xhci,id=usb-bus",
    "-drive", `if=none,media=disk,id=hd0,file=${p.overlay}`,
    ...(o.virtioBoot
      ? ["-device", `virtio-blk-pci,drive=hd0,bootindex=${String(diskBootIndex)}`]
      : ["-device", `nvme,drive=hd0,serial=winvm,bootindex=${String(diskBootIndex)}`]),
    "-device", "usb-kbd,bus=usb-bus.0",
    "-device", "usb-tablet,bus=usb-bus.0",
    "-netdev", "user,id=net0",
    "-device", "virtio-net-pci,netdev=net0",
    "-device", "virtio-serial",
    "-chardev", `socket,path=${p.qgaQemu},server=on,wait=off,id=${qga.CHARDEV}`,
    "-device", `virtserialport,chardev=${qga.CHARDEV},name=org.qemu.guest_agent.0`,
    "-chardev", `socket,id=chrtpm,path=${p.tpmSock}`,
    "-tpmdev", "emulator,id=tpm0,chardev=chrtpm",
    "-device", `tpm-tis-device,tpmdev=tpm0${tpmTisHasPpi() ? ",ppi=off" : ""}`,
    "-rtc", "base=utc,clock=host",
    ...displayArgs(display),
    ...share.deviceArgs(p, devices, hw.memoryMiB),
    "-display", "none",
    "-vnc", vncArg(meta.vnc),
    "-qmp", `unix:${p.qmpQemu},server=on,wait=off`,
    "-serial", `file:${p.serial}`,
    "-pidfile", p.pid,
  ]
  if (o.ephemeral) a.push("-snapshot")
  if (o.loadvm !== undefined) a.push("-loadvm", o.loadvm)
  if (o.incoming !== undefined) a.push("-incoming", o.incoming)
  if (o.installMedia) {
    a.push(
      // <https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system>.
      "-drive", `if=none,media=disk,id=res0,format=raw,file=${p.result}`,
      "-device", "usb-storage,drive=res0,removable=true,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd0,file=${media.iso()},readonly=on`,
      "-device", "usb-storage,drive=cd0,bootindex=0,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd1,file=${media.tools()},readonly=on`,
      "-device", "usb-storage,drive=cd1,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd2,file=${media.seed()},readonly=on`,
      "-device", "usb-storage,drive=cd2,bus=usb-bus.0",
      "-drive", `if=none,media=disk,id=prime0,file=${p.prime}`,
      "-device", "virtio-blk-pci,drive=prime0",
    )
  }
  return a
}

function swtpmPids(p: Paths): readonly number[] {
  const dir = p.tpmDir.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")
  const r = spawnSync("pgrep", ["-f", `(^|/)swtpm socket --tpmstate dir=${dir} `], { encoding: "utf8" })
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
    } catch {
    }
  }
  rmSync(p.tpmSock, { force: true })
}

export function stopSidecars(p: Paths): void {
  stopSwtpm(p)
  share.stopVirtiofsd(p)
}

async function startSwtpm(p: Paths): Promise<void> {
  stopSwtpm(p)
  for (let i = 0; i < 50 && swtpmPids(p).length > 0; i += 1) await new Promise((r) => setTimeout(r, 20))
  const proc = spawn(
    runtimeBin("swtpm"),
    [
      "socket",
      "--tpmstate",
      `dir=${p.tpmDir}`,
      "--ctrl",
      `type=unixio,path=${p.tpmSock},terminate`,
      "--tpm2",
    ],
    { detached: true, stdio: "ignore" },
  )
  proc.unref()

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(p.tpmSock)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`swtpm never created ${p.tpmSock} — check \`winvm doctor\``)
}

export async function launch(name: string, p: Paths, meta: InstanceMeta, o: LaunchOptions): Promise<void> {
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
  const proc = spawn(runtimeBin("qemu-system-aarch64"), [...qemuArgs(name, p, m, { ...o, display, shareDevices: devices })], {
    detached: true,
    stdio: ["ignore", log, log],
  })
  closeSync(log)
  proc.unref()

  const exited = new Promise<"exited">((res) => proc.on("exit", () => { res("exited") }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const survived = new Promise<"alive">((res) => {
    timer = setTimeout(() => { res("alive") }, 2000)
  })
  let stop = false
  const answering =
    o.incoming === undefined ? new Promise<never>(() => undefined) : monitorAnswers(p, () => stop)
  const outcome = await Promise.race([exited, survived, answering])
  stop = true
  clearTimeout(timer)
  if (outcome === "alive") {
    await applyPassword(p).catch((error: unknown) => {
      console.warn(`warning: could not set the VNC password: ${error instanceof Error ? error.message : String(error)}`)
    })
    await restoreForward(p)
    return
  }

  stopSidecars(p)
  const why = readTextOr(p.qemuLog, "").trim()
  throw new Error(`qemu exited immediately${why === "" ? "" : `:\n  ${why.split("\n").join("\n  ")}`}`)
}

async function monitorAnswers(p: Paths, stopped: () => boolean): Promise<"alive"> {
  while (!stopped()) {
    if (existsSync(p.qmp)) {
      try {
        await qmp.execute(p.qmp, "query-status", undefined, 5000)
        return "alive"
      } catch {
      }
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  return await new Promise<never>(() => undefined)
}

function readTextOr(path: string, fallback: string, encoding: BufferEncoding = "utf8"): string {
  try {
    return readFileSync(path, encoding)
  } catch {
    return fallback
  }
}

export async function waitForSerial(p: Paths, marker: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (readTextOr(p.serial, "", "latin1").replaceAll("\0", "").includes(marker)) return true
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
  /(^|[\s/])qemu-system-[A-Za-z0-9_]+(\s|$)/.test(command) && `${command} `.includes(` -pidfile ${p.pid} `)

export function isInstanceQemu(pid: number, p: Paths, commandOf: (pid: number) => string | null = runningCommand): boolean {
  const command = commandOf(pid)
  return command !== null && isQemuCommandOf(command, p)
}
