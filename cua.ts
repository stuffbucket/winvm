/**
 * Claude's computer-use tool, executed against a guest: every action of the
 * computer toolset (`computer_toolset_20260801`, and the earlier
 * `computer_20251124` tool's `{action, ...}` form) mapped onto the QMP
 * primitives in input.ts.
 *
 *   screenshot              QMP screendump -> PNG, scaled to fit the model's box
 *   zoom {region}           a region at full resolution, scaled to the same box
 *   left/right/middle/double/triple_click {coordinate?, text?}
 *   left_click_drag {start_coordinate, coordinate, text?}
 *   mouse_move {coordinate}, left_mouse_down, left_mouse_up, cursor_position
 *   scroll {scroll_direction, scroll_amount, coordinate?, text?}
 *   type {text}, key {text, repeat?}, hold_key {text, duration}, wait {duration}
 *
 * COORDINATES. The model sees screenshots no larger than the box (default
 * 1280x800; the toolset takes no display size, so the screenshots ARE the
 * coordinate space) and answers in their pixels. `scale` is screenshot pixels
 * per framebuffer pixel (<= 1); a coordinate goes back to the framebuffer as
 * x / scale. Screenshots that already fit are sent as QEMU encodes them.
 *
 * KEYS are xdotool keysym names ("Return", "ctrl+s", "alt+Tab", "Page_Down",
 * "super"), case-insensitive, `+`-joined, mapped to QMP qcodes. Typing goes
 * through input.ts's US-layout table and refuses characters it can't type.
 *
 * The pure parts (scaling, key names, resampling, PNG encoding) are exported
 * for tests; `Computer` is the stateful executor that cuacmds.ts serves and
 * drives.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { deflateSync } from "node:zlib"

import * as input from "./input"
import { withQmp } from "./monitor"
import type { QmpSend } from "./monitor"
import type { Paths } from "./paths"

export interface Size {
  readonly width: number
  readonly height: number
}

/** The box screenshots are fitted into by default: a recommended computer-use size. */
export const DEFAULT_BOX: Size = { width: 1280, height: 800 }

// ---------------------------------------------------------------------------
// Scaling

/** Screenshot pixels per framebuffer pixel: the largest scale <= 1 that fits `native` in `box`. */
export function fitScale(native: Size, box: Size): number {
  return Math.min(1, box.width / native.width, box.height / native.height)
}

/** The screenshot size for a framebuffer at `scale`. */
export const scaled = (native: Size, scale: number): Size =>
  scale >= 1 ? native : { width: Math.max(1, Math.round(native.width * scale)), height: Math.max(1, Math.round(native.height * scale)) }

/** A model coordinate -> the framebuffer pixel it names, clamped onto the screen. */
export function toNative(x: number, y: number, scale: number, native: Size): { x: number; y: number } {
  const clamp = (v: number, n: number): number => Math.min(Math.max(Math.round(v), 0), n - 1)
  return { x: clamp(x / scale, native.width), y: clamp(y / scale, native.height) }
}

/** A framebuffer pixel -> model coordinates. */
export const toModel = (x: number, y: number, scale: number): { x: number; y: number } => ({ x: Math.round(x * scale), y: Math.round(y * scale) })

// ---------------------------------------------------------------------------
// Keys: xdotool keysym names -> QMP qcodes

const KEYSYMS: Readonly<Record<string, string>> = {
  // modifiers
  ctrl: "ctrl", control: "ctrl", control_l: "ctrl", control_r: "ctrl_r", ctrl_l: "ctrl", ctrl_r: "ctrl_r",
  shift: "shift", shift_l: "shift", shift_r: "shift_r",
  alt: "alt", alt_l: "alt", alt_r: "alt_r", option: "alt", altgr: "alt_r", iso_level3_shift: "alt_r",
  super: "meta_l", super_l: "meta_l", super_r: "meta_r", meta: "meta_l", meta_l: "meta_l", meta_r: "meta_r",
  win: "meta_l", windows: "meta_l", cmd: "meta_l", command: "meta_l", hyper_l: "meta_l",
  // editing and navigation
  return: "ret", enter: "ret", ret: "ret", kp_enter: "kp_enter", linefeed: "ret",
  tab: "tab", escape: "esc", esc: "esc", backspace: "backspace", delete: "delete", del: "delete",
  insert: "insert", ins: "insert", home: "home", end: "end",
  prior: "pgup", page_up: "pgup", pageup: "pgup", pgup: "pgup",
  next: "pgdn", page_down: "pgdn", pagedown: "pgdn", pgdn: "pgdn",
  up: "up", down: "down", left: "left", right: "right",
  space: "spc", spc: "spc",
  menu: "menu", apps: "menu", print: "print", sys_req: "sysrq", pause: "pause", break: "pause",
  caps_lock: "caps_lock", num_lock: "num_lock", scroll_lock: "scroll_lock",
  // punctuation by keysym name (unshifted)
  minus: "minus", equal: "equal", bracketleft: "bracket_left", bracketright: "bracket_right",
  backslash: "backslash", semicolon: "semicolon", apostrophe: "apostrophe", quoteright: "apostrophe",
  grave: "grave_accent", quoteleft: "grave_accent", comma: "comma", period: "dot", slash: "slash",
  // keypad
  kp_add: "kp_add", kp_subtract: "kp_subtract", kp_multiply: "kp_multiply", kp_divide: "kp_divide",
  kp_decimal: "kp_decimal", kp_equal: "kp_equals",
  // media
  xf86audiomute: "audiomute", xf86audiolowervolume: "volumedown", xf86audioraisevolume: "volumeup",
  xf86audioplay: "audioplay", xf86audionext: "audionext", xf86audioprev: "audioprev", xf86audiostop: "audiostop",
}

/** Keysym names of shifted characters: the key they share, pressed with shift. */
const SHIFTED_KEYSYMS: Readonly<Record<string, string>> = {
  exclam: "!", at: "@", numbersign: "#", dollar: "$", percent: "%", asciicircum: "^", ampersand: "&",
  asterisk: "*", parenleft: "(", parenright: ")", underscore: "_", plus: "+", braceleft: "{", braceright: "}",
  bar: "|", colon: ":", quotedbl: '"', less: "<", greater: ">", question: "?", asciitilde: "~",
}

/** One key name -> its qcodes (shifted characters bring their shift). Null if unknown. */
export function keysymToQcodes(name: string): readonly string[] | null {
  const lower = name.toLowerCase()
  const named = KEYSYMS[lower]
  if (named !== undefined) return [named]
  if (lower === "iso_left_tab") return ["shift", "tab"]
  const fn = /^f([1-9]|1[0-2])$/.exec(lower)
  if (fn !== null) return [lower]
  const kp = /^kp_([0-9])$/.exec(lower)
  if (kp !== null) return [`kp_${String(kp[1])}`]
  const shiftedChar = SHIFTED_KEYSYMS[lower]
  const ch = shiftedChar ?? (name.length === 1 ? name : null)
  if (ch === null) return null
  // A letter names its key whatever its case ("ctrl+S" is ctrl+s, as in xdotool).
  const stroke = input.charToStroke(/^[A-Za-z]$/.test(ch) ? ch.toLowerCase() : ch)
  if (stroke === null || stroke.qcode === "ret" || stroke.qcode === "tab") return null
  return stroke.shift ? ["shift", stroke.qcode] : [stroke.qcode]
}

/** "ctrl+shift+Escape" -> qcodes in press order (duplicates dropped). The unknown part names itself. */
export function parseKeys(combo: string): { qcodes: readonly string[]; unknown: string | null } {
  const parts = combo.trim().split(/(?<=.)\+(?=.)/).map((x) => x.trim()).filter((x) => x !== "")
  if (parts.length === 0) return { qcodes: [], unknown: combo }
  const qcodes: string[] = []
  for (const part of parts) {
    const q = keysymToQcodes(part)
    if (q === null) return { qcodes: [], unknown: part }
    for (const c of q) if (!qcodes.includes(c)) qcodes.push(c)
  }
  return { qcodes, unknown: null }
}

// ---------------------------------------------------------------------------
// Images: raw PPM in, resampled RGB, PNG out

export interface Rgb extends Size {
  /** width * height * 3 bytes, rows top to bottom. */
  readonly data: Uint8Array
}

/** Decode a binary P6 PPM (maxval 255), as QEMU's screendump writes it. */
export function parsePpm(buf: Uint8Array): Rgb {
  const head = Buffer.from(buf.subarray(0, 64)).toString("latin1")
  const m = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(head)
  if (m === null || m[3] !== "255") throw new Error("not a P6 PPM with maxval 255")
  const width = Number(m[1])
  const height = Number(m[2])
  const off = m[0].length
  if (buf.length < off + width * height * 3) throw new Error("PPM is truncated")
  return { width, height, data: buf.subarray(off, off + width * height * 3) }
}

/** Crop to [x0, y0, x1, y1) (clamped). */
export function crop(img: Rgb, x0: number, y0: number, x1: number, y1: number): Rgb {
  const ax = Math.max(0, Math.min(img.width - 1, Math.floor(Math.min(x0, x1))))
  const ay = Math.max(0, Math.min(img.height - 1, Math.floor(Math.min(y0, y1))))
  const bx = Math.max(ax + 1, Math.min(img.width, Math.ceil(Math.max(x0, x1))))
  const by = Math.max(ay + 1, Math.min(img.height, Math.ceil(Math.max(y0, y1))))
  const w = bx - ax
  const h = by - ay
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    const s = ((ay + y) * img.width + ax) * 3
    out.set(img.data.subarray(s, s + w * 3), y * w * 3)
  }
  return { width: w, height: h, data: out }
}

/**
 * Resample to `w` x `h`: an area average when shrinking (text stays legible
 * rather than aliasing), bilinear when growing (a zoomed region).
 */
export function resize(img: Rgb, w: number, h: number): Rgb {
  if (w === img.width && h === img.height) return img
  const src = img.data
  const sw = img.width
  const sh = img.height
  const out = new Uint8Array(w * h * 3)
  if (w <= sw && h <= sh) {
    const fx = sw / w
    const fy = sh / h
    for (let y = 0; y < h; y += 1) {
      const y0 = Math.floor(y * fy)
      const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * fy)))
      for (let x = 0; x < w; x += 1) {
        const x0 = Math.floor(x * fx)
        const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * fx)))
        let r = 0
        let g = 0
        let b = 0
        for (let yy = y0; yy < y1; yy += 1) {
          let i = (yy * sw + x0) * 3
          for (let xx = x0; xx < x1; xx += 1) {
            r += src[i] ?? 0
            g += src[i + 1] ?? 0
            b += src[i + 2] ?? 0
            i += 3
          }
        }
        const n = (y1 - y0) * (x1 - x0)
        const o = (y * w + x) * 3
        out[o] = Math.round(r / n)
        out[o + 1] = Math.round(g / n)
        out[o + 2] = Math.round(b / n)
      }
    }
    return { width: w, height: h, data: out }
  }
  const fx = sw / w
  const fy = sh / h
  for (let y = 0; y < h; y += 1) {
    const sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * fy - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const ty = sy - y0
    for (let x = 0; x < w; x += 1) {
      const sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * fx - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const tx = sx - x0
      const o = (y * w + x) * 3
      for (let c = 0; c < 3; c += 1) {
        const a = (src[(y0 * sw + x0) * 3 + c] ?? 0) * (1 - tx) + (src[(y0 * sw + x1) * 3 + c] ?? 0) * tx
        const b = (src[(y1 * sw + x0) * 3 + c] ?? 0) * (1 - tx) + (src[(y1 * sw + x1) * 3 + c] ?? 0) * tx
        out[o + c] = Math.round(a * (1 - ty) + b * ty)
      }
    }
  }
  return { width: w, height: h, data: out }
}

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(parts: readonly Uint8Array[]): number {
  let c = 0xffffffff
  for (const p of parts) for (const byte of p) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32([head.subarray(4), data]), 0)
  return Buffer.concat([head, data, tail])
}

/** An RGB image as an 8-bit truecolor PNG (the Sub filter on every row). */
export function encodePng(img: Rgb): Buffer {
  const { width: w, height: h, data } = img
  const stride = w * 3
  const raw = new Uint8Array((stride + 1) * h)
  for (let y = 0; y < h; y += 1) {
    const o = y * (stride + 1)
    const s = y * stride
    raw[o] = 1
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 3 ? (data[s + i - 3] ?? 0) : 0
      raw[o + 1 + i] = ((data[s + i] ?? 0) - left) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 3 })),
    chunk("IEND", new Uint8Array(0)),
  ])
}

// ---------------------------------------------------------------------------
// Actions

/** A tool_result content block, as the Messages API takes it. */
export type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: "image/png"; readonly data: string } }

export interface Result {
  readonly content: readonly Block[]
  readonly isError: boolean
  /** Milliseconds: `total`, and for screenshots `capture` and `encode`. */
  readonly ms: Readonly<Record<string, number>>
}

export class ActionError extends Error {}

export const ACTIONS = [
  "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
  "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position",
  "scroll", "type", "key", "hold_key", "wait",
] as const
export type ActionName = (typeof ACTIONS)[number]

export const isAction = (s: string): s is ActionName => (ACTIONS as readonly string[]).includes(s)

type Params = Readonly<Record<string, unknown>>

/**
 * A request in either shape — `{action: "left_click", coordinate: [..]}` (the
 * earlier tool, and this server's wire format) or a toolset member's name plus
 * its input — as one action.
 */
export function normalize(nameOrBody: string | Params, maybeInput?: Params): { action: string; params: Params } {
  if (typeof nameOrBody === "string") return { action: nameOrBody, params: maybeInput ?? {} }
  const { action, ...params } = nameOrBody
  return { action: typeof action === "string" ? action : "", params }
}

/** [x, y] from a parameter, or an ActionError naming it. */
export function point(params: Params, key: string): { x: number; y: number } {
  const v = params[key]
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new ActionError(`${key} must be [x, y]`)
  }
  return { x: v[0] as number, y: v[1] as number }
}

const optPoint = (params: Params, key: string): { x: number; y: number } | null => (params[key] === undefined ? null : point(params, key))

function str(params: Params, key: string): string {
  const v = params[key]
  if (typeof v !== "string" || v === "") throw new ActionError(`${key} must be a non-empty string`)
  return v
}

function num(params: Params, key: string, lo: number, hi: number, fallback?: number): number {
  const v = params[key] ?? fallback
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
    throw new ActionError(`${key} must be a number from ${String(lo)} to ${String(hi)}`)
  }
  return v
}

/** Modifier keys from a click/scroll's `text` ("shift", "ctrl+shift"), as qcodes. */
export function modifiers(params: Params): readonly string[] {
  const t = params["text"]
  if (t === undefined || t === null || t === "") return []
  if (typeof t !== "string") throw new ActionError("text (modifier keys) must be a string")
  const { qcodes, unknown } = parseKeys(t)
  if (unknown !== null) throw new ActionError(`unknown modifier key "${unknown}"`)
  return qcodes
}

const ok = (ms: Record<string, number>): Result => ({ content: [{ type: "text", text: "OK" }], isError: false, ms })
const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

/**
 * The executor. Holds what QMP can't be asked for — where the pointer is —
 * and the framebuffer size from the last screenshot, so an action after a
 * screenshot needs no extra screendump to scale its coordinates. Not
 * reentrant: callers run one action at a time (QMP takes one client anyway).
 */
export class Computer {
  readonly p: Paths
  readonly box: Size
  private nativeSize: Size | null = null
  /** The pointer, in framebuffer pixels; null until something moves it. */
  private cursor: { x: number; y: number } | null = null
  private readonly scratch: string

  constructor(p: Paths, box: Size = DEFAULT_BOX) {
    this.p = p
    this.box = box
    this.scratch = resolve(tmpdir(), `winvm-cua-${String(process.pid)}`)
  }

  /** The framebuffer size, the scale, and the screenshot size the model works in. */
  async display(): Promise<{ native: Size; scale: number; size: Size }> {
    const native = this.nativeSize ?? (await withQmp(this.p.qmp, async (q) => await input.screenSize(q), 10_000))
    this.nativeSize = native
    const scale = fitScale(native, this.box)
    return { native, scale, size: scaled(native, scale) }
  }

  /** Run one action. Bad input and failures come back as `isError` results, never thrown. */
  async run(nameOrBody: string | Params, maybeInput?: Params): Promise<Result> {
    const t0 = performance.now()
    const { action, params } = normalize(nameOrBody, maybeInput)
    try {
      if (!isAction(action)) throw new ActionError(`unknown action "${action}"`)
      const r = await this.dispatch(action, params)
      return { ...r, ms: { ...r.ms, total: performance.now() - t0 } }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return { content: [{ type: "text", text }], isError: true, ms: { total: performance.now() - t0 } }
    }
  }

  private async dispatch(action: ActionName, params: Params): Promise<Result> {
    switch (action) {
      case "screenshot":
        return await this.screenshot(null)
      case "zoom": {
        const r = params["region"]
        if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === "number" && Number.isFinite(n))) {
          throw new ActionError("region must be [x0, y0, x1, y1]")
        }
        return await this.screenshot(r as [number, number, number, number])
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const button: input.Button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left"
        const clicks = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1
        await this.click(optPoint(params, "coordinate"), button, clicks, modifiers(params))
        return ok({})
      }
      case "left_click_drag": {
        const from = point(params, "start_coordinate")
        const to = point(params, "coordinate")
        await this.drag(from, to, modifiers(params))
        return ok({})
      }
      case "mouse_move":
        await this.move(point(params, "coordinate"))
        return ok({})
      case "left_mouse_down":
      case "left_mouse_up":
        await withQmp(this.p.qmp, async (q) => {
          await input.send(q, [input.btnEv("left", action === "left_mouse_down")])
        }, 10_000)
        return ok({})
      case "cursor_position": {
        if (this.cursor === null) return { content: [{ type: "text", text: "unknown: nothing has moved the pointer yet" }], isError: false, ms: {} }
        const { scale } = await this.display()
        const m = toModel(this.cursor.x, this.cursor.y, scale)
        return { content: [{ type: "text", text: `X=${String(m.x)}, Y=${String(m.y)}` }], isError: false, ms: {} }
      }
      case "scroll": {
        const dir = params["scroll_direction"]
        if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
          throw new ActionError('scroll_direction must be "up", "down", "left" or "right"')
        }
        const amount = Math.round(num(params, "scroll_amount", 0, 100, 3))
        await this.scroll(optPoint(params, "coordinate"), dir, amount, modifiers(params))
        return ok({})
      }
      case "type": {
        const text = params["text"]
        if (typeof text !== "string") throw new ActionError("text must be a string")
        const { strokes, bad } = input.textToStrokes(text)
        if (bad.length > 0) throw new ActionError(`can't type ${bad.map((c) => JSON.stringify(c)).join(", ")}: the guest's keyboard is US-layout, ASCII only`)
        await input.typeText(this.p, strokes)
        return ok({})
      }
      case "key": {
        const { qcodes, unknown } = parseKeys(str(params, "text"))
        if (unknown !== null) throw new ActionError(`unknown key "${unknown}"`)
        const repeat = Math.round(num(params, "repeat", 1, 100, 1))
        for (let i = 0; i < repeat; i += 1) await input.pressCombo(this.p, qcodes)
        return ok({})
      }
      case "hold_key": {
        const { qcodes, unknown } = parseKeys(str(params, "text"))
        if (unknown !== null) throw new ActionError(`unknown key "${unknown}"`)
        const seconds = num(params, "duration", 0, 300)
        await withQmp(this.p.qmp, async (q) => {
          for (const k of qcodes) await input.send(q, [input.keyEv(k, true)])
          await sleep(seconds * 1000)
          for (const k of [...qcodes].reverse()) await input.send(q, [input.keyEv(k, false)])
        }, 10_000)
        return ok({})
      }
      case "wait":
        await sleep(num(params, "duration", 0, 300) * 1000)
        return ok({})
    }
  }

  /**
   * The screen (or, with a region in model coordinates, part of it at full
   * resolution) as a PNG no larger than the model's screenshot size.
   */
  private async screenshot(region: readonly [number, number, number, number] | null): Promise<Result> {
    mkdirSync(this.scratch, { recursive: true })
    const t0 = performance.now()
    // When nothing needs scaling, QEMU's own PNG is the cheapest path.
    const known = this.nativeSize
    const direct = region === null && known !== null && fitScale(known, this.box) === 1
    const file = resolve(this.scratch, direct ? "shot.png" : "shot.ppm")
    try {
      await withQmp(this.p.qmp, async (q) => await q("screendump", direct ? { filename: file, format: "png" } : { filename: file }), 30_000)
      const raw = readFileSync(file)
      const t1 = performance.now()
      let png: Buffer
      if (direct) {
        const size = input.pngSize(raw)
        if (size === null) throw new Error("QEMU's screendump isn't a PNG")
        this.nativeSize = size
        if (fitScale(size, this.box) !== 1) return await this.screenshot(null) // the screen grew
        png = raw
      } else {
        const img = parsePpm(raw)
        this.nativeSize = { width: img.width, height: img.height }
        const scale = fitScale(img, this.box)
        const out = scaled(img, scale)
        if (region === null) {
          png = encodePng(resize(img, out.width, out.height))
        } else {
          const a = toNative(region[0], region[1], scale, img)
          const b = toNative(region[2], region[3], scale, img)
          const part = crop(img, a.x, a.y, b.x + 1, b.y + 1)
          // Fit the region into the screenshot size, aspect ratio kept.
          const f = Math.min(out.width / part.width, out.height / part.height)
          png = encodePng(resize(part, Math.max(1, Math.round(part.width * f)), Math.max(1, Math.round(part.height * f))))
        }
      }
      const t2 = performance.now()
      return {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }],
        isError: false,
        ms: { capture: t1 - t0, encode: t2 - t1 },
      }
    } finally {
      rmSync(file, { force: true })
    }
  }

  /** Move the tablet to a model coordinate, and remember where it went. */
  private async moveWith(q: QmpSend, at: { x: number; y: number }): Promise<void> {
    const { native, scale } = await this.display()
    const n = toNative(at.x, at.y, scale, native)
    await input.send(q, [input.absEv("x", input.scaleAxis(n.x, native.width)), input.absEv("y", input.scaleAxis(n.y, native.height))])
    this.cursor = n
  }

  private async move(at: { x: number; y: number }): Promise<void> {
    await this.display()
    await withQmp(this.p.qmp, async (q) => {
      await this.moveWith(q, at)
    }, 10_000)
  }

  private async withModifiers(q: QmpSend, mods: readonly string[], fn: () => Promise<void>): Promise<void> {
    for (const k of mods) await input.send(q, [input.keyEv(k, true)])
    if (mods.length > 0) await sleep(input.GAP_MS)
    try {
      await fn()
    } finally {
      for (const k of [...mods].reverse()) await input.send(q, [input.keyEv(k, false)])
    }
  }

  private async click(at: { x: number; y: number } | null, button: input.Button, clicks: number, mods: readonly string[]): Promise<void> {
    await this.display()
    await withQmp(this.p.qmp, async (q) => {
      if (at !== null) {
        await this.moveWith(q, at)
        await sleep(input.GAP_MS * 2)
      }
      await this.withModifiers(q, mods, async () => {
        for (let i = 0; i < clicks; i += 1) {
          await input.send(q, [input.btnEv(button, true)])
          await sleep(input.GAP_MS)
          await input.send(q, [input.btnEv(button, false)])
          await sleep(input.GAP_MS * 2)
        }
      })
    }, 10_000)
  }

  private async drag(from: { x: number; y: number }, to: { x: number; y: number }, mods: readonly string[]): Promise<void> {
    await this.display()
    await withQmp(this.p.qmp, async (q) => {
      await this.moveWith(q, from)
      await sleep(input.GAP_MS * 2)
      await this.withModifiers(q, mods, async () => {
        await input.send(q, [input.btnEv("left", true)])
        await sleep(input.GAP_MS * 2)
        // A few steps on the way, so the app sees a drag rather than a jump.
        const steps = 8
        for (let i = 1; i <= steps; i += 1) {
          await this.moveWith(q, { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps })
          await sleep(15)
        }
        await sleep(input.GAP_MS * 2)
        await input.send(q, [input.btnEv("left", false)])
      })
    }, 10_000)
  }

  /** Wheel notches. Left/right is shift+wheel: the USB tablet has no horizontal wheel. */
  private async scroll(at: { x: number; y: number } | null, dir: "up" | "down" | "left" | "right", amount: number, mods: readonly string[]): Promise<void> {
    await this.display()
    const horizontal = dir === "left" || dir === "right"
    const wheel = dir === "up" || dir === "left" ? "wheel-up" : "wheel-down"
    const all = horizontal && !mods.includes("shift") ? [...mods, "shift"] : mods
    await withQmp(this.p.qmp, async (q) => {
      if (at !== null) {
        await this.moveWith(q, at)
        await sleep(input.GAP_MS)
      }
      await this.withModifiers(q, all, async () => {
        for (let i = 0; i < amount; i += 1) {
          await input.send(q, [input.btnEv(wheel, true)])
          await sleep(input.GAP_MS)
          await input.send(q, [input.btnEv(wheel, false)])
          await sleep(input.GAP_MS)
        }
      })
    }, 10_000)
  }

  /** Drop the scratch directory. */
  close(): void {
    rmSync(this.scratch, { recursive: true, force: true })
  }
}
