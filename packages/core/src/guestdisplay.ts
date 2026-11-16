import type { Size } from "@winvm/displayfit"

import * as agent from "./agent"
import { requestDesktopSize, RESIZE_STATUS } from "./desktopsize"
import { displayFromCommandLine, runningDisplay } from "./display"
import { withQmp } from "./monitor"
import type { InstanceMeta, Paths } from "./paths"
import * as qemu from "./qemu"
import { screenSize } from "./input"
import { passwordFor, vncPort } from "./vnc"

export function liveDevice(p: Paths): string | null {
  const pid = qemu.pidOf(p)
  return pid === null ? null : (runningDisplay(pid)?.device ?? null)
}

export function deviceFromCommandLine(cmd: string): string | null {
  return displayFromCommandLine(cmd)?.device ?? null
}

export async function liveSize(p: Paths): Promise<Size | null> {
  try {
    return await withQmp(p.qmp, async (q) => await screenSize(q), 5000)
  } catch {
    return null
  }
}

export async function requestSize(p: Paths, meta: InstanceMeta, size: Size): Promise<void> {
  const answer = await requestDesktopSize(vncPort(meta.vnc), passwordFor(p), size.width, size.height)
  if (answer.status !== 4 && answer.status !== 0) {
    const why = RESIZE_STATUS[answer.status] ?? `status ${String(answer.status)}`
    throw new Error(`QEMU did not pass the size on: ${why}`)
  }
}

export interface GuestDisplay {
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly maxScale: number
  readonly dpi: number
  readonly changed?: boolean
  readonly scaled?: boolean
  readonly ms?: number
  readonly deferred?: boolean
}

export async function guestState(name: string): Promise<GuestDisplay> {
  return await (await agent.requireAgent(name)).display<GuestDisplay>({ op: "get" })
}

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

export async function setGuestScale(name: string, scale: number): Promise<GuestDisplay> {
  return await (await agent.ensure(name)).display<GuestDisplay>({ op: "scale", scale })
}
