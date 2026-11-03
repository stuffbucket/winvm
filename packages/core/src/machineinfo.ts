/**
 * `winvm info [-i name] [--json]`: the machine's virtual hardware and network,
 * as it runs and as it is set for the next start. And the `cpus=` / `memory=`
 * keys of `winvm config`, which set the size (hardware.ts).
 *
 * The network is QEMU's user-mode networking (`-netdev user`, qemu.ts): a NAT
 * inside the QEMU process. Windows gets 10.0.2.15 from QEMU's DHCP, its gateway
 * 10.0.2.2 is this Mac, and 10.0.2.3 forwards DNS to the Mac's resolver.
 * Windows reaches the internet, and the Mac's own services at 10.0.2.2.
 * Nothing reaches Windows from outside except the forwards winvm adds at run
 * time (agentfwd.ts), each from 127.0.0.1 on the Mac. The VNC and WebSocket
 * ports are QEMU's own listeners for the screen, also on 127.0.0.1 (vnc.ts).
 */
import { spawnSync } from "node:child_process"

import { GUEST_PORT } from "./guestagent"
import type { Hardware, Limits } from "./hardware"
import { formatMiB, hardwareError, hostLimits, parseMemory, readHardware, runningHardware, sameHardware, writeHardware } from "./hardware"
import type { Args } from "./args"
import { instanceName } from "./args"
import { pathsFor, readMeta } from "./paths"
import type { Paths } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as qmp from "./qmp"
import { runtimeBin } from "./runtime"
import { STOW, hasSave } from "./saves"
import { SMB_GUEST_PORT } from "./smbstate"
import { vncPort, websocketPort } from "./vnc"

export const NETWORK = {
  mode: "user",
  label: "NAT (QEMU user networking)",
  guest: "10.0.2.15",
  gateway: "10.0.2.2",
  dns: "10.0.2.3",
} as const

export type ForwardKind = "finder" | "agent" | "other"

export interface Forward {
  readonly kind: ForwardKind
  readonly host: string
  readonly hostPort: number
  readonly guestPort: number
}

export interface Listener {
  readonly kind: "vnc" | "websocket"
  readonly host: string
  readonly port: number
}

export interface MachineInfo {
  readonly name: string
  readonly running: boolean
  readonly hardware: {
    /** What QEMU runs with now; null when it is not running. */
    readonly running: Hardware | null
    /** The setting: what the next start that boots Windows uses. */
    readonly next: Hardware
    readonly limits: Limits
    /** The virtual disk's size; null when it could not be read. */
    readonly diskBytes: number | null
  }
  readonly network: {
    readonly mode: string
    readonly label: string
    readonly guest: string
    readonly gateway: string
    readonly dns: string
    /** Windows' own view of its adapter, from the guest agent; null when it cannot be asked. */
    readonly windows: { readonly adapter: string; readonly ipv4: string } | null
    /** Live, from QEMU (`info usernet`); empty while stopped. */
    readonly forwards: readonly Forward[]
    /** QEMU's screen listeners on the Mac; empty while stopped. */
    readonly listeners: readonly Listener[]
  }
}

// ---------------------------------------------------------------------------
// Pure

export const forwardKind = (guestPort: number): ForwardKind =>
  guestPort === SMB_GUEST_PORT ? "finder" : guestPort === GUEST_PORT ? "agent" : "other"

/** Every host forward in `info usernet`'s table. */
export function parseUsernet(text: string): Forward[] {
  const out: Forward[] = []
  for (const line of text.split(/\r?\n/)) {
    // TCP[HOST_FORWARD]  12       127.0.0.1 47801       10.0.2.15  7801     0     0
    const m = /^\s*TCP\[HOST_FORWARD\]\s+\d+\s+(\S+)\s+(\d+)\s+\S+\s+(\d+)\s/.exec(line)
    if (m === null) continue
    const guestPort = Number(m[3])
    out.push({ kind: forwardKind(guestPort), host: m[1] ?? "", hostPort: Number(m[2]), guestPort })
  }
  return out.sort((a, b) => a.guestPort - b.guestPort)
}

/** The adapter Windows routes through: the first with an IPv4 address that is not loopback or link-local. */
export function windowsAdapter(reply: unknown): { adapter: string; ipv4: string } | null {
  if (!Array.isArray(reply)) return null
  for (const i of reply as unknown[]) {
    if (typeof i !== "object" || i === null) continue
    const r = i as Record<string, unknown>
    const ips = Array.isArray(r["ip-addresses"]) ? (r["ip-addresses"] as unknown[]) : []
    for (const a of ips) {
      const ip = (a as Record<string, unknown> | null)?.["ip-address"]
      const type = (a as Record<string, unknown> | null)?.["ip-address-type"]
      if (type !== "ipv4" || typeof ip !== "string" || ip.startsWith("127.") || ip.startsWith("169.254.")) continue
      return { adapter: typeof r["name"] === "string" ? r["name"] : "", ipv4: ip }
    }
  }
  return null
}

const fmtHw = (h: Hardware): string => `${String(h.cpus)} processors, ${formatMiB(h.memoryMiB)}`

/** The note for a size that differs from what runs; null when it doesn't. */
export const pendingNote = (running: Hardware | null, next: Hardware): string | null =>
  running === null || sameHardware(running, next) ? null : `running with ${fmtHw(running)}; ${fmtHw(next)} applies the next time Windows starts`

export function formatInfo(i: MachineInfo): string {
  const hw = i.hardware
  const n = i.network
  const now = hw.running ?? hw.next
  const lines = [
    `"${i.name}" (${i.running ? "running" : "not running"}):`,
    `  processors  ${String(now.cpus)}`,
    `  memory      ${formatMiB(now.memoryMiB)}`,
    `  disk        ${hw.diskBytes === null ? "?" : `${String(Math.round(hw.diskBytes / 1024 ** 3))} GB`}`,
  ]
  const pending = pendingNote(hw.running, hw.next)
  if (pending !== null) lines.push(`  (${pending})`)
  lines.push(
    `  network     ${n.label}`,
    `    Windows   ${n.windows?.ipv4 ?? n.guest}${n.windows !== null && n.windows.adapter !== "" ? ` (${n.windows.adapter})` : ""}`,
    `    gateway   ${n.gateway} (this Mac)`,
    `    DNS       ${n.dns}`,
  )
  const label = { finder: "Finder drives", agent: "winvm agent", other: "" } as const
  if (!i.running) lines.push("    forwards  none while it is not running")
  else if (n.forwards.length === 0) lines.push("    forwards  none")
  n.forwards.forEach((f, k) =>
    lines.push(`    ${k === 0 ? "forwards  " : "          "}${f.host}:${String(f.hostPort)} -> ${String(f.guestPort)}${f.kind === "other" ? "" : ` (${label[f.kind]})`}`),
  )
  n.listeners.forEach((l, k) =>
    lines.push(`    ${k === 0 ? "screen    " : "          "}${l.host}:${String(l.port)} (${l.kind === "vnc" ? "VNC" : "WebSocket"})`),
  )
  lines.push(
    `  Windows reaches the internet, and this Mac at ${n.gateway}. Nothing else reaches Windows except the forwards above, which listen on this Mac only.`,
  )
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Gathering

function diskBytes(p: Paths): number | null {
  // -U: the running QEMU holds the image's lock.
  const r = spawnSync(runtimeBin("qemu-img"), ["info", "-U", "--output=json", p.overlay], { encoding: "utf8" })
  if (r.status !== 0) return null
  try {
    const v = (JSON.parse(r.stdout) as Record<string, unknown>)["virtual-size"]
    return typeof v === "number" ? v : null
  } catch {
    return null
  }
}

async function windowsSide(p: Paths): Promise<MachineInfo["network"]["windows"]> {
  // Not while paused or asleep: the agent cannot answer, and the call would wait.
  try {
    if ((await qmp.status(p.qmp)) !== "running") return null
    const r = await qga.call(p.qga, { execute: "guest-network-get-interfaces" }, 4000)
    return windowsAdapter(r["return"])
  } catch {
    return null
  }
}

export async function gatherInfo(name: string): Promise<MachineInfo | null> {
  const meta = readMeta(name)
  if (meta === null) return null
  const p = pathsFor(name)
  const pid = qemu.pidOf(p)
  const running = pid !== null
  let forwards: Forward[] = []
  if (running) {
    try {
      forwards = parseUsernet(await qmp.hmp(p.qmp, "info usernet", 5000))
    } catch {
      // the monitor is busy (a save or load); none shown
    }
  }
  return {
    name,
    running,
    hardware: { running: pid === null ? null : runningHardware(pid), next: readHardware(p), limits: hostLimits(), diskBytes: diskBytes(p) },
    network: {
      ...NETWORK,
      windows: running ? await windowsSide(p) : null,
      forwards,
      listeners: running
        ? [
            { kind: "vnc", host: "127.0.0.1", port: vncPort(meta.vnc) },
            { kind: "websocket", host: "127.0.0.1", port: websocketPort(meta.vnc) },
          ]
        : [],
    },
  }
}

export async function infoCmd(args: Args): Promise<number> {
  const name = instanceName(args)
  const info = await gatherInfo(name)
  if (info === null) {
    console.error(`::error::no such instance "${name}"`)
    return 1
  }
  console.log(args.flags.has("json") ? JSON.stringify(info, null, 2) : formatInfo(info))
  return 0
}

// ---------------------------------------------------------------------------
// `winvm config cpus=N memory=8G`

export const HARDWARE_KEYS = ["cpus", "memory"] as const

export const isHardwareKey = (assignment: string): boolean => HARDWARE_KEYS.some((k) => assignment.trim().startsWith(`${k}=`))

/** The size after applying `cpus=` / `memory=` assignments to `current`. Throws with a message fit for the user. */
export function applyAssignments(current: Hardware, assignments: readonly string[], limits: Limits): Hardware {
  let next = current
  for (const a of assignments) {
    const eq = a.indexOf("=")
    const key = a.slice(0, eq).trim()
    const value = a.slice(eq + 1).trim()
    if (key === "cpus") {
      if (!/^\d+$/.test(value)) throw new Error(`cpus is a whole number, got "${value}"`)
      next = { ...next, cpus: Number(value) }
    } else {
      const mib = parseMemory(value)
      if (mib === null) throw new Error(`memory is a size like 8G or 8192 (MB), got "${value}"`)
      next = { ...next, memoryMiB: mib }
    }
  }
  const err = hardwareError(next, limits)
  if (err !== null) throw new Error(err)
  return next
}

/** Set the machine's size; returns what to print. */
export function setHardware(name: string, assignments: readonly string[]): string {
  const p = pathsFor(name)
  const next = applyAssignments(readHardware(p), assignments, hostLimits())
  writeHardware(p, next)
  const pid = qemu.pidOf(p)
  const running = pid === null ? null : runningHardware(pid)
  const said = pendingNote(running, next) ?? (running === null ? `${fmtHw(next)}; applies the next time Windows starts` : `${fmtHw(next)}`)
  // A stow is recalled at the size it was taken at (saves.ts), so the new size waits for a boot after it.
  return hasSave(name, STOW) ? `${said} (the stowed session resumes at its own size first)` : said
}

/** The size lines `winvm config` prints. */
export function hardwareLines(name: string): string[] {
  const p = pathsFor(name)
  const next = readHardware(p)
  return [`  ${"cpus".padEnd(22)} ${String(next.cpus)}`, `  ${"memory".padEnd(22)} ${formatMiB(next.memoryMiB)}`]
}
