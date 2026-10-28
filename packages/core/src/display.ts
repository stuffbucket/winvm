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
 * The device is part of the machine, and a save only loads into the same
 * machine, so switching an instance's device makes the saves taken before
 * unloadable (QEMU refuses them; nothing is corrupted). That is why existing
 * instances keep their device until switched with `winvm display virtio-gpu`
 * or `winvm display ramfb`, and only while stopped. An instance switched to
 * virtio-gpu by an earlier winvm has a size in its display.json; it keeps
 * that size on its command line (so its saves still load) until switched
 * again.
 */
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
