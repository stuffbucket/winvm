/**
 * The guest's side of the screen size: what QEMU is showing now, and setting
 * Windows' resolution for the virtio GPU's monitor without a window.
 *
 * WHY THE REGISTRY. Windows remembers a resolution per monitor, under
 * HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration\<monitor>,
 * and applies it at boot. A monitor it has never seen starts at the driver's
 * default — viogpudo's is 1024x768, whatever size QEMU's virtual screen is —
 * and the only supported way to change it is the Settings app or
 * ChangeDisplaySettingsEx from inside the logged-on session, neither of which
 * the guest agent (running as SYSTEM in session 0) can reach. Writing the size
 * into the saved configuration and rebooting does the same thing at the layer
 * Windows reads it from. Verified on this guest: 1024x768 -> 1920x1080.
 *
 * Commands go through `reg.exe` directly, never `cmd /c`: the configuration
 * key names contain `^`, which cmd treats as an escape and silently drops.
 */
import { spawnSync } from "node:child_process"

import type { DisplayConfig } from "./display"
import { withQmp } from "./monitor"
import type { Paths } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import { screenSize } from "./input"

const REG = "C:\\Windows\\System32\\reg.exe"
const CONFIG_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\Configuration"
/** virtio-gpu's PCI vendor and device ids, as Windows writes them in monitor ids. */
const VIRTIO_GPU_ID = "1AF4_1050"

export const deviceLabel = (cfg: DisplayConfig): string =>
  cfg.device === "ramfb" ? "ramfb" : `virtio-gpu ${String(cfg.width)}x${String(cfg.height)}`

/** The device the RUNNING QEMU was started with, read off its command line. */
export function liveDevice(p: Paths): string | null {
  const pid = qemu.pidOf(p)
  if (pid === null) return null
  const cmd = (spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim()
  return deviceFromCommandLine(cmd)
}

export function deviceFromCommandLine(cmd: string): string | null {
  const gpu = /virtio-gpu-pci,xres=(\d+),yres=(\d+)/.exec(cmd)
  if (gpu !== null) return `virtio-gpu ${String(gpu[1])}x${String(gpu[2])}`
  if (/(^|\s)ramfb(\s|$)/.test(cmd)) return "ramfb"
  return null
}

/** The framebuffer's current size, or null if the monitor didn't answer. */
export async function liveSize(p: Paths): Promise<{ width: number; height: number } | null> {
  try {
    return await withQmp(p.qmp, async (q) => await screenSize(q), 5000)
  } catch {
    return null
  }
}

/**
 * Saved-configuration entries for the virtio GPU's monitor, by key name, from
 * `reg query <CONFIG_KEY>`. reg.exe prints the root spelled out
 * (HKEY_LOCAL_MACHINE), and accepts it back that way.
 */
export function virtioMonitorKeys(regQueryOutput: string): readonly string[] {
  const out: string[] = []
  const marker = "\\CONTROL\\GRAPHICSDRIVERS\\CONFIGURATION\\"
  for (const line of regQueryOutput.split(/\r?\n/)) {
    const t = line.trim()
    const at = t.toUpperCase().indexOf(marker)
    if (at < 0 || !/^(HKLM|HKEY_LOCAL_MACHINE)\\/i.test(t)) continue
    const rest = t.slice(at + marker.length)
    if (rest === "" || rest.includes("\\") || !rest.toUpperCase().includes(VIRTIO_GPU_ID)) continue
    out.push(t)
  }
  return out
}

/** The values to write for one monitor entry: [subkey, value name, number]. */
export function resolutionValues(width: number, height: number): readonly (readonly [string, string, number])[] {
  return [
    ["00", "PrimSurfSize.cx", width],
    ["00", "PrimSurfSize.cy", height],
    ["00\\00", "PrimSurfSize.cx", width],
    ["00\\00", "PrimSurfSize.cy", height],
    ["00\\00", "ActiveSize.cx", width],
    ["00\\00", "ActiveSize.cy", height],
    ["00\\00", "DwmClipBox.right", width],
    ["00\\00", "DwmClipBox.bottom", height],
  ]
}

/** Write WxH for every virtio-GPU monitor entry. Returns how many entries there were. */
export async function setGuestResolution(p: Paths, width: number, height: number): Promise<number> {
  const listed = await qga.exec(p.qga, REG, ["query", CONFIG_KEY])
  if (listed.exitcode !== 0) throw new Error(`reg query failed: ${listed.stderr.trim() || listed.stdout.trim()}`)
  const keys = virtioMonitorKeys(listed.stdout)
  for (const key of keys) {
    for (const [sub, value, n] of resolutionValues(width, height)) {
      const r = await qga.exec(p.qga, REG, ["add", `${key}\\${sub}`, "/v", value, "/t", "REG_DWORD", "/d", String(n), "/f"])
      if (r.exitcode !== 0) throw new Error(`reg add ${value} failed: ${r.stderr.trim() || r.stdout.trim()}`)
    }
  }
  return keys.length
}

/** Reboot the guest, wait for it to be back, and measure the screen. */
export async function rebootAndMeasure(p: Paths): Promise<{ width: number; height: number } | null> {
  try {
    await qga.call(p.qga, { execute: "guest-shutdown", arguments: { mode: "reboot" } }, 5000)
  } catch {
    // The agent drops mid-request as the guest goes down; that is success.
  }
  // Wait for it to actually go away, so the readiness check below can't be
  // answered by the guest that is shutting down.
  const goneBy = Date.now() + 120_000
  while (Date.now() < goneBy) {
    try {
      await qga.call(p.qga, { execute: "guest-ping" }, 2000)
      await new Promise((r) => setTimeout(r, 2000))
    } catch {
      break
    }
  }
  if (!(await qga.waitReady(p.qga, 600_000))) return null
  return await liveSize(p)
}
