/**
 * Drive the guest with no window open: screenshots, keys, typing, the mouse.
 *
 * Everything goes through QEMU's monitor, not VNC, so it needs no client, no
 * password and no display server, and works the same whether or not anyone is
 * watching. The guest has a USB keyboard and a USB TABLET (absolute pointer),
 * so a click lands exactly where it is aimed rather than wherever relative
 * mouse motion drifts to.
 *
 * COORDINATES ARE SCREENSHOT PIXELS. `screenshot` saves the framebuffer as it
 * is; `click 412 300` clicks that pixel. The tablet itself speaks 0..32767 on
 * each axis, so every pointer command reads the current framebuffer size (a
 * raw PPM screendump, ~60 ms) and scales — the same formula QEMU's own VNC
 * server uses — and a resolution change can't skew aim.
 *
 * Typing assumes the guest's US keyboard layout, which is what the answer file
 * installs. Characters a US keyboard can't produce are refused up front rather
 * than typed as something else.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { withQmp } from "./monitor"
import type { QmpSend } from "./monitor"
import type { Paths } from "./paths"

/** QEMU's absolute-axis range (INPUT_EVENT_ABS_MAX). */
export const ABS_MAX = 0x7fff

// ---------------------------------------------------------------------------
// Pure pieces

/** Pixel -> tablet axis value, as QEMU's qemu_input_scale_axis does it. */
export function scaleAxis(px: number, size: number): number {
  if (size <= 1) return 0
  const clamped = Math.min(Math.max(px, 0), size - 1)
  return Math.round((clamped * ABS_MAX) / (size - 1))
}

/** Width and height from a binary PPM header ("P6\n<w> <h>\n<max>\n"). */
export function ppmSize(header: Buffer | string): { width: number; height: number } | null {
  const text = typeof header === "string" ? header : header.subarray(0, 64).toString("latin1")
  const m = /^P6\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s/.exec(text)
  return m === null ? null : { width: Number(m[1]), height: Number(m[2]) }
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const UNSHIFTED: Record<string, string> = {
  " ": "spc",
  "\n": "ret",
  "\t": "tab",
  "-": "minus",
  "=": "equal",
  "[": "bracket_left",
  "]": "bracket_right",
  "\\": "backslash",
  ";": "semicolon",
  "'": "apostrophe",
  ",": "comma",
  ".": "dot",
  "/": "slash",
  "`": "grave_accent",
}
const SHIFTED: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "minus",
  "+": "equal",
  "{": "bracket_left",
  "}": "bracket_right",
  "|": "backslash",
  ":": "semicolon",
  '"': "apostrophe",
  "<": "comma",
  ">": "dot",
  "?": "slash",
  "~": "grave_accent",
}

export interface Stroke {
  readonly qcode: string
  readonly shift: boolean
}

/** One character -> the key that types it on a US layout, or null. */
export function charToStroke(ch: string): Stroke | null {
  if (/^[a-z0-9]$/.test(ch)) return { qcode: ch, shift: false }
  if (/^[A-Z]$/.test(ch)) return { qcode: ch.toLowerCase(), shift: true }
  const u = UNSHIFTED[ch]
  if (u !== undefined) return { qcode: u, shift: false }
  const s = SHIFTED[ch]
  if (s !== undefined) return { qcode: s, shift: true }
  if (ch === "\r") return null
  return null
}

/** Every stroke for `text`, or the characters that can't be typed. */
export function textToStrokes(text: string): { strokes: readonly Stroke[]; bad: readonly string[] } {
  const strokes: Stroke[] = []
  const bad: string[] = []
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const s = charToStroke(ch)
    if (s === null) bad.push(ch)
    else strokes.push(s)
  }
  return { strokes, bad: [...new Set(bad)] }
}

const KEY_NAMES: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  rctrl: "ctrl_r",
  alt: "alt",
  option: "alt",
  altgr: "alt_r",
  shift: "shift",
  rshift: "shift_r",
  win: "meta_l",
  windows: "meta_l",
  meta: "meta_l",
  super: "meta_l",
  cmd: "meta_l",
  del: "delete",
  delete: "delete",
  enter: "ret",
  return: "ret",
  ret: "ret",
  esc: "esc",
  escape: "esc",
  tab: "tab",
  space: "spc",
  spc: "spc",
  backspace: "backspace",
  bksp: "backspace",
  insert: "insert",
  ins: "insert",
  home: "home",
  end: "end",
  pgup: "pgup",
  pageup: "pgup",
  pgdn: "pgdn",
  pagedown: "pgdn",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  menu: "menu",
  print: "print",
  printscreen: "print",
  prtsc: "print",
  capslock: "caps_lock",
  minus: "minus",
  plus: "equal",
  equal: "equal",
}

/**
 * "ctrl-alt-delete", "win+r", "F5", "enter" -> qcodes, pressed in order and
 * released in reverse. Null names the part that wasn't understood.
 */
export function parseCombo(combo: string): { qcodes: readonly string[]; unknown: string | null } {
  const parts = combo
    .trim()
    .split(/(?<=.)[-+](?=.)/)
    .map((x) => x.trim())
    .filter((x) => x !== "")
  const qcodes: string[] = []
  for (const part of parts) {
    const lower = part.toLowerCase()
    const named = KEY_NAMES[lower]
    if (named !== undefined) {
      qcodes.push(named)
      continue
    }
    if (/^f([1-9]|1[0-2])$/.test(lower)) {
      qcodes.push(lower)
      continue
    }
    const stroke = part.length === 1 ? charToStroke(part.toLowerCase()) : null
    if (stroke !== null && !stroke.shift) {
      qcodes.push(stroke.qcode)
      continue
    }
    return { qcodes: [], unknown: part }
  }
  return { qcodes, unknown: parts.length === 0 ? combo : null }
}

// ---------------------------------------------------------------------------
// Talking to QEMU

export type Event = Record<string, unknown>
export const keyEv = (qcode: string, down: boolean): Event => ({ type: "key", data: { down, key: { type: "qcode", data: qcode } } })
export const absEv = (axis: "x" | "y", value: number): Event => ({ type: "abs", data: { axis, value } })
export const btnEv = (button: string, down: boolean): Event => ({ type: "btn", data: { down, button } })

/**
 * A gap between press and release. Too short and the USB HID poll can see
 * neither; under heavy host load the guest needs a little more.
 */
export const GAP_MS = 30
const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

export async function send(q: QmpSend, events: readonly Event[]): Promise<void> {
  await q("input-send-event", { events: [...events] })
}

/**
 * The keys and buttons a session has pressed and not yet released.
 *
 * WHY. QEMU's keyboard and tablet are shared by every input source (the app's
 * VNC session, `winvm key`, an agent over MCP), and a key or button that went
 * down through QMP can only come up through QMP: the VNC client's own "all keys
 * up" does not know about it. So a session that dies between a press and its
 * release (the monitor stopped answering for 10 s, the connection dropped, a
 * later step threw) would leave Ctrl, Shift, Windows or the left button held in
 * the guest, and from then on typing turns into shortcuts, or the pointer
 * stops clicking: Windows still draws, and the guest looks unresponsive.
 */
export class HeldInput {
  private readonly down = new Map<string, Event>()

  /** Note what `events` do to what is held. */
  track(events: readonly Event[]): void {
    for (const ev of events) {
      if (ev["type"] !== "key" && ev["type"] !== "btn") continue
      const data = ev["data"] as { down?: unknown; key?: { data?: unknown }; button?: unknown } | undefined
      const id = ev["type"] === "key" ? `key:${String(data?.key?.data)}` : `btn:${String(data?.button)}`
      if (data?.down === true) this.down.set(id, ev)
      else this.down.delete(id)
    }
  }

  /** The events that let go of everything still held, last pressed first. */
  releases(): Event[] {
    return [...this.down.values()].reverse().map((ev) => ({ ...ev, data: { ...(ev["data"] as object), down: false } }))
  }
}

/**
 * `withQmp` for sending input: whatever the session left pressed when it ended
 * early (an error, a timeout) is released on a fresh connection before the
 * error goes on. A session that finishes normally has released its own.
 */
export async function withInput<T>(sockPath: string, fn: (send: QmpSend) => Promise<T>, timeoutMs = 3000): Promise<T> {
  const held = new HeldInput()
  try {
    return await withQmp(
      sockPath,
      async (q) =>
        await fn(async (execute, args) => {
          if (execute !== "input-send-event" || !Array.isArray(args?.["events"])) return await q(execute, args)
          const events = args["events"] as Event[]
          // A press is noted before it is sent (one that timed out may still have
          // landed); a release only once it has been, so a failed one is retried.
          held.track(events.filter((ev) => (ev["data"] as { down?: unknown } | undefined)?.down === true))
          const reply = await q(execute, args)
          held.track(events.filter((ev) => (ev["data"] as { down?: unknown } | undefined)?.down !== true))
          return reply
        }),
      timeoutMs,
    )
  } catch (error) {
    const letGo = held.releases()
    if (letGo.length > 0) {
      try {
        await withQmp(sockPath, async (q) => await send(q, letGo), 3000)
      } catch {
        // The monitor is gone or stuck: nothing more can be done from here.
      }
    }
    throw error
  }
}

/** The framebuffer's current size, via a throwaway raw screendump. */
export async function screenSize(q: QmpSend): Promise<{ width: number; height: number }> {
  const tmp = resolve(tmpdir(), `winvm-size-${String(process.pid)}-${String(Date.now())}.ppm`)
  try {
    await q("screendump", { filename: tmp })
    const size = ppmSize(readFileSync(tmp).subarray(0, 64))
    if (size === null) throw new Error("could not read the screen size from a screendump")
    return size
  } finally {
    rmSync(tmp, { force: true })
  }
}

export async function screenshot(p: Paths, file: string): Promise<{ width: number; height: number }> {
  mkdirSync(dirname(file), { recursive: true })
  await withQmp(p.qmp, async (q) => await q("screendump", { filename: file, format: "png" }), 30_000)
  const size = pngSize(readFileSync(file).subarray(0, 32))
  if (size === null) throw new Error(`QEMU wrote ${file}, but it isn't a PNG`)
  return size
}

export async function typeText(p: Paths, strokes: readonly Stroke[]): Promise<void> {
  await withInput(p.qmp, async (q) => {
    for (const s of strokes) {
      await send(q, s.shift ? [keyEv("shift", true), keyEv(s.qcode, true)] : [keyEv(s.qcode, true)])
      await sleep(GAP_MS)
      await send(q, s.shift ? [keyEv(s.qcode, false), keyEv("shift", false)] : [keyEv(s.qcode, false)])
      await sleep(GAP_MS)
    }
  }, 10_000)
}

export async function pressCombo(p: Paths, qcodes: readonly string[]): Promise<void> {
  await withInput(p.qmp, async (q) => {
    for (const k of qcodes) {
      await send(q, [keyEv(k, true)])
      await sleep(GAP_MS)
    }
    await sleep(GAP_MS * 2)
    for (const k of [...qcodes].reverse()) {
      await send(q, [keyEv(k, false)])
      await sleep(GAP_MS)
    }
  }, 10_000)
}

export type Button = "left" | "right" | "middle"

/** Move to a pixel, and optionally click there (`clicks` 2 = double click). */
export async function pointer(p: Paths, x: number, y: number, button: Button | null, clicks = 1): Promise<{ width: number; height: number }> {
  return await withInput(p.qmp, async (q) => {
    const size = await screenSize(q)
    await send(q, [absEv("x", scaleAxis(x, size.width)), absEv("y", scaleAxis(y, size.height))])
    if (button !== null) {
      await sleep(GAP_MS * 2)
      for (let i = 0; i < clicks; i += 1) {
        await send(q, [btnEv(button, true)])
        await sleep(GAP_MS)
        await send(q, [btnEv(button, false)])
        await sleep(GAP_MS * 2)
      }
    }
    return size
  }, 10_000)
}

/** Positive scrolls down (content moves up), negative scrolls up — one wheel notch each. */
export async function scroll(p: Paths, notches: number): Promise<void> {
  const button = notches > 0 ? "wheel-down" : "wheel-up"
  await withInput(p.qmp, async (q) => {
    for (let i = 0; i < Math.abs(notches); i += 1) {
      await send(q, [btnEv(button, true)])
      await sleep(GAP_MS)
      await send(q, [btnEv(button, false)])
      await sleep(GAP_MS)
    }
  }, 10_000)
}
