/**
 * The guest's display device.
 *
 * ## virtio-gpu, resizable while it runs (the default for new instances)
 *
 * `virtio-gpu-pci` with FIXED arguments: no size on the command line, ever.
 * The screen's size is set live instead, in two steps (guestdisplay.ts):
 *
 *   1. A VNC SetDesktopSize request. QEMU forwards it to virtio-gpu
 *      (qemu_console_set_ui_info), which tells the guest a display change
 *      happened; Windows' viogpudo driver then offers exactly that size as a
 *      mode. It does not switch to it by itself.
 *   2. The in-guest agent's display helper (assets/winvm-display.cs) waits for
 *      the mode to appear and sets it with ChangeDisplaySettingsEx, in the
 *      logged-on session. QEMU's framebuffer follows within ~80 ms.
 *
 * Windows' display scaling (100/200%) is set the same way, live, no sign-out.
 * Keeping the size off the command line keeps the save compatibility hash
 * (saves.ts) the same whatever size the guest is: a save restores into the
 * size it was taken at, and the viewer asks for its own size again after.
 * Sizes are bounded by displayfit.ts (30 MiB framebuffer, VNC's 5120x2160).
 *
 * ## ramfb (instances created before virtio-gpu was the default; builds)
 *
 * A plain framebuffer in guest RAM that the firmware sets up; EDK2's ramfb
 * driver always starts it at 800x600 (OvmfPkg/QemuRamfbDxe) and Windows'
 * Basic Display driver cannot change it. QEMU cannot resize it either (no
 * ui_info: SetDesktopSize is refused). A build always uses ramfb: WinPE has no
 * virtio-gpu driver.
 *
 * ## Switching
 *
 * display.json is the COLD-BOOT PREFERENCE: what the next `start` launches. The
 * device is part of the machine, and a save only loads into the same machine,
 * so a file save (saves.ts) records the display its QEMU was actually running
 * (Manifest.display, read off the process by `runningDisplay`) and `load`
 * launches with exactly that, whatever the preference is now, without touching
 * display.json. Switching an instance's device therefore strands only what has
 * no such record: internal snapshots, and file saves from before the record
 * (QEMU refuses them on another device; nothing is corrupted). That is why
 * existing instances keep their device until switched with `winvm display virtio-gpu`
 * or `winvm display ramfb`, and only while stopped. An instance switched to
 * virtio-gpu by an earlier winvm has a size in its display.json; it keeps
 * that size on its command line (so its saves still load) until switched
 * again.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Paths } from "./paths"

export type DisplayConfig =
  | { readonly device: "ramfb" }
  | {
      readonly device: "virtio-gpu"
      /** Set only for an instance switched by an earlier winvm, whose saves have it on the command line. */
      readonly legacySize?: { readonly width: number; readonly height: number }
    }

export const RAMFB: DisplayConfig = { device: "ramfb" }
export const VIRTIO_GPU: DisplayConfig = { device: "virtio-gpu" }

export const displayPath = (p: Paths): string => resolve(p.dir, "display.json")

/** The instance's display; ramfb when it has never been set (instances older than the virtio-gpu default). */
export function readDisplay(p: Paths): DisplayConfig {
  try {
    const raw = JSON.parse(readFileSync(displayPath(p), "utf8")) as Record<string, unknown>
    if (raw["device"] !== "virtio-gpu") return RAMFB
    const w = raw["width"]
    const h = raw["height"]
    return typeof w === "number" && typeof h === "number" ? { device: "virtio-gpu", legacySize: { width: w, height: h } } : VIRTIO_GPU
  } catch {
    // absent or unreadable: the default for instances made before display.json existed
  }
  return RAMFB
}

/** ramfb is written too, not just implied by a missing file. */
export function writeDisplay(p: Paths, cfg: DisplayConfig): void {
  const out =
    cfg.device === "ramfb"
      ? { device: "ramfb" }
      : cfg.legacySize === undefined
        ? { device: "virtio-gpu" }
        : { device: "virtio-gpu", width: cfg.legacySize.width, height: cfg.legacySize.height }
  writeFileSync(displayPath(p), `${JSON.stringify(out, null, 2)}\n`)
}

/** QEMU arguments for the display device. Never a size, except an earlier winvm's (see above). */
export function displayArgs(cfg: DisplayConfig): readonly string[] {
  if (cfg.device === "ramfb") return ["-device", "ramfb"]
  if (cfg.legacySize !== undefined) {
    return ["-device", `virtio-gpu-pci,xres=${String(cfg.legacySize.width)},yres=${String(cfg.legacySize.height)}`]
  }
  return ["-device", "virtio-gpu-pci"]
}

/** The bounds `winvm display WxH` once put on a virtio-gpu size, which is all a legacy size can be. */
const LEGACY_WIDTH = { min: 640, max: 7680 }
const LEGACY_HEIGHT = { min: 480, max: 4320 }

const inRange = (v: unknown, r: { readonly min: number; readonly max: number }): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max

/**
 * A launch profile recorded in a save's manifest (Manifest.display): exactly
 * what `displayArgs` can express, or null. Strict where `readDisplay` is
 * tolerant, because a profile is replayed onto QEMU's command line: an unknown
 * device or key, or a partial or out-of-range `legacySize`, is refused rather
 * than guessed at.
 */
export function parseDisplayConfig(value: unknown): DisplayConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  const keys = Object.keys(r)
  if (r["device"] === "ramfb") return keys.length === 1 ? RAMFB : null
  if (r["device"] !== "virtio-gpu" || keys.some((k) => k !== "device" && k !== "legacySize")) return null
  const size = r["legacySize"]
  if (size === undefined) return keys.length === 1 ? VIRTIO_GPU : null
  if (typeof size !== "object" || size === null || Array.isArray(size)) return null
  const s = size as Record<string, unknown>
  const width = s["width"]
  const height = s["height"]
  if (Object.keys(s).length !== 2 || !inRange(width, LEGACY_WIDTH) || !inRange(height, LEGACY_HEIGHT)) return null
  return { device: "virtio-gpu", legacySize: { width, height } }
}

/** The `-device` arguments of a command line that name a display: `ramfb` or `virtio-gpu-pci`, with or without properties. */
const displayDevices = (command: string): string[] =>
  [...command.matchAll(/(?:^|\s)-device\s+(\S+)/g)].map((m) => m[1] ?? "").filter((d) => /^(ramfb|virtio-gpu-pci)(,|$)/.test(d))

/**
 * The display a QEMU command line launches: exactly one `-device ramfb`,
 * `-device virtio-gpu-pci` or `-device virtio-gpu-pci,xres=W,yres=H`. Anything
 * else (none, two, extra properties, another GPU model) is null, so a caller
 * refuses rather than record hardware it cannot identify. Only `-device`
 * arguments count: a `-name` or a path that mentions a device is ignored.
 */
export function displayFromCommandLine(command: string): DisplayConfig | null {
  const found = displayDevices(command)
  if (found.length !== 1) return null
  const device = found[0] ?? ""
  if (device === "ramfb") return RAMFB
  if (device === "virtio-gpu-pci") return VIRTIO_GPU
  const size = /^virtio-gpu-pci,xres=(\d+),yres=(\d+)$/.exec(device)
  return size === null ? null : parseDisplayConfig({ device: "virtio-gpu", legacySize: { width: Number(size[1]), height: Number(size[2]) } })
}

/**
 * The size of a legacy `virtio-gpu-pci,xres=..,yres=..` device that
 * `displayFromCommandLine` refuses (out of bounds or not whole numbers), as the
 * command line spells it; null when there is no such device. For a refusal
 * that names the size instead of claiming there is no display device.
 */
export function rejectedLegacySize(command: string): string | null {
  const found = displayDevices(command)
  if (found.length !== 1 || displayFromCommandLine(command) !== null) return null
  const size = /^virtio-gpu-pci,xres=([^,\s]*),yres=([^,\s]*)$/.exec(found[0] ?? "")
  return size === null ? null : `xres=${size[1] ?? ""},yres=${size[2] ?? ""}`
}

/** The sizes a legacy profile may have, in words, for a refusal. */
export const LEGACY_SIZE_BOUNDS = `${String(LEGACY_WIDTH.min)}x${String(LEGACY_HEIGHT.min)} to ${String(LEGACY_WIDTH.max)}x${String(LEGACY_HEIGHT.max)}, whole numbers`

/**
 * Whether a QEMU command line has the shared folder's device; the memory
 * backend, virtio-fs and the clipboard port come and go with it (share.ts).
 * Read off the `-device` argument, not by splitting the line into words, so a
 * path with a space in it cannot change the answer.
 */
export const sharesFolderFromCommandLine = (command: string): boolean => /(?:^|\s)-device\s+vhost-user-fs-pci(?:,|\s|$)/.test(command)

/** The full command line of the running process `pid`; null when it cannot be read. */
export function runningCommand(pid: number): string | null {
  // -ww: never cut to the terminal's width, or a device could be cut off.
  const r = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" })
  if (r.status !== 0) return null
  const cmd = (r.stdout ?? "").trim()
  return cmd === "" ? null : cmd
}

/** The display the RUNNING QEMU `pid` was launched with, off its full command line; null when that cannot be told. */
export function runningDisplay(pid: number): DisplayConfig | null {
  const cmd = runningCommand(pid)
  return cmd === null ? null : displayFromCommandLine(cmd)
}

/** "virtio-gpu" (or "virtio") and "ramfb"; null for anything else. */
export function parseDevice(s: string): DisplayConfig | null {
  const t = s.trim().toLowerCase()
  if (t === "ramfb") return RAMFB
  if (t === "virtio-gpu" || t === "virtio") return VIRTIO_GPU
  return null
}

export const isResizable = (cfg: DisplayConfig): boolean => cfg.device === "virtio-gpu"

/** The device as `status` and the app show it; the app keys off the leading word. */
export const describeDisplay = (cfg: DisplayConfig): string =>
  cfg.device === "ramfb" ? "ramfb (firmware framebuffer, 800x600)" : "virtio-gpu (resizable)"

/** Same device on the command line? A legacy size counts: it is in the hardware hash. */
export const sameDevice = (a: DisplayConfig, b: DisplayConfig): boolean => displayArgs(a).join(" ") === displayArgs(b).join(" ")
