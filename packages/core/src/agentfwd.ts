/**
 * The agent's per-instance state and its port forward — split from agent.ts so
 * qemu.ts can restore the forward on every launch without importing the client
 * (agent.ts imports qemu.ts).
 *
 *   <instance>/agent.json   { token, hostPort }   (mode 0600)
 *
 * The forward is `127.0.0.1:<hostPort>` on the host to the guest's GUEST_PORT,
 * added at RUNTIME over the monitor (`hostfwd_add`), never on the command line:
 * a save's compatibility hash (saves.ts) covers the hardware arguments, and a
 * forward there would make every existing save incompatible. So every new QEMU
 * process — start, a load, a stow recall, a rewind into a stopped instance —
 * starts without it, and `restoreForward` (called by qemu.launch) puts it back.
 * A `loadvm` inside a running QEMU keeps it.
 */
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"

import { GUEST_PORT } from "./guestagent"
import type { Paths } from "./paths"
import * as qmp from "./qmp"

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

// --- the port forward -------------------------------------------------------

/** QEMU's id for the user-net backend; see qemu.ts (`-netdev user,id=net0`). */
export const NETDEV = "net0"

export const hostfwdRule = (hostPort: number): string => `tcp:127.0.0.1:${String(hostPort)}-:${String(GUEST_PORT)}`

/** Host ports that `info usernet` shows forwarded to the agent's guest port. */
export function forwardedPorts(usernet: string): readonly number[] {
  const ports: number[] = []
  for (const line of usernet.split(/\r?\n/)) {
    // TCP[HOST_FORWARD]  12       127.0.0.1 47801       10.0.2.15  7801     0     0
    const m = /^\s*TCP\[HOST_FORWARD\]\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s/.exec(line)
    if (m !== null && Number(m[2]) === GUEST_PORT) ports.push(Number(m[1]))
  }
  return ports
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
  const present = forwardedPorts(await qmp.hmp(p.qmp, "info usernet"))
  if (s.hostPort !== null && present.includes(s.hostPort)) return s.hostPort
  for (const stale of present) await qmp.hmp(p.qmp, `hostfwd_remove ${NETDEV} tcp:127.0.0.1:${String(stale)}`)
  let lastError = ""
  for (const port of [s.hostPort ?? (await freePort()), await freePort(), await freePort()]) {
    // hostfwd_add reports failure as text in a successful reply, not as an error.
    const said = await qmp.hmp(p.qmp, `hostfwd_add ${NETDEV} ${hostfwdRule(port)}`).catch((e: unknown) => String(e))
    if (said === "" || forwardedPorts(await qmp.hmp(p.qmp, "info usernet")).includes(port)) {
      writeState(p, { ...s, hostPort: port })
      return port
    }
    lastError = said
  }
  throw new Error(`could not forward a host port to the agent: ${lastError}`)
}

/**
 * For qemu.launch: put the forward back in a QEMU that was just started, for
 * an instance that has an agent. A no-op otherwise. Never throws — a guest
 * without its forward is still a working guest, and `connect` retries it.
 */
export async function restoreForward(p: Paths): Promise<void> {
  if (readState(p) === null) return
  try {
    await ensureForward(p)
  } catch (error) {
    console.warn(`warning: agent port forward not restored (${error instanceof Error ? error.message : String(error)})`)
  }
}
