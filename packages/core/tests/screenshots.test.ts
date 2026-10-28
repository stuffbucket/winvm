/**
 * A save's screenshots: the raw screendump taken while the guest is stopped,
 * and the PNGs written from it after — against a fake QEMU monitor.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { pngSize } from "../src/input"
import { FILES, captureScreen, writeScreenshots } from "../src/saves"
import { FakeQmp } from "./fakes/qmp"

/** A P6 frame with a gradient, so a broken resample would show up as wrong bytes, not just a wrong size. */
function ppm(w: number, h: number): Buffer {
  const data = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i += 1) data.set([i % 256, (i >> 8) % 256, 128], i * 3)
  return Buffer.concat([Buffer.from(`P6\n${String(w)} ${String(h)}\n255\n`, "latin1"), data])
}

describe("save screenshots", () => {
  let dir = ""
  let fake: FakeQmp
  let size = { width: 1024, height: 768 }

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "winvm-shot-"))
    fake = new FakeQmp(resolve(dir, "qmp.sock"))
    fake.handler = (cmd) => {
      if (cmd["execute"] !== "screendump") return { return: {} }
      const args = cmd["arguments"] as Record<string, unknown>
      // QEMU writes the raw PPM when no format is asked for; that is the cheap dump.
      if (args["format"] !== undefined) return { error: { class: "GenericError", desc: "expected a raw dump" } }
      writeFileSync(String(args["filename"]), ppm(size.width, size.height))
      return { return: {} }
    }
    await fake.listen()
  })

  afterEach(async () => {
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("captures a raw dump as a dot-file, then writes screen.png and a fitted thumb.png", async () => {
    const shot = await captureScreen(fake.path, dir)
    expect(shot).toBe(resolve(dir, ".screen.ppm"))
    expect(writeScreenshots(shot ?? "", dir)).toEqual({ width: 1024, height: 768 })
    expect(pngSize(readFileSync(resolve(dir, FILES.screen)))).toEqual({ width: 1024, height: 768 })
    expect(pngSize(readFileSync(resolve(dir, FILES.thumb)))).toEqual({ width: 400, height: 300 })
    // The raw dump is gone; only the PNGs (and the socket) are left.
    expect(existsSync(shot ?? "")).toBe(false)
    expect(readdirSync(dir).sort()).toEqual([FILES.screen, "qmp.sock", FILES.thumb].sort())
  })

  it("keeps a small screen's thumbnail at its own size", async () => {
    size = { width: 320, height: 240 }
    const shot = await captureScreen(fake.path, dir)
    expect(writeScreenshots(shot ?? "", dir)).toEqual({ width: 320, height: 240 })
    expect(pngSize(readFileSync(resolve(dir, FILES.thumb)))).toEqual({ width: 320, height: 240 })
    size = { width: 1024, height: 768 }
  })

  it("gives no screenshot, and no files, when QEMU cannot dump the screen", async () => {
    fake.handler = () => ({ error: { class: "GenericError", desc: "no surface" } })
    expect(await captureScreen(fake.path, dir)).toBeNull()
    expect(readdirSync(dir)).toEqual(["qmp.sock"])
  })

  it("gives up quickly on a monitor that never answers", async () => {
    fake.handler = () => null
    const started = Date.now()
    expect(await captureScreen(fake.path, dir, 200)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("writes nothing from a dump it cannot read, and still deletes it", () => {
    const bad = resolve(dir, ".screen.ppm")
    writeFileSync(bad, "P5\n1 1\n255\n\0")
    expect(writeScreenshots(bad, dir)).toBeNull()
    expect(existsSync(bad)).toBe(false)
    expect(existsSync(resolve(dir, FILES.screen))).toBe(false)
    expect(existsSync(resolve(dir, FILES.thumb))).toBe(false)
  })
})
