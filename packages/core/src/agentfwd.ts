/**
 * The agent's per-instance state, and the port forwards into the guest: the
 * agent's, and the file server's for Finder (finder.ts). Split from agent.ts so
 * qemu.ts can restore them on every launch without importing the client
 * (agent.ts imports qemu.ts).
 *
 *   <instance>/agent.json   { token, hostPort }   (mode 0600)
 *   <instance>/smb.json     { user, password, hostPort, mounted }   (mode 0600, smbstate.ts)
 *
 * A forward is `127.0.0.1:<hostPort>` on the host to a guest port (the agent's
 * GUEST_PORT, or SMB's 445), added at RUNTIME over the monitor (`hostfwd_add`),
 * never on the command line: a save's compatibility hash (saves.ts) covers the
 * hardware arguments, and a forward there would make every existing save
 * incompatible. So every new QEMU process — start, a load, a stow recall, a
 * rewind into a stopped instance — starts without them, and `restoreForward`
 * (called by qemu.launch) puts them back. A `loadvm` inside a running QEMU
 * keeps them.
 */
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"

import { GUEST_PORT } from "./guestagent"
import type { Paths } from "./paths"
import * as qmp from "./qmp"
import { SMB_GUEST_PORT, readSmb, writeSmb } from "./smbstate"

// --- per-instance state ---------------------------------------------------

export interface AgentState {
  readonly token: string
  /** The host end of the forward, or null before one was ever added. */
  readonly hostPort: number | null
}

export const statePath = (p: Paths): string => resolve(p.dir, "agent.json")

export function readState(p: Paths): AgentState | null {
  const f = statePath(p)
  if (!existsSync(f)) return null
  try {
    const s = JSON.parse(readFileSync(f, "utf8")) as Partial<AgentState>
    if (typeof s.token !== "string" || s.token === "") return null
    return { token: s.token, hostPort: typeof s.hostPort === "number" ? s.hostPort : null }
  } catch {
    return null
  }
}

export function writeState(p: Paths, s: AgentState): void {
  const f = statePath(p)
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
  chmodSync(f, 0o600)
}

/** The instance's state, creating a token the first time. */
export function ensureState(p: Paths): AgentState {
  const s = readState(p)
  if (s !== null) return s
  const fresh: AgentState = { token: randomBytes(32).toString("hex"), hostPort: null }
  writeState(p, fresh)
  return fresh
}

/** A port nothing on the host is listening on right now. */
export async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer()
    srv.once("error", rej)
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address()
      const port = typeof a === "object" && a !== null ? a.port : 0
      srv.close(() => res(port))
    })
  })
}

// --- the port forwards ------------------------------------------------------

/** QEMU's id for the user-net backend; see qemu.ts (`-netdev user,id=net0`). */
export const NETDEV = "net0"

export const hostfwdRule = (hostPort: number, guestPort: number = GUEST_PORT): string =>
  `tcp:127.0.0.1:${String(hostPort)}-:${String(guestPort)}`

/** Host ports that `info usernet` shows forwarded to `guestPort` (default: the agent's). */
export function forwardedPorts(usernet: string, guestPort: number = GUEST_PORT): readonly number[] {
  const ports: number[] = []
  for (const line of usernet.split(/\r?\n/)) {
    // TCP[HOST_FORWARD]  12       127.0.0.1 47801       10.0.2.15  7801     0     0
    const m = /^\s*TCP\[HOST_FORWARD\]\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s/.exec(line)
    if (m !== null && Number(m[2]) === guestPort) ports.push(Number(m[1]))
  }
  return ports
}

/**
 * Make sure a host port is forwarded to `guestPort`, preferring `wanted`, and
 * return that host port. Idempotent and cheap (one `info usernet`). A wanted
 * port that has since been taken on the host is replaced by a free one; the
 * caller records whichever comes back.
 */
export async function forwardPort(p: Paths, guestPort: number, wanted: number | null): Promise<number> {
  const present = forwardedPorts(await qmp.hmp(p.qmp, "info usernet"), guestPort)
  if (wanted !== null && present.includes(wanted)) return wanted
  for (const stale of present) await qmp.hmp(p.qmp, `hostfwd_remove ${NETDEV} tcp:127.0.0.1:${String(stale)}`)
  let lastError = ""
  for (const port of [wanted ?? (await freePort()), await freePort(), await freePort()]) {
    // hostfwd_add reports failure as text in a successful reply, not as an error.
    const said = await qmp.hmp(p.qmp, `hostfwd_add ${NETDEV} ${hostfwdRule(port, guestPort)}`).catch((e: unknown) => String(e))
    if (said === "" || forwardedPorts(await qmp.hmp(p.qmp, "info usernet"), guestPort).includes(port)) return port
    lastError = said
  }
  throw new Error(`could not forward a host port to the guest's port ${String(guestPort)}: ${lastError}`)
}

/**
 * Make sure the forward to the agent exists, and return its host port.
 *
 * Idempotent and cheap (one `info usernet`), so anything about to talk to the
 * agent can call it. A port that has since been taken on the host is replaced
 * by a free one, and the new port recorded.
 */
export async function ensureForward(p: Paths): Promise<number> {
  const s = ensureState(p)
  const port = await forwardPort(p, GUEST_PORT, s.hostPort)
  if (port !== s.hostPort) writeState(p, { ...s, hostPort: port })
  return port
}

/**
 * The forward to the guest's file server, for an instance with a smb.json. Its
 * host port is kept there, the same across launches unless something else on
 * the host has taken it meanwhile. Throws when there is no smb.json.
 */
export async function ensureSmbForward(p: Paths): Promise<number> {
  const s = readSmb(p)
  if (s === null) throw new Error("this instance has never shared its drives with the Mac")
  const port = await forwardPort(p, SMB_GUEST_PORT, s.hostPort)
  if (port !== s.hostPort) writeSmb(p, { ...s, hostPort: port })
  return port
}

/**
 * For qemu.launch: put the forwards back in a QEMU that was just started, for
 * an instance that has an agent or shares its drives. A no-op otherwise. Never
 * throws — a guest without its forwards is still a working guest, `connect`
 * retries the agent's, and a mount adds the file server's.
 */
export async function restoreForward(p: Paths): Promise<void> {
  if (readState(p) !== null) {
    try {
      await ensureForward(p)
    } catch (error) {
      console.warn(`warning: agent port forward not restored (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  if (readSmb(p) !== null) {
    try {
      await ensureSmbForward(p)
    } catch (error) {
      console.warn(`warning: file sharing port forward not restored (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}
