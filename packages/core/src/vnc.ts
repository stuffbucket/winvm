import { randomInt } from "node:crypto"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"

import { qmpCommand } from "./monitor"
import type { InstanceMeta, Paths } from "./paths"
import { listInstances, readMeta } from "./paths"

export const VNC_BASE_PORT = 5900
export const WEBSOCKET_BASE_PORT = 5700

export const vncPort = (display: number): number => VNC_BASE_PORT + display
export const websocketPort = (display: number): number =>
  WEBSOCKET_BASE_PORT + display

export interface Connection {
  readonly display: number
  readonly vncPort: number
  readonly websocketPort: number
  readonly password: string | null
}

export const connection = (
  display: number,
  password: string | null,
): Connection => ({
  display,
  vncPort: vncPort(display),
  websocketPort: websocketPort(display),
  password,
})

export function vncArg(display: number): string {
  return `127.0.0.1:${String(display)},websocket=127.0.0.1:${String(websocketPort(display))},password=on,lossy=on`
}

export async function displayFree(display: number): Promise<boolean> {
  for (const port of [vncPort(display), websocketPort(display)]) {
    const free = await new Promise<boolean>((res) => {
      const s = createServer()
      s.once("error", () => {
        res(false)
      })
      s.listen(port, "127.0.0.1", () =>
        s.close(() => {
          res(true)
        }),
      )
    })
    if (!free) return false
  }
  return true
}

export async function ensureFreeDisplay(
  name: string,
  p: Paths,
  meta: InstanceMeta,
): Promise<InstanceMeta> {
  if (await displayFree(meta.vnc)) return meta
  const claimed = new Set(
    listInstances()
      .filter((n) => n !== name)
      .map((n) => readMeta(n)?.vnc),
  )
  for (let d = 1; d < 100; d += 1) {
    if (claimed.has(d) || !(await displayFree(d))) continue
    const moved: InstanceMeta = { ...meta, vnc: d }
    writeFileSync(p.meta, `${JSON.stringify(moved, null, 2)}\n`)
    console.log(
      `VNC :${String(meta.vnc)} is in use on this host; instance "${name}" moves to :${String(d)}`,
    )
    return moved
  }
  throw new Error("no free VNC display")
}

export const passwordPath = (p: Paths): string => resolve(p.dir, "vncpassword")

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function generatePassword(): string {
  let s = ""
  for (let i = 0; i < 8; i += 1)
    s += ALPHABET.charAt(randomInt(ALPHABET.length))
  return s
}

export function passwordFor(p: Paths): string {
  try {
    const existing = readFileSync(passwordPath(p), "utf8").trim()
    if (/^[A-Za-z0-9]{8}$/.test(existing)) return existing
  } catch {}
  const pw = generatePassword()
  writeFileSync(passwordPath(p), `${pw}\n`, { mode: 0o600 })
  chmodSync(passwordPath(p), 0o600)
  return pw
}

export async function applyPassword(p: Paths): Promise<string | null> {
  const pw = passwordFor(p)
  try {
    await qmpCommand(p.qmp, "set_password", { protocol: "vnc", password: pw })
    return pw
  } catch (error) {
    if (
      error instanceof Error &&
      /authentication is disabled|could not set password/i.test(error.message)
    )
      return null
    throw error
  }
}

export function screenSharingUrl(
  display: number,
  password: string | null,
): string {
  const auth = password === null ? "" : `:${encodeURIComponent(password)}@`
  return `vnc://${auth}127.0.0.1:${String(vncPort(display))}`
}
