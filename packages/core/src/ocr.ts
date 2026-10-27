/**
 * Read the guest's screen as text — the fallback when there is no DOM
 * (webview.ts) or accessibility tree to ask: native dialogs, the tray menu,
 * toasts, an app that won't expose either.
 *
 *   winvm ocr [-i name] [--find TEXT] [--wait S] [--fast] [--json] [--image f.png]
 *   winvm click [-i name] --text "Quit" [--wait S] [--right|--middle] [--double]
 *
 * A QMP screendump (PNG, framebuffer pixels) goes through macOS Vision
 * (VNRecognizeTextRequest) in a small Swift helper, assets/ocr.swift. The
 * helper is compiled with `swiftc -O` on first use and cached under
 * <WINVM_HOME>/cache/bin, keyed by a hash of its source, so an edit rebuilds
 * it and nothing else ever does. Boxes come back in screenshot pixels — the
 * same coordinates `winvm click` takes — so a match's centre is a click.
 *
 * Matching is case- and diacritic-insensitive. A line that IS the text beats a
 * line that contains it; ties go top to bottom, then left to right. A match
 * inside a longer line is boxed on its own (Vision boxes substrings).
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import type { Args } from "./args"
import { instanceName } from "./args"
import * as input from "./input"
import type { Paths } from "./paths"
import { PACKAGE_DIR, home, pathsFor } from "./paths"
import * as qemu from "./qemu"

export interface TextBox {
  readonly text: string
  readonly confidence: number
  /** [x, y, w, h] in image pixels, origin top left. */
  readonly box: readonly [number, number, number, number]
  /** With a needle: the box of just the matched part of the line. */
  readonly match?: readonly [number, number, number, number]
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const SOURCE = resolve(PACKAGE_DIR, "assets", "ocr.swift")

/** The compiled helper, building it if this source has not been built yet. */
export function helper(): string {
  const src = readFileSync(SOURCE)
  const hash = createHash("sha256").update(src).digest("hex").slice(0, 12)
  const dir = resolve(home(), "cache", "bin")
  const bin = resolve(dir, `winvm-ocr-${hash}`)
  if (existsSync(bin)) return bin
  if (process.platform !== "darwin") throw new Error("OCR needs macOS (Vision)")
  mkdirSync(dir, { recursive: true })
  const tmp = `${bin}.${String(process.pid)}.tmp`
  const r = Bun.spawnSync(["swiftc", "-O", "-o", tmp, SOURCE], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) {
    rmSync(tmp, { force: true })
    throw new Error(`building the OCR helper failed (swiftc; Xcode command-line tools?):\n${r.stderr.toString()}`)
  }
  renameSync(tmp, bin)
  return bin
}

/** Parse the helper's JSON lines. */
export function parseBoxes(out: string): TextBox[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TextBox)
}

/** Recognise the text in an image file. With `find`, only lines containing it (each with a `match` box). */
export async function recognize(image: string, o: { readonly find?: string; readonly fast?: boolean } = {}): Promise<TextBox[]> {
  const argv = [helper(), image, ...(o.find === undefined ? [] : ["--find", o.find]), ...(o.fast === true ? ["--fast"] : [])]
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`OCR failed: ${err.trim()}`)
  return parseBoxes(out)
}

const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim()

/** Lines matching `needle`: whole-line matches first, then reading order. */
export function rank(boxes: readonly TextBox[], needle: string): TextBox[] {
  const n = fold(needle)
  return boxes
    .filter((b) => fold(b.text).includes(n))
    .map((b) => ({ b, exact: fold(b.text) === n ? 0 : 1 }))
    .sort((a, c) => a.exact - c.exact || a.b.box[1] - c.b.box[1] || a.b.box[0] - c.b.box[0])
    .map((x) => x.b)
}

/** The centre of a match (its own box when Vision gave one, else its line's). */
export function centre(b: TextBox): { readonly x: number; readonly y: number } {
  const [x, y, w, h] = b.match ?? b.box
  return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) }
}

export interface ScreenText {
  readonly boxes: readonly TextBox[]
  readonly width: number
  readonly height: number
  readonly shotMs: number
  readonly ocrMs: number
}

/** Screendump the guest and read it. */
export async function readScreen(p: Paths, o: { readonly find?: string; readonly fast?: boolean } = {}): Promise<ScreenText> {
  const file = resolve(tmpdir(), `winvm-ocr-${String(process.pid)}-${String(Date.now())}.png`)
  try {
    const t0 = performance.now()
    const size = await input.screenshot(p, file)
    const t1 = performance.now()
    const all = await recognize(file, o)
    const boxes = o.find === undefined ? all : rank(all, o.find)
    return { boxes, ...size, shotMs: t1 - t0, ocrMs: performance.now() - t1 }
  } finally {
    rmSync(file, { force: true })
  }
}

/** Re-read the screen until `text` shows (or `waitMs` passes); the best match, or null. */
export async function findOnScreen(p: Paths, text: string, o: { readonly waitMs?: number; readonly fast?: boolean } = {}): Promise<{ hit: TextBox | null; last: ScreenText }> {
  const deadline = Date.now() + (o.waitMs ?? 0)
  for (;;) {
    const last = await readScreen(p, { find: text, ...(o.fast === undefined ? {} : { fast: o.fast }) })
    const hit = last.boxes[0] ?? null
    if (hit !== null || Date.now() >= deadline) return { hit, last }
    await Bun.sleep(250)
  }
}

const fmt = (b: TextBox): string => {
  const [x, y, w, h] = b.match ?? b.box
  return `${String(x)},${String(y)} ${String(w)}x${String(h)}  ${(b.confidence * 100).toFixed(0)}%  ${b.text}`
}

// --- verbs ------------------------------------------------------------------------------

export async function ocr(args: Args): Promise<number> {
  const find = args.flags.get("find")
  const fast = args.flags.has("fast")
  const json = args.flags.has("json")
  const waitMs = Number(args.flags.get("wait") ?? 0) * 1000
  try {
    let boxes: readonly TextBox[]
    const image = args.flags.get("image") ?? args.positional[0]
    if (image !== undefined) {
      const all = await recognize(resolve(image), { ...(find === undefined ? {} : { find }), fast })
      boxes = find === undefined ? all : rank(all, find)
    } else {
      const name = instanceName(args)
      const p = pathsFor(name)
      if (!qemu.isRunning(p)) {
        console.error(`::error::instance "${name}" is not running`)
        return 1
      }
      boxes = find === undefined ? (await readScreen(p, { fast })).boxes : (await findOnScreen(p, find, { waitMs, fast })).last.boxes
    }
    if (json) console.log(JSON.stringify(boxes.map((b) => ({ ...b, centre: centre(b) })), null, 2))
    else for (const b of boxes) console.log(fmt(b))
    if (find !== undefined && boxes.length === 0) {
      console.error(`::error::"${find}" is not on the screen`)
      return 1
    }
    return 0
  } catch (error) {
    console.error(`::error::${errMsg(error)}`)
    return 1
  }
}

/** `winvm click --text T`: find T on the screen and click the middle of it. */
export async function clickText(args: Args, text: string): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running`)
    return 1
  }
  try {
    const { hit } = await findOnScreen(p, text, { waitMs: Number(args.flags.get("wait") ?? 0) * 1000 })
    if (hit === null) {
      console.error(`::error::"${text}" is not on the screen`)
      return 1
    }
    const at = centre(hit)
    const button: input.Button = args.flags.has("right") ? "right" : args.flags.has("middle") ? "middle" : "left"
    await input.pointer(p, at.x, at.y, button, args.flags.has("double") ? 2 : 1)
    console.log(`clicked "${hit.text}" at (${String(at.x)}, ${String(at.y)})`)
    return 0
  } catch (error) {
    console.error(`::error::${errMsg(error)}`)
    return 1
  }
}
