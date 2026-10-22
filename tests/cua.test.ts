/**
 * The pure parts of the computer-use executor (cua.ts): coordinate scaling,
 * xdotool key names -> qcodes, PPM decoding, resampling, PNG encoding, and the
 * request normalization. No VM needed.
 */
import { inflateSync } from "node:zlib"

import { describe, expect, it } from "bun:test"

import {
  ACTIONS,
  DEFAULT_BOX,
  crop,
  encodePng,
  fitScale,
  isAction,
  keysymToQcodes,
  modifiers,
  normalize,
  parseKeys,
  parsePpm,
  point,
  resize,
  scaled,
  toModel,
  toNative,
} from "../cua"
import type { Rgb } from "../cua"
import { pngSize } from "../input"

describe("scaling", () => {
  it("leaves a screen that fits alone", () => {
    expect(fitScale({ width: 800, height: 600 }, DEFAULT_BOX)).toBe(1)
    expect(fitScale({ width: 1280, height: 800 }, DEFAULT_BOX)).toBe(1)
    expect(scaled({ width: 800, height: 600 }, 1)).toEqual({ width: 800, height: 600 })
  })

  it("shrinks 1920x1080 into 1280x800 by width, aspect kept", () => {
    const s = fitScale({ width: 1920, height: 1080 }, DEFAULT_BOX)
    expect(s).toBeCloseTo(2 / 3, 10)
    expect(scaled({ width: 1920, height: 1080 }, s)).toEqual({ width: 1280, height: 720 })
  })

  it("shrinks a tall screen by height", () => {
    const s = fitScale({ width: 1600, height: 1200 }, DEFAULT_BOX)
    expect(scaled({ width: 1600, height: 1200 }, s)).toEqual({ width: 1067, height: 800 })
  })

  it("maps model coordinates back to framebuffer pixels and clamps", () => {
    const native = { width: 1920, height: 1080 }
    const s = 2 / 3
    expect(toNative(640, 360, s, native)).toEqual({ x: 960, y: 540 })
    expect(toNative(0, 0, s, native)).toEqual({ x: 0, y: 0 })
    expect(toNative(1279, 719, s, native)).toEqual({ x: 1919, y: 1079 })
    expect(toNative(5000, -3, s, native)).toEqual({ x: 1919, y: 0 })
    expect(toModel(960, 540, s)).toEqual({ x: 640, y: 360 })
  })

  it("round-trips every model pixel to within one framebuffer pixel", () => {
    const native = { width: 1920, height: 1080 }
    const s = fitScale(native, DEFAULT_BOX)
    for (const x of [0, 1, 2, 100, 641, 1279]) {
      const n = toNative(x, 0, s, native)
      expect(Math.abs(toModel(n.x, 0, s).x - x)).toBeLessThanOrEqual(1)
    }
  })
})

describe("keys", () => {
  it("maps xdotool names, case-insensitively", () => {
    expect(parseKeys("Return")).toEqual({ qcodes: ["ret"], unknown: null })
    expect(parseKeys("ctrl+s")).toEqual({ qcodes: ["ctrl", "s"], unknown: null })
    expect(parseKeys("alt+Tab")).toEqual({ qcodes: ["alt", "tab"], unknown: null })
    expect(parseKeys("super")).toEqual({ qcodes: ["meta_l"], unknown: null })
    expect(parseKeys("super+r")).toEqual({ qcodes: ["meta_l", "r"], unknown: null })
    expect(parseKeys("ctrl+shift+Escape")).toEqual({ qcodes: ["ctrl", "shift", "esc"], unknown: null })
    expect(parseKeys("Page_Down").qcodes).toEqual(["pgdn"])
    expect(parseKeys("Prior").qcodes).toEqual(["pgup"])
    expect(parseKeys("Next").qcodes).toEqual(["pgdn"])
    expect(parseKeys("BackSpace").qcodes).toEqual(["backspace"])
    expect(parseKeys("KP_Enter").qcodes).toEqual(["kp_enter"])
    expect(parseKeys("KP_7").qcodes).toEqual(["kp_7"])
    expect(parseKeys("F5").qcodes).toEqual(["f5"])
    expect(parseKeys("F12").qcodes).toEqual(["f12"])
    expect(parseKeys("ctrl+alt+Delete").qcodes).toEqual(["ctrl", "alt", "delete"])
    expect(parseKeys("XF86AudioMute").qcodes).toEqual(["audiomute"])
  })

  it("takes a letter's key whatever its case, as xdotool does", () => {
    expect(parseKeys("ctrl+S").qcodes).toEqual(["ctrl", "s"])
    expect(parseKeys("a").qcodes).toEqual(["a"])
  })

  it("brings shift for shifted punctuation", () => {
    expect(keysymToQcodes("plus")).toEqual(["shift", "equal"])
    expect(keysymToQcodes("exclam")).toEqual(["shift", "1"])
    expect(keysymToQcodes("question")).toEqual(["shift", "slash"])
    expect(keysymToQcodes("ISO_Left_Tab")).toEqual(["shift", "tab"])
    expect(parseKeys("ctrl+plus").qcodes).toEqual(["ctrl", "shift", "equal"])
    expect(parseKeys("ctrl+shift+plus").qcodes).toEqual(["ctrl", "shift", "equal"])
    expect(parseKeys("period").qcodes).toEqual(["dot"])
    expect(parseKeys("/").qcodes).toEqual(["slash"])
  })

  it("keeps a literal + as a key", () => {
    expect(parseKeys("+").qcodes).toEqual(["shift", "equal"])
    expect(parseKeys("ctrl++").qcodes).toEqual(["ctrl", "shift", "equal"])
  })

  it("names what it can't map", () => {
    expect(parseKeys("ctrl+Hyperdrive")).toEqual({ qcodes: [], unknown: "Hyperdrive" })
    expect(parseKeys("é").unknown).toBe("é")
    expect(parseKeys("").unknown).toBe("")
  })

  it("reads click/scroll modifiers from text", () => {
    expect(modifiers({})).toEqual([])
    expect(modifiers({ text: "shift" })).toEqual(["shift"])
    expect(modifiers({ text: "ctrl+shift" })).toEqual(["ctrl", "shift"])
    expect(modifiers({ text: "super" })).toEqual(["meta_l"])
    expect(() => modifiers({ text: "shift+nope" })).toThrow('unknown modifier key "nope"')
  })
})

describe("requests", () => {
  it("normalizes both shapes", () => {
    expect(normalize({ action: "left_click", coordinate: [1, 2] })).toEqual({ action: "left_click", params: { coordinate: [1, 2] } })
    expect(normalize("left_click", { coordinate: [1, 2] })).toEqual({ action: "left_click", params: { coordinate: [1, 2] } })
    expect(normalize({ coordinate: [1, 2] }).action).toBe("")
  })

  it("knows the toolset's 17 members", () => {
    expect(ACTIONS.length).toBe(17)
    expect(isAction("zoom")).toBe(true)
    expect(isAction("teleport")).toBe(false)
  })

  it("validates points", () => {
    expect(point({ coordinate: [3, 4] }, "coordinate")).toEqual({ x: 3, y: 4 })
    expect(() => point({ coordinate: [3] }, "coordinate")).toThrow("coordinate must be [x, y]")
    expect(() => point({ coordinate: ["3", 4] }, "coordinate")).toThrow()
    expect(() => point({}, "start_coordinate")).toThrow("start_coordinate must be [x, y]")
  })
})

const solid = (width: number, height: number, rgb: readonly [number, number, number]): Rgb => {
  const data = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) data.set(rgb, i * 3)
  return { width, height, data }
}

describe("images", () => {
  it("decodes QEMU's PPM", () => {
    const body = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9])
    const img = parsePpm(Buffer.concat([Buffer.from("P6\n2 2\n255\n"), body]))
    expect(img.width).toBe(2)
    expect(img.height).toBe(2)
    expect([...img.data]).toEqual([...body])
    expect(() => parsePpm(Buffer.from("P6\n2 2\n255\n\x00"))).toThrow("truncated")
    expect(() => parsePpm(Buffer.from("P3\n2 2\n255\n"))).toThrow()
  })

  it("area-averages when shrinking", () => {
    // 2x1: black | white -> 1x1 mid grey
    const img: Rgb = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255]) }
    expect([...resize(img, 1, 1).data]).toEqual([128, 128, 128])
    const big = resize(solid(1920, 1080, [10, 20, 30]), 1280, 720)
    expect(big.width).toBe(1280)
    expect(big.data.length).toBe(1280 * 720 * 3)
    expect([...big.data.subarray(0, 3)]).toEqual([10, 20, 30])
    expect([...big.data.subarray(big.data.length - 3)]).toEqual([10, 20, 30])
  })

  it("grows smoothly (zoom)", () => {
    const img: Rgb = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 200, 200, 200]) }
    const out = resize(img, 4, 1)
    expect(out.data[0]).toBe(0)
    expect(out.data[9]).toBe(200)
    expect(out.data[3]).toBeGreaterThan(0)
    expect(out.data[3]).toBeLessThan(200)
  })

  it("crops, clamped to the image", () => {
    const img: Rgb = { width: 3, height: 2, data: new Uint8Array([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6]) }
    const c = crop(img, 1, 1, 3, 2)
    expect(c.width).toBe(2)
    expect(c.height).toBe(1)
    expect([...c.data]).toEqual([5, 5, 5, 6, 6, 6])
    const d = crop(img, -5, -5, 99, 99)
    expect([d.width, d.height]).toEqual([3, 2])
    const e = crop(img, 2, 1, 2, 1)
    expect([e.width, e.height]).toEqual([1, 1])
  })

  it("encodes a valid PNG that decodes back to its pixels", () => {
    const img: Rgb = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 250, 0, 7, 9, 9, 9, 0, 0, 0, 255, 255, 255, 40, 50, 60]) }
    const png = encodePng(img)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(pngSize(png)).toEqual({ width: 3, height: 2 })
    // IDAT: filter 1 (Sub) per row; undo it.
    const idatAt = png.indexOf("IDAT")
    const len = png.readUInt32BE(idatAt - 4)
    const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + len))
    const out: number[] = []
    for (let y = 0; y < 2; y += 1) {
      const row = raw.subarray(y * 10, y * 10 + 10)
      expect(row[0]).toBe(1)
      const px: number[] = []
      for (let i = 0; i < 9; i += 1) px.push(((row[i + 1] ?? 0) + (i >= 3 ? (px[i - 3] ?? 0) : 0)) & 0xff)
      out.push(...px)
    }
    expect(out).toEqual([...img.data])
  })
})
