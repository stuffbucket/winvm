import { spawn, spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

import type { DisplayConfig } from "./display"
import type { Paths } from "./paths"
import { findRuntime, type Runtime } from "./runtime"
import { spawnText } from "./shell"

export const SHARE_TAG = "winvm"
export const DEFAULT_LETTER = "Z"
export const DRIVE_LABEL = "Mac"
export const VDAGENT_CHARDEV = "vdagent"
export const VDAGENT_PORT = "com.redhat.spice.0"

export interface ShareConfig {
  readonly path: string
  readonly letter: string
  readonly readonly: boolean
}

export const shareConfigPath = (p: Paths): string =>
  resolve(p.dir, "share.json")
export const emptyShareDir = (p: Paths): string => resolve(p.dir, "share-empty")
export const virtiofsdSocket = (p: Paths): string =>
  resolve(p.dir, "virtiofsd.sock")
export const virtiofsdLog = (p: Paths): string =>
  resolve(p.dir, "virtiofsd.log")
export const virtiofsdState = (p: Paths): string =>
  resolve(p.dir, "virtiofsd.json")

export function parseLetter(s: string): string | null {
  const m = /^([A-Za-z]):?$/.exec(s.trim())
  const l = m?.[1]?.toUpperCase()
  return l === undefined || l < "D" ? null : l
}

export const expandPath = (s: string, cwd = process.cwd()): string =>
  s === "~"
    ? homedir()
    : s.startsWith("~/")
      ? resolve(homedir(), s.slice(2))
      : resolve(cwd, s)

export function folderError(path: string): string | null {
  try {
    if (!statSync(path).isDirectory()) return `${path} is not a folder`
  } catch {
    return `${path} does not exist`
  }
  return null
}

export function readShare(p: Paths): ShareConfig | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(shareConfigPath(p), "utf8"))
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  const path = r.path
  if (typeof path !== "string" || !path.startsWith("/")) return null
  const letter = typeof r.letter === "string" ? parseLetter(r.letter) : null
  return {
    path,
    letter: letter ?? DEFAULT_LETTER,
    readonly: r.readonly === true,
  }
}

export function writeShare(p: Paths, cfg: ShareConfig | null): void {
  if (cfg === null) {
    rmSync(shareConfigPath(p), { force: true })
    return
  }
  writeFileSync(shareConfigPath(p), `${JSON.stringify(cfg, null, 2)}\n`)
}

export interface Served {
  readonly dir: string
  readonly readonly: boolean
  readonly folder: string | null
  readonly missing?: string
}

export function servedFor(
  p: Paths,
  cfg: ShareConfig | null = readShare(p),
): Served {
  if (cfg === null)
    return { dir: emptyShareDir(p), readonly: true, folder: null }
  if (folderError(cfg.path) !== null)
    return {
      dir: emptyShareDir(p),
      readonly: true,
      folder: null,
      missing: cfg.path,
    }
  return { dir: cfg.path, readonly: cfg.readonly, folder: cfg.path }
}

export function readServing(p: Paths): Served | null {
  try {
    const r = JSON.parse(
      readFileSync(virtiofsdState(p), "utf8"),
    ) as Partial<Served>
    if (typeof r.dir !== "string") return null
    return {
      dir: r.dir,
      readonly: r.readonly === true,
      folder: typeof r.folder === "string" ? r.folder : null,
    }
  } catch {
    return null
  }
}

export const sameServed = (a: Served, b: Served): boolean =>
  a.dir === b.dir && a.readonly === b.readonly

export interface Support {
  readonly ok: boolean
  readonly reason: string | null
}

export type Probe = (rt: Runtime) => Support

export const probeRuntime: Probe = (rt) => {
  const virtiofsd = resolve(rt.dir, "bin", "virtiofsd")
  if (!existsSync(virtiofsd))
    return {
      ok: false,
      reason:
        "this winvm runtime has no virtiofsd; a newer runtime brings the shared folder",
    }
  const q = resolve(rt.dir, "bin", "qemu-system-aarch64")
  const ask = (...a: string[]): string => {
    const r = spawnText(q, ["-M", "virt", ...a])
    return `${r.stdout}${r.stderr}`
  }
  return parseSupport(
    ask("-device", "help"),
    ask("-chardev", "help"),
    ask("-object", "help"),
  )
}

export function parseSupport(
  devices: string,
  chardevs: string,
  objects: string,
): Support {
  const missing: string[] = []
  if (!devices.includes('"vhost-user-fs-pci"'))
    missing.push("vhost-user-fs-pci")
  if (!/^\s*qemu-vdagent\s*$/m.test(chardevs)) missing.push("qemu-vdagent")
  if (!/^\s*memory-backend-shm\s*$/m.test(objects))
    missing.push("memory-backend-shm")
  return missing.length === 0
    ? { ok: true, reason: null }
    : {
        ok: false,
        reason: `this winvm runtime's QEMU lacks ${missing.join(", ")}; a newer runtime brings the shared folder`,
      }
}

const supportCache = new Map<string, Support>()
let probe: Probe = probeRuntime

export function setProbe(p: Probe): Probe {
  const prev = probe
  probe = p
  supportCache.clear()
  return prev
}

export function runtimeSupport(rt: Runtime | null = findRuntime()): Support {
  if (rt === null)
    return { ok: false, reason: "winvm's runtime is not installed" }
  const hit = supportCache.get(rt.dir)
  if (hit !== undefined) return hit
  const s = probe(rt)
  supportCache.set(rt.dir, s)
  return s
}

export type DeviceSet = "none" | "fs" | "all"

export function devicesFor(
  display: DisplayConfig,
  installMedia: boolean,
  support: Support = runtimeSupport(),
): DeviceSet {
  if (!support.ok) return "none"
  if (installMedia) return "fs"
  return display.device === "virtio-gpu" ? "all" : "none"
}

export function unavailableReason(
  display: DisplayConfig,
  support: Support = runtimeSupport(),
): string | null {
  if (!support.ok) return support.reason
  if (display.device !== "virtio-gpu") {
    return "this Windows machine uses the fixed 800x600 display; the shared folder needs the resizable one (winvm display virtio-gpu)"
  }
  return null
}

export const MACHINE_WITH_SHM = "virt,accel=hvf,memory-backend=mem"

export function deviceArgs(
  p: Paths,
  set: DeviceSet,
  memoryMiB: number,
): readonly string[] {
  if (set === "none") return []
  return [
    "-object",
    `memory-backend-shm,id=mem,size=${String(memoryMiB)}M,share=on`,
    "-chardev",
    `socket,id=vfs0,path=${virtiofsdSocket(p)}`,
    "-device",
    `vhost-user-fs-pci,chardev=vfs0,tag=${SHARE_TAG},queue-size=1024,addr=0x10`,
    ...(set === "all"
      ? [
          "-chardev",
          `qemu-vdagent,id=${VDAGENT_CHARDEV},clipboard=on,mouse=off`,
          "-device",
          `virtserialport,chardev=${VDAGENT_CHARDEV},name=${VDAGENT_PORT}`,
        ]
      : []),
  ]
}

export function daemonArgs(p: Paths, s: Served): readonly string[] {
  return [
    "--shared-dir",
    s.dir,
    "--socket-path",
    virtiofsdSocket(p),
    "--sandbox",
    "none",
    "--cache",
    "auto",
    "--migration-on-error",
    "guest-error",
    ...(s.readonly ? ["--readonly"] : []),
    ...(process.env.WINVM_VIRTIOFSD_LOG
      ? ["--log-level", process.env.WINVM_VIRTIOFSD_LOG]
      : []),
  ]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")

export function virtiofsdPids(p: Paths): readonly number[] {
  const r = spawnSync(
    "pgrep",
    [
      "-f",
      `(^|/)virtiofsd .*--socket-path ${escapeRe(virtiofsdSocket(p))}( |$)`,
    ],
    { encoding: "utf8" },
  )
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((l) => Number.parseInt(l, 10))
    .filter((n) => Number.isFinite(n) && n !== process.pid)
}

export function stopVirtiofsd(p: Paths): void {
  for (const pid of virtiofsdPids(p)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  rmSync(virtiofsdSocket(p), { force: true })
  rmSync(`${virtiofsdSocket(p)}.pid`, { force: true })
  rmSync(virtiofsdState(p), { force: true })
}

export interface StartOptions {
  readonly bin?: string
  readonly timeoutMs?: number
}

export interface DaemonLaunch {
  readonly argv: readonly string[]
  readonly log: string
  readonly served: Served
}

export function prepareVirtiofsd(p: Paths, bin?: string): DaemonLaunch {
  const served = servedFor(p)
  mkdirSync(emptyShareDir(p), { recursive: true })
  const log = openSync(virtiofsdLog(p), "a")
  writeFileSync(
    log,
    `--- ${new Date().toISOString()} serving ${served.dir}${served.readonly ? " (read-only)" : ""}\n`,
  )
  if (served.missing !== undefined)
    writeFileSync(
      log,
      `the shared folder ${served.missing} is missing; serving an empty folder\n`,
    )
  closeSync(log)
  return {
    argv: [
      bin ?? resolve(findRuntime()?.dir ?? "", "bin", "virtiofsd"),
      ...daemonArgs(p, served),
    ],
    log: virtiofsdLog(p),
    served,
  }
}

export async function untilServing(
  p: Paths,
  launched: { readonly served: Served; readonly pid: number | undefined },
  exited: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<Served> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(virtiofsdSocket(p))) {
      writeFileSync(
        virtiofsdState(p),
        `${JSON.stringify({ ...launched.served, pid: launched.pid }, null, 2)}\n`,
      )
      return launched.served
    }
    if (await exited()) break
    await new Promise((r) => setTimeout(r, 20))
  }
  stopVirtiofsd(p)
  let tail = ""
  try {
    tail = readFileSync(virtiofsdLog(p), "utf8")
      .trim()
      .split("\n")
      .slice(-3)
      .join("\n  ")
  } catch {}
  throw new Error(
    `virtiofsd did not start (the shared folder's daemon)${tail === "" ? "" : `:\n  ${tail}`}`,
  )
}

export async function startVirtiofsd(
  p: Paths,
  o: StartOptions = {},
): Promise<Served> {
  stopVirtiofsd(p)
  for (let i = 0; i < 50 && virtiofsdPids(p).length > 0; i += 1)
    await new Promise((r) => setTimeout(r, 20))
  const daemon = prepareVirtiofsd(p, o.bin)
  const log = openSync(daemon.log, "a")
  const [bin = "", ...args] = daemon.argv
  const proc = spawn(bin, args, {
    detached: true,
    stdio: ["ignore", log, log],
  })
  closeSync(log)
  proc.unref()
  let exited = false as boolean
  proc.on("exit", () => {
    exited = true
  })
  return await untilServing(
    p,
    { served: daemon.served, pid: proc.pid },
    () => exited,
    o.timeoutMs,
  )
}
