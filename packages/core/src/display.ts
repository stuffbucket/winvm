/**
 * The guest's display device, and so its screen resolution.
 *
 * ## Why the default stays 800x600
 *
 * The default device is `ramfb`: a plain framebuffer in guest RAM that the
 * firmware sets up and Windows' Basic Display driver keeps using, so there is a
 * picture before any driver loads and no driver to go wrong. Its resolution is
 * whatever the FIRMWARE picked, and EDK2's ramfb driver offers exactly three
 * modes (640x480, 800x600, 1024x768) and always starts in 800x600
 * (OvmfPkg/QemuRamfbDxe/QemuRamfb.c). Windows can't change it afterwards: Basic
 * Display has no mode setting of its own.
 *
 * For a bigger screen, an instance can switch to `virtio-gpu-pci` with the
 * resolution given as its `xres`/`yres` (QEMU reports it to the guest as the
 * monitor's preferred mode over EDID). That needs Windows' `viogpudo` driver,
 * which the UTM guest tools put in the driver store during the build — so an
 * existing image binds it on first boot with the new device, no rebuild.
 *
 * ## Why it is per instance, and only while stopped
 *
 * The display device is part of the machine. A snapshot or a saved state holds
 * the state of every device and only restores into a machine with the same
 * set, so switching an instance's display makes its existing snapshots and
 * saves unrestorable (QEMU refuses them; nothing is corrupted). That is why it
 * is a deliberate per-instance choice, stored in the instance directory, rather
 * than a new default that would silently strand every snapshot already taken.
 * A build always uses ramfb: WinPE has no virtio-gpu driver.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Paths } from "./paths"

export type DisplayConfig =
  | { readonly device: "ramfb" }
  | { readonly device: "virtio-gpu"; readonly width: number; readonly height: number }

export const RAMFB: DisplayConfig = { device: "ramfb" }

export const displayPath = (p: Paths): string => resolve(p.dir, "display.json")

/** The instance's display; ramfb when it has never been set. */
export function readDisplay(p: Paths): DisplayConfig {
  try {
    const raw = JSON.parse(readFileSync(displayPath(p), "utf8")) as Record<string, unknown>
    const w = raw["width"]
    const h = raw["height"]
    if (raw["device"] === "virtio-gpu" && typeof w === "number" && typeof h === "number") {
      return { device: "virtio-gpu", width: w, height: h }
    }
  } catch {
    // absent or unreadable: the default
  }
  return RAMFB
}

export function writeDisplay(p: Paths, cfg: DisplayConfig): void {
  if (cfg.device === "ramfb") rmSync(displayPath(p), { force: true })
  else writeFileSync(displayPath(p), `${JSON.stringify(cfg, null, 2)}\n`)
}

/** QEMU arguments for the display device. */
export function displayArgs(cfg: DisplayConfig): readonly string[] {
  return cfg.device === "ramfb"
    ? ["-device", "ramfb"]
    : ["-device", `virtio-gpu-pci,xres=${String(cfg.width)},yres=${String(cfg.height)}`]
}

/**
 * "1920x1080" -> virtio-gpu at that size; "ramfb" or "default" -> ramfb.
 * Null for anything else. Bounds are loose sanity limits, not what any
 * particular driver supports.
 */
export function parseDisplay(s: string): DisplayConfig | null {
  const t = s.trim().toLowerCase()
  if (t === "ramfb" || t === "default") return RAMFB
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(t)
  if (m === null) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (width < 640 || height < 480 || width > 7680 || height > 4320) return null
  return { device: "virtio-gpu", width, height }
}

export const describeDisplay = (cfg: DisplayConfig): string =>
  cfg.device === "ramfb"
    ? "ramfb (firmware framebuffer, 800x600)"
    : `virtio-gpu ${String(cfg.width)}x${String(cfg.height)}`
