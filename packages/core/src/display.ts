import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Paths } from "./paths"
import { spawnText } from "./shell"

export type DisplayConfig =
  | { readonly device: "ramfb" }
  | {
      readonly device: "virtio-gpu"
      readonly legacySize?: { readonly width: number; readonly height: number }
    }

export const RAMFB: DisplayConfig = { device: "ramfb" }
export const VIRTIO_GPU: DisplayConfig = { device: "virtio-gpu" }

export const displayPath = (p: Paths): string => resolve(p.dir, "display.json")

export function readDisplay(p: Paths): DisplayConfig {
  try {
    const raw = JSON.parse(readFileSync(displayPath(p), "utf8")) as Record<
      string,
      unknown
    >
    if (raw["device"] !== "virtio-gpu") return RAMFB
    const w = raw["width"]
    const h = raw["height"]
    return typeof w === "number" && typeof h === "number"
      ? { device: "virtio-gpu", legacySize: { width: w, height: h } }
      : VIRTIO_GPU
  } catch {}
  return RAMFB
}

export function writeDisplay(p: Paths, cfg: DisplayConfig): void {
  const out =
    cfg.device === "ramfb"
      ? { device: "ramfb" }
      : cfg.legacySize === undefined
        ? { device: "virtio-gpu" }
        : {
            device: "virtio-gpu",
            width: cfg.legacySize.width,
            height: cfg.legacySize.height,
          }
  writeFileSync(displayPath(p), `${JSON.stringify(out, null, 2)}\n`)
}

export function displayArgs(cfg: DisplayConfig): readonly string[] {
  if (cfg.device === "ramfb") return ["-device", "ramfb"]
  if (cfg.legacySize !== undefined) {
    return [
      "-device",
      `virtio-gpu-pci,xres=${String(cfg.legacySize.width)},yres=${String(cfg.legacySize.height)}`,
    ]
  }
  return ["-device", "virtio-gpu-pci"]
}

const LEGACY_WIDTH = { min: 640, max: 7680 }
const LEGACY_HEIGHT = { min: 480, max: 4320 }

const inRange = (
  v: unknown,
  r: { readonly min: number; readonly max: number },
): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max

export function parseDisplayConfig(value: unknown): DisplayConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null
  const r = value as Record<string, unknown>
  const keys = Object.keys(r)
  if (r["device"] === "ramfb") return keys.length === 1 ? RAMFB : null
  if (
    r["device"] !== "virtio-gpu" ||
    keys.some((k) => k !== "device" && k !== "legacySize")
  )
    return null
  const size = r["legacySize"]
  if (size === undefined) return keys.length === 1 ? VIRTIO_GPU : null
  if (typeof size !== "object" || size === null || Array.isArray(size))
    return null
  const s = size as Record<string, unknown>
  const width = s["width"]
  const height = s["height"]
  if (
    Object.keys(s).length !== 2 ||
    !inRange(width, LEGACY_WIDTH) ||
    !inRange(height, LEGACY_HEIGHT)
  )
    return null
  return { device: "virtio-gpu", legacySize: { width, height } }
}

const displayDevices = (command: string): string[] =>
  [...command.matchAll(/(?:^|\s)-device\s+(\S+)/g)]
    .map((m) => m[1] ?? "")
    .filter((d) => /^(ramfb|virtio-gpu-pci)(,|$)/.test(d))

export function displayFromCommandLine(command: string): DisplayConfig | null {
  const found = displayDevices(command)
  if (found.length !== 1) return null
  const device = found[0] ?? ""
  if (device === "ramfb") return RAMFB
  if (device === "virtio-gpu-pci") return VIRTIO_GPU
  const size = /^virtio-gpu-pci,xres=(\d+),yres=(\d+)$/.exec(device)
  return size === null
    ? null
    : parseDisplayConfig({
        device: "virtio-gpu",
        legacySize: { width: Number(size[1]), height: Number(size[2]) },
      })
}

export function rejectedLegacySize(command: string): string | null {
  const found = displayDevices(command)
  if (found.length !== 1 || displayFromCommandLine(command) !== null)
    return null
  const size = /^virtio-gpu-pci,xres=([^,\s]*),yres=([^,\s]*)$/.exec(
    found[0] ?? "",
  )
  return size === null ? null : `xres=${size[1] ?? ""},yres=${size[2] ?? ""}`
}

export const LEGACY_SIZE_BOUNDS = `${String(LEGACY_WIDTH.min)}x${String(LEGACY_HEIGHT.min)} to ${String(LEGACY_WIDTH.max)}x${String(LEGACY_HEIGHT.max)}, whole numbers`

export const sharesFolderFromCommandLine = (command: string): boolean =>
  /(?:^|\s)-device\s+vhost-user-fs-pci(?:,|\s|$)/.test(command)

export function runningCommand(pid: number): string | null {
  const r = spawnText("ps", ["-ww", "-o", "command=", "-p", String(pid)])
  if (r.status !== 0) return null
  const cmd = r.stdout.trim()
  return cmd === "" ? null : cmd
}

export function runningDisplay(pid: number): DisplayConfig | null {
  const cmd = runningCommand(pid)
  return cmd === null ? null : displayFromCommandLine(cmd)
}

export function parseDevice(s: string): DisplayConfig | null {
  const t = s.trim().toLowerCase()
  if (t === "ramfb") return RAMFB
  if (t === "virtio-gpu" || t === "virtio") return VIRTIO_GPU
  return null
}

export const isResizable = (cfg: DisplayConfig): boolean =>
  cfg.device === "virtio-gpu"

export const describeDisplay = (cfg: DisplayConfig): string =>
  cfg.device === "ramfb"
    ? "ramfb (firmware framebuffer, 800x600)"
    : "virtio-gpu (resizable)"

export const sameDevice = (a: DisplayConfig, b: DisplayConfig): boolean =>
  displayArgs(a).join(" ") === displayArgs(b).join(" ")
