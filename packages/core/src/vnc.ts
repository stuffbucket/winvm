/**
 * The guest's screen: VNC display numbers, ports, and the password.
 *
 * ## Why there is a VNC password at all
 *
 * Two clients need one, for different reasons:
 *
 *   - macOS SCREEN SHARING will not use a VNC server that offers no
 *     authentication: it asks for a password regardless and then fails, so
 *     `open vnc://127.0.0.1:5901` against a password-less QEMU gets nowhere.
 *     It does speak classic VNC authentication, and takes the password from the
 *     URL (`vnc://:<password>@127.0.0.1:5901`), so `winvm open` connects without
 *     prompting. Lima arrived at the same arrangement for the same reason.
 *   - THE BROWSER VIEW goes through QEMU's websocket listener. Unlike the raw
 *     VNC port, a websocket is reachable from ANY page open in a local browser
 *     — websockets are not bound by the same-origin policy — so without a
 *     password every website you visited could watch, type into and click in
 *     the guest. With one, only a page that was handed the password can.
 *
 * QEMU is started with `password=on`, which refuses every client until a
 * password is set, and `launch` sets it over QMP straight after QEMU starts.
 * `winvm open` sets it again before connecting, which covers a guest started by
 * an older copy of the tool. The password lives in the instance directory
 * (mode 0600); VNC authentication truncates passwords to 8 characters, so it is
 * exactly 8.
 *
 * Everything here is loopback-only. VNC authentication is weak by modern
 * standards (DES challenge-response) and is not meant to protect a port exposed
 * to a network — none is.
 */
import { randomInt } from "node:crypto"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"

import { qmpCommand } from "./monitor"
import type { InstanceMeta, Paths } from "./paths"
import { listInstances, readMeta } from "./paths"

export const VNC_BASE_PORT = 5900
/** QEMU's own convention for `websocket` with no port: 5700 + display. */
export const WEBSOCKET_BASE_PORT = 5700

export const vncPort = (display: number): number => VNC_BASE_PORT + display
export const websocketPort = (display: number): number => WEBSOCKET_BASE_PORT + display

export interface Connection {
  readonly display: number
  readonly vncPort: number
  readonly websocketPort: number
  readonly password: string | null
}

/** Everything a VNC client needs to reach the display. */
export const connection = (display: number, password: string | null): Connection => ({
  display,
  vncPort: vncPort(display),
  websocketPort: websocketPort(display),
  password,
})

/** The `-vnc` argument: loopback only, websocket alongside, password required. */
export function vncArg(display: number): string {
  return `127.0.0.1:${String(display)},websocket=127.0.0.1:${String(websocketPort(display))},password=on`
}

/** Whether nothing on this host listens on the display's VNC or websocket port. */
export async function displayFree(display: number): Promise<boolean> {
  for (const port of [vncPort(display), websocketPort(display)]) {
    const free = await new Promise<boolean>((res) => {
      const s = createServer()
      s.once("error", () => res(false))
      s.listen(port, "127.0.0.1", () => s.close(() => res(true)))
    })
    if (!free) return false
  }
  return true
}

/**
 * The instance's display, moved to a free one when something else on the host
 * holds it.
 *
 * Displays are allocated per WINVM_HOME (paths.allocateVnc), so an instance in
 * another home — or any other VNC server — can hold the same number, and QEMU
 * then fails to bind. Called just before QEMU starts, when this instance is
 * not running, so a busy port is someone else's. The move is written to
 * instance.json, which is where every reader of the display looks.
 */
export async function ensureFreeDisplay(name: string, p: Paths, meta: InstanceMeta): Promise<InstanceMeta> {
  if (await displayFree(meta.vnc)) return meta
  const claimed = new Set(listInstances().filter((n) => n !== name).map((n) => readMeta(n)?.vnc))
  for (let d = 1; d < 100; d += 1) {
    if (claimed.has(d) || !(await displayFree(d))) continue
    const moved: InstanceMeta = { ...meta, vnc: d }
    writeFileSync(p.meta, `${JSON.stringify(moved, null, 2)}\n`)
    console.log(`VNC :${String(meta.vnc)} is in use on this host; instance "${name}" moves to :${String(d)}`)
    return moved
  }
  throw new Error("no free VNC display")
}

export const passwordPath = (p: Paths): string => resolve(p.dir, "vncpassword")

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** 8 characters: VNC authentication ignores anything past that. URL-safe by construction. */
export function generatePassword(): string {
  let s = ""
  for (let i = 0; i < 8; i += 1) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}

/** The instance's password, created on first use. */
export function passwordFor(p: Paths): string {
  try {
    const existing = readFileSync(passwordPath(p), "utf8").trim()
    if (/^[A-Za-z0-9]{8}$/.test(existing)) return existing
  } catch {
    // absent: create it below
  }
  const pw = generatePassword()
  writeFileSync(passwordPath(p), `${pw}\n`, { mode: 0o600 })
  chmodSync(passwordPath(p), 0o600)
  return pw
}

/**
 * Hand QEMU the password. Returns what the running VNC server now expects:
 * the password, or null when this QEMU was started without `password=on`
 * (then it accepts anyone and there is nothing to set).
 */
export async function applyPassword(p: Paths): Promise<string | null> {
  const pw = passwordFor(p)
  try {
    await qmpCommand(p.qmp, "set_password", { protocol: "vnc", password: pw })
    return pw
  } catch (error) {
    // QEMU 11 says "VNC password authentication is disabled" when the display
    // was started without `password=on` (older versions: "Could not set password").
    if (error instanceof Error && /authentication is disabled|could not set password/i.test(error.message)) return null
    throw error
  }
}

/** `vnc://` URL for macOS Screen Sharing, with the password embedded when there is one. */
export function screenSharingUrl(display: number, password: string | null): string {
  const auth = password === null ? "" : `:${encodeURIComponent(password)}@`
  return `vnc://${auth}127.0.0.1:${String(vncPort(display))}`
}
