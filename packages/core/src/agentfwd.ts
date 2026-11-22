import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"

import { GUEST_PORT } from "./guestagent"
import type { Paths } from "./paths"
import * as qmp from "./qmp"
import { readSmb, SMB_GUEST_PORT, writeSmb } from "./smbstate"

export interface AgentState {
  readonly token: string
  readonly hostPort: number | null
}

export const statePath = (p: Paths): string => resolve(p.dir, "agent.json")

export function readState(p: Paths): AgentState | null {
  const f = statePath(p)
  if (!existsSync(f)) return null
  try {
    const s = JSON.parse(readFileSync(f, "utf8")) as Partial<AgentState>
    if (typeof s.token !== "string" || s.token === "") return null
    return {
      token: s.token,
      hostPort: typeof s.hostPort === "number" ? s.hostPort : null,
    }
  } catch {
    return null
  }
}

export function writeState(p: Paths, s: AgentState): void {
  const f = statePath(p)
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
  chmodSync(f, 0o600)
}

export function ensureState(p: Paths): AgentState {
  const s = readState(p)
  if (s !== null) return s
  const fresh: AgentState = {
    token: randomBytes(32).toString("hex"),
    hostPort: null,
  }
  writeState(p, fresh)
  return fresh
}

export async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer()
    srv.once("error", rej)
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address()
      const port = typeof a === "object" && a !== null ? a.port : 0
      srv.close(() => {
        res(port)
      })
    })
  })
}

export const NETDEV = "net0"

export const hostfwdRule = (
  hostPort: number,
  guestPort: number = GUEST_PORT,
): string => `tcp:127.0.0.1:${String(hostPort)}-:${String(guestPort)}`

export function forwardedPorts(
  usernet: string,
  guestPort: number = GUEST_PORT,
): readonly number[] {
  const ports: number[] = []
  for (const line of usernet.split(/\r?\n/)) {
    const m =
      /^\s*TCP\[HOST_FORWARD\]\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s/.exec(line)
    if (m !== null && Number(m[2]) === guestPort) ports.push(Number(m[1]))
  }
  return ports
}

export async function forwardPort(
  p: Paths,
  guestPort: number,
  wanted: number | null,
): Promise<number> {
  const present = forwardedPorts(
    await qmp.hmp(p.qmp, "info usernet"),
    guestPort,
  )
  if (wanted !== null && present.includes(wanted)) return wanted
  for (const stale of present)
    await qmp.hmp(
      p.qmp,
      `hostfwd_remove ${NETDEV} tcp:127.0.0.1:${String(stale)}`,
    )
  let lastError = ""
  for (const port of [
    wanted ?? (await freePort()),
    await freePort(),
    await freePort(),
  ]) {
    const said = await qmp
      .hmp(p.qmp, `hostfwd_add ${NETDEV} ${hostfwdRule(port, guestPort)}`)
      .catch((e: unknown) => String(e))
    if (
      said === "" ||
      forwardedPorts(await qmp.hmp(p.qmp, "info usernet"), guestPort).includes(
        port,
      )
    )
      return port
    lastError = said
  }
  throw new Error(
    `could not forward a host port to the guest's port ${String(guestPort)}: ${lastError}`,
  )
}

export async function ensureForward(p: Paths): Promise<number> {
  const s = ensureState(p)
  const port = await forwardPort(p, GUEST_PORT, s.hostPort)
  if (port !== s.hostPort) writeState(p, { ...s, hostPort: port })
  return port
}

export async function ensureSmbForward(p: Paths): Promise<number> {
  const s = readSmb(p)
  if (s === null)
    throw new Error("this instance has never shared its drives with the Mac")
  const port = await forwardPort(p, SMB_GUEST_PORT, s.hostPort)
  if (port !== s.hostPort) writeSmb(p, { ...s, hostPort: port })
  return port
}

export async function restoreForward(p: Paths): Promise<void> {
  if (readState(p) !== null) {
    try {
      await ensureForward(p)
    } catch (error) {
      console.warn(
        `warning: agent port forward not restored (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
  if (readSmb(p) !== null) {
    try {
      await ensureSmbForward(p)
    } catch (error) {
      console.warn(
        `warning: file sharing port forward not restored (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
}
