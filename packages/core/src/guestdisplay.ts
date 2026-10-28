/**
 * The running guest's screen: what QEMU shows now, and resizing it live on
 * virtio-gpu (display.ts explains the device; displayfit.ts the limits).
 *
 * A LIVE RESIZE IS TWO STEPS, in this order:
 *   1. `requestSize`: VNC SetDesktopSize (desktopsize.ts). QEMU passes the size
 *      to virtio-gpu, and the guest's viogpudo driver adds it to its modes.
 *      The app's viewer sends this itself, over its own noVNC connection.
 *   2. `setGuestSize`: the in-guest agent's display helper waits for that mode
 *      and sets it with ChangeDisplaySettingsEx in the logged-on session, then
 *      the display scale if asked. Without step 1 the size is not a mode and
 *      the helper times out; without step 2 nothing changes.
 * Measured on win11-arm64: ~80 ms from the request to QEMU's new framebuffer.
 *
 * WHY NOT qemu-ga. qemu-ga runs in session 0: ChangeDisplaySettingsEx there
 * returns success and changes nothing on the user's desktop.
 */
import { spawnSync } from "node:child_process"

import * as agent from "./agent"
import { requestDesktopSize, RESIZE_STATUS } from "./desktopsize"
import type { Size } from "./displayfit"
import { withQmp } from "./monitor"
import type { InstanceMeta, Paths } from "./paths"
import * as qemu from "./qemu"
import { screenSize } from "./input"
import { passwordFor, vncPort } from "./vnc"

/** The device the RUNNING QEMU was started with, read off its command line. */
export function liveDevice(p: Paths): string | null {
  const pid = qemu.pidOf(p)
  if (pid === null) return null
  const cmd = (spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim()
  return deviceFromCommandLine(cmd)
}

export function deviceFromCommandLine(cmd: string): string | null {
  if (/(^|\s)virtio-gpu-pci(,|\s|$)/.test(cmd)) return "virtio-gpu"
  if (/(^|\s)ramfb(\s|$)/.test(cmd)) return "ramfb"
  return null
}

/** The framebuffer's current size, or null if the monitor didn't answer. */
export async function liveSize(p: Paths): Promise<Size | null> {
  try {
    return await withQmp(p.qmp, async (q) => await screenSize(q), 5000)
  } catch {
    return null
  }
}

/** Step 1: ask QEMU, over VNC, for `size`. Throws unless QEMU forwarded it to the device. */
export async function requestSize(p: Paths, meta: InstanceMeta, size: Size): Promise<void> {
  const answer = await requestDesktopSize(vncPort(meta.vnc), passwordFor(p), size.width, size.height)
  if (answer.status !== 4 && answer.status !== 0) {
    const why = RESIZE_STATUS[answer.status as keyof typeof RESIZE_STATUS] ?? `status ${String(answer.status)}`
    throw new Error(`QEMU did not pass the size on: ${why}`)
  }
}

/** What the guest's display helper reports. */
export interface GuestDisplay {
  readonly width: number
  readonly height: number
  /** Windows' display scale, percent. */
  readonly scale: number
  /** The largest scale Windows allows at this size. */
  readonly maxScale: number
  /** Effective DPI of the screen (96 at 100%). */
  readonly dpi: number
  readonly changed?: boolean
  readonly scaled?: boolean
  readonly ms?: number
}

/** The guest's size and scale, from the helper. */
export async function guestState(name: string): Promise<GuestDisplay> {
  return await (await agent.requireAgent(name)).display<GuestDisplay>({ op: "get" })
}

/**
 * Step 2: set the size in the guest (waiting up to `waitMs` for the driver to
 * offer it), and the scale if given and different. Ensures an agent new enough
 * to have the helper: an older one is reinstalled, once.
 */
export async function setGuestSize(name: string, size: Size, o: { readonly scale?: number; readonly waitMs?: number } = {}): Promise<GuestDisplay> {
  const c = await agent.ensure(name)
  return await c.display<GuestDisplay>({
    op: "set",
    width: size.width,
    height: size.height,
    waitMs: o.waitMs ?? 2000,
    ...(o.scale === undefined ? {} : { scale: o.scale }),
  })
}

/** Set only the scale (percent). */
export async function setGuestScale(name: string, scale: number): Promise<GuestDisplay> {
  return await (await agent.ensure(name)).display<GuestDisplay>({ op: "scale", scale })
}
