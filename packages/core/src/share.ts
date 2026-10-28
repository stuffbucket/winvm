/**
 * The shared folder (virtio-fs) and the clipboard channel: the devices on
 * QEMU's command line, the per-QEMU virtiofsd, and the instance's share
 * settings.
 *
 * ## The devices, and why they are always on
 *
 * A virtio-gpu instance gets three things whether or not it shares a folder:
 *
 *   - guest RAM from `memory-backend-shm,share=on`, so virtiofsd (another
 *     process) can map the virtqueues and buffers;
 *   - `vhost-user-fs-pci` with the fixed tag `winvm`, on a vhost-user socket
 *     in the instance directory, served by virtiofsd;
 *   - the `qemu-vdagent` chardev on a `com.redhat.spice.0` virtio-serial port:
 *     the SPICE agent protocol, which QEMU bridges to the VNC extended
 *     clipboard (noVNC, the app). Windows' side is spice-vdagent.
 *
 * Every one of those is part of the save compatibility hash (saves.ts), so
 * they are fixed: nothing about the share is on QEMU's command line. The
 * daemon serves the chosen folder, or an empty per-instance directory when
 * none is chosen, and adding, changing or removing a share leaves the hash
 * alone. The devices arrived in one step, so saves taken before them stop
 * loading once (saves.strandedByDevices names them).
 *
 * ramfb instances and builds get none of this: a build runs WinPE, and a
 * ramfb instance keeps its command line (and its saves) as it was. A runtime
 * without virtiofsd, vhost-user-fs-pci or qemu-vdagent (before
 * winvm-runtime gained them) gets none of it either: the feature is off and
 * `share` says why.
 *
 * ## The daemon
 *
 * One virtiofsd per QEMU process. It exits when QEMU disconnects, so qemu.ts
 * starts a fresh one before every QEMU (a boot, a load, a recall), like swtpm,
 * and every teardown path stops whatever is left (qemu.stopSidecars). It is
 * found by its command line (`--socket-path <instance>/virtiofsd.sock`), so
 * one instance never touches another's. Its log is `<instance>/virtiofsd.log`;
 * what it serves is recorded in `virtiofsd.json`, so `share status` can tell
 * a change that waits for the next start from one in effect.
 *
 * `--sandbox none`: macOS has no namespaces; `--cache auto`; and
 * `--migration-on-error guest-error`, so a save that names a file the folder
 * no longer has loads anyway and the guest gets an error for that handle
 * instead of the load failing.
 *
 * The control service (service.ts) owns the change notices below for as long
 * as the guest runs; the daemon's lifetime is QEMU's, not the service's.
 */
import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

import type { DisplayConfig } from "./display"
import type { Paths } from "./paths"
import { findRuntime, type Runtime } from "./runtime"

/** The virtio-fs tag: fixed, because the device is part of the hardware hash. */
export const SHARE_TAG = "winvm"
export const DEFAULT_LETTER = "Z"
/** What Explorer calls the drive. The volume's own label is the tag (viofs reports it). */
export const DRIVE_LABEL = "Mac"
/** The guest's RAM, MiB: `-m` and the shared memory backend must agree. */
export const GUEST_MEM_MIB = 4096

export const VDAGENT_CHARDEV = "vdagent"
export const VDAGENT_PORT = "com.redhat.spice.0"

export interface ShareConfig {
  /** An absolute Mac folder. */
  readonly path: string
  /** The Windows drive letter, one of D-Z, without the colon. */
  readonly letter: string
  readonly readonly: boolean
}

export const shareConfigPath = (p: Paths): string => resolve(p.dir, "share.json")
export const emptyShareDir = (p: Paths): string => resolve(p.dir, "share-empty")
export const virtiofsdSocket = (p: Paths): string => resolve(p.dir, "virtiofsd.sock")
export const virtiofsdLog = (p: Paths): string => resolve(p.dir, "virtiofsd.log")
export const virtiofsdState = (p: Paths): string => resolve(p.dir, "virtiofsd.json")

// ---------------------------------------------------------------------------
// Settings

/** "z", "Z", "Z:" -> "Z". A, B and C are not offered: floppies and the system drive. */
export function parseLetter(s: string): string | null {
  const m = /^([A-Za-z]):?$/.exec(s.trim())
  const l = m?.[1]?.toUpperCase()
  return l === undefined || l < "D" ? null : l
}

/** `~` and relative paths made absolute. */
export const expandPath = (s: string, cwd = process.cwd()): string =>
  s === "~" ? homedir() : s.startsWith("~/") ? resolve(homedir(), s.slice(2)) : resolve(cwd, s)

/** Why a folder cannot be shared, or null. */
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
  const path = r["path"]
  if (typeof path !== "string" || !path.startsWith("/")) return null
  const letter = typeof r["letter"] === "string" ? parseLetter(r["letter"]) : null
  return { path, letter: letter ?? DEFAULT_LETTER, readonly: r["readonly"] === true }
}

export function writeShare(p: Paths, cfg: ShareConfig | null): void {
  if (cfg === null) {
    rmSync(shareConfigPath(p), { force: true })
    return
  }
  writeFileSync(shareConfigPath(p), `${JSON.stringify(cfg, null, 2)}\n`)
}

/** What a daemon started now would serve. A shared folder that has gone serves the empty directory. */
export interface Served {
  readonly dir: string
  readonly readonly: boolean
  /** The configured folder, when it is the one served. */
  readonly folder: string | null
  /** Set when a folder is configured but cannot be served. */
  readonly missing?: string
}

export function servedFor(p: Paths, cfg: ShareConfig | null = readShare(p)): Served {
  if (cfg === null) return { dir: emptyShareDir(p), readonly: true, folder: null }
  if (folderError(cfg.path) !== null) return { dir: emptyShareDir(p), readonly: true, folder: null, missing: cfg.path }
  return { dir: cfg.path, readonly: cfg.readonly, folder: cfg.path }
}

/** What the running daemon serves (recorded when it started), or null. */
export function readServing(p: Paths): Served | null {
  try {
    const r = JSON.parse(readFileSync(virtiofsdState(p), "utf8")) as Partial<Served>
    if (typeof r.dir !== "string") return null
    return { dir: r.dir, readonly: r.readonly === true, folder: typeof r.folder === "string" ? r.folder : null }
  } catch {
    return null
  }
}

export const sameServed = (a: Served, b: Served): boolean => a.dir === b.dir && a.readonly === b.readonly

// ---------------------------------------------------------------------------
// The runtime's support, asked once per runtime directory

export interface Support {
  readonly ok: boolean
  /** Plain words: why the shared folder and clipboard are off. */
  readonly reason: string | null
}

export type Probe = (rt: Runtime) => Support

/** QEMU's own answer: `-device help`, `-chardev help`, `-object help`. */
export const probeRuntime: Probe = (rt) => {
  const virtiofsd = resolve(rt.dir, "bin", "virtiofsd")
  if (!existsSync(virtiofsd)) return { ok: false, reason: "this winvm runtime has no virtiofsd; a newer runtime brings the shared folder" }
  const q = resolve(rt.dir, "bin", "qemu-system-aarch64")
  const ask = (...a: string[]): string => {
    const r = spawnSync(q, ["-M", "virt", ...a], { encoding: "utf8" })
    return `${r.stdout ?? ""}${r.stderr ?? ""}`
  }
  return parseSupport(ask("-device", "help"), ask("-chardev", "help"), ask("-object", "help"))
}

export function parseSupport(devices: string, chardevs: string, objects: string): Support {
  const missing: string[] = []
  if (!devices.includes('"vhost-user-fs-pci"')) missing.push("vhost-user-fs-pci")
  if (!/^\s*qemu-vdagent\s*$/m.test(chardevs)) missing.push("qemu-vdagent")
  if (!/^\s*memory-backend-shm\s*$/m.test(objects)) missing.push("memory-backend-shm")
  return missing.length === 0
    ? { ok: true, reason: null }
    : { ok: false, reason: `this winvm runtime's QEMU lacks ${missing.join(", ")}; a newer runtime brings the shared folder` }
}

const supportCache = new Map<string, Support>()
let probe: Probe = probeRuntime

/** Tests swap the probe; production asks QEMU. Returns the previous one. */
export function setProbe(p: Probe): Probe {
  const prev = probe
  probe = p
  supportCache.clear()
  return prev
}

export function runtimeSupport(rt: Runtime | null = findRuntime()): Support {
  if (rt === null) return { ok: false, reason: "winvm's runtime is not installed" }
  const hit = supportCache.get(rt.dir)
  if (hit !== undefined) return hit
  const s = probe(rt)
  supportCache.set(rt.dir, s)
  return s
}

/**
 * Which of the devices go on a command line:
 *
 *   all   virtio-gpu instances: memory backend, virtio-fs and the clipboard port.
 *   fs    builds: memory backend and virtio-fs only, so provisioning binds viofs
 *         to the device while the display is ramfb (see viofs-install.ps1).
 *         The base image then carries the device installed, and an instance's
 *         first boot on virtio-gpu finds nothing new to install.
 *   none  ramfb instances, and any runtime without the pieces.
 */
export type DeviceSet = "none" | "fs" | "all"

export function devicesFor(display: DisplayConfig, installMedia: boolean, support: Support = runtimeSupport()): DeviceSet {
  if (!support.ok) return "none"
  if (installMedia) return "fs"
  return display.device === "virtio-gpu" ? "all" : "none"
}

/** Why this instance has no shared folder or clipboard, or null. */
export function unavailableReason(display: DisplayConfig, support: Support = runtimeSupport()): string | null {
  if (!support.ok) return support.reason
  if (display.device !== "virtio-gpu") {
    return "this Windows machine uses the fixed 800x600 display; the shared folder needs the resizable one (winvm display virtio-gpu)"
  }
  return null
}

// ---------------------------------------------------------------------------
// QEMU arguments

/** `-machine` for a machine with the shared memory backend. */
export const MACHINE_WITH_SHM = "virt,accel=hvf,memory-backend=mem"

/**
 * The device arguments. Fixed: the socket path is per instance, and hardwareArgs
 * (saves.ts) blanks `path=` values, so the hash is the same for every instance.
 * The clipboard port joins the existing virtio-serial bus (the guest agent's).
 */
export function deviceArgs(p: Paths, set: DeviceSet): readonly string[] {
  if (set === "none") return []
  return [
    "-object", `memory-backend-shm,id=mem,size=${String(GUEST_MEM_MIB)}M,share=on`,
    "-chardev", `socket,id=vfs0,path=${virtiofsdSocket(p)}`,
    // queue-size 1024: virtiofsd's maximum, and what the spike measured
    // (668 MiB/s write, 1359 MiB/s read in the guest).
    // addr: a fixed PCI slot, clear of the slots QEMU hands out in order, so
    // Windows sees one device (one instance ID, its driver bound once) on a
    // build, on the ramfb boot of `share install` and on virtio-gpu alike.
    "-device", `vhost-user-fs-pci,chardev=vfs0,tag=${SHARE_TAG},queue-size=1024,addr=0x10`,
    ...(set === "all"
      ? [
          "-chardev", `qemu-vdagent,id=${VDAGENT_CHARDEV},clipboard=on,mouse=off`,
          "-device", `virtserialport,chardev=${VDAGENT_CHARDEV},name=${VDAGENT_PORT}`,
        ]
      : []),
  ]
}

// ---------------------------------------------------------------------------
// The daemon

export function daemonArgs(p: Paths, s: Served): readonly string[] {
  return [
    "--shared-dir", s.dir,
    "--socket-path", virtiofsdSocket(p),
    "--sandbox", "none",
    "--cache", "auto",
    "--migration-on-error", "guest-error",
    ...(s.readonly ? ["--readonly"] : []),
    // WINVM_VIRTIOFSD_LOG=debug (or trace) when diagnosing the shared folder.
    ...(process.env["WINVM_VIRTIOFSD_LOG"] ? ["--log-level", process.env["WINVM_VIRTIOFSD_LOG"]] : []),
  ]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")

/** This instance's virtiofsd processes, by the socket on their command line. */
export function virtiofsdPids(p: Paths): readonly number[] {
  const r = spawnSync("pgrep", ["-f", `(^|/)virtiofsd .*--socket-path ${escapeRe(virtiofsdSocket(p))}( |$)`], { encoding: "utf8" })
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((l) => Number.parseInt(l, 10))
    .filter((n) => Number.isFinite(n) && n !== process.pid)
}

/** Stop this instance's virtiofsd, if any is left. Every teardown path calls it (qemu.stopSidecars). */
export function stopVirtiofsd(p: Paths): void {
  for (const pid of virtiofsdPids(p)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // gone between the listing and the signal
    }
  }
  rmSync(virtiofsdSocket(p), { force: true })
  // virtiofsd's own pid file, beside its socket.
  rmSync(`${virtiofsdSocket(p)}.pid`, { force: true })
  rmSync(virtiofsdState(p), { force: true })
}

export interface StartOptions {
  /** The daemon's binary; default the runtime's. */
  readonly bin?: string
  readonly timeoutMs?: number
}

/**
 * Start a fresh virtiofsd for the next QEMU and wait for its socket: QEMU
 * connects while parsing its command line, and a chardev that cannot connect
 * ends the launch. Anything left from an earlier QEMU goes first.
 */
export async function startVirtiofsd(p: Paths, o: StartOptions = {}): Promise<Served> {
  stopVirtiofsd(p)
  for (let i = 0; i < 50 && virtiofsdPids(p).length > 0; i += 1) await new Promise((r) => setTimeout(r, 20))
  const served = servedFor(p)
  mkdirSync(emptyShareDir(p), { recursive: true })
  const bin = o.bin ?? resolve(findRuntime()?.dir ?? "", "bin", "virtiofsd")
  const log = openSync(virtiofsdLog(p), "a")
  writeFileSync(log, `--- ${new Date().toISOString()} serving ${served.dir}${served.readonly ? " (read-only)" : ""}\n`)
  if (served.missing !== undefined) writeFileSync(log, `the shared folder ${served.missing} is missing; serving an empty folder\n`)
  const proc = spawn(bin, [...daemonArgs(p, served)], { detached: true, stdio: ["ignore", log, log] })
  closeSync(log)
  proc.unref()
  let exited = false
  proc.on("exit", () => {
    exited = true
  })
  const deadline = Date.now() + (o.timeoutMs ?? 10_000)
  while (Date.now() < deadline) {
    if (existsSync(virtiofsdSocket(p))) {
      writeFileSync(virtiofsdState(p), `${JSON.stringify({ ...served, pid: proc.pid }, null, 2)}\n`)
      return served
    }
    if (exited) break
    await new Promise((r) => setTimeout(r, 20))
  }
  stopVirtiofsd(p)
  let tail = ""
  try {
    tail = readFileSync(virtiofsdLog(p), "utf8").trim().split("\n").slice(-3).join("\n  ")
  } catch {
    // no log
  }
  throw new Error(`virtiofsd did not start (the shared folder's daemon)${tail === "" ? "" : `:\n  ${tail}`}`)
}
