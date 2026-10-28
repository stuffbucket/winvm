/**
 * The resizable display: size math and limits, the debounce, the device's
 * QEMU arguments and what they do to the save hash, and the wire formats of
 * the VNC resize request and the agent's /display route. No VM needed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { setDesktopSizeMessage, vncAuthResponse } from "../src/desktopsize"
import { RAMFB, VIRTIO_GPU, describeDisplay, displayArgs, parseDevice, readDisplay, sameDevice, writeDisplay } from "../src/display"
import {
  MAX_FRAMEBUFFER_BYTES,
  MAX_HEIGHT,
  MAX_WIDTH,
  SizeDebouncer,
  clampSize,
  drawSize,
  guestSizeFor,
  parseSize,
  scaleFor,
  type Size,
} from "../src/displayfit"
import { deviceFromCommandLine } from "../src/guestdisplay"
import { displayArgv } from "../src/guestagent"
import type { Paths } from "../src/paths"
import { compatHash, hardwareArgs } from "../src/saves"

const bytes = (s: Size): number => s.width * s.height * 4

describe("clampSize", () => {
  it("keeps a size that fits, with the width rounded down to a multiple of 16", () => {
    expect(clampSize({ width: 2560, height: 1600 })).toEqual({ width: 2560, height: 1600 })
    expect(clampSize({ width: 1501, height: 950 })).toEqual({ width: 1488, height: 950 })
  })

  it("shrinks a size over the framebuffer limit, keeping its shape", () => {
    // The measured edge: exactly 30 MiB shows, two rows more goes dark.
    expect(clampSize({ width: 3840, height: 2048 })).toEqual({ width: 3840, height: 2048 })
    expect(bytes(clampSize({ width: 3840, height: 2050 }))).toBeLessThanOrEqual(MAX_FRAMEBUFFER_BYTES)
    const s = clampSize({ width: 3840, height: 2160 }) // 33.2 MB: over 30 MiB
    expect(bytes(s)).toBeLessThanOrEqual(MAX_FRAMEBUFFER_BYTES)
    expect(s.width % 16).toBe(0)
    expect(Math.abs(s.width / s.height - 3840 / 2160)).toBeLessThan(0.01)
    // A 16" MacBook Pro full screen at 2x (30.9 MB): over 30 MiB and taller than VNC allows.
    const mbp = clampSize({ width: 3456, height: 2234 })
    expect(mbp.height).toBeLessThanOrEqual(MAX_HEIGHT)
    expect(Math.abs(mbp.width / mbp.height - 3456 / 2234)).toBeLessThan(0.01)
  })

  it("never exceeds VNC's 5120x2160", () => {
    const wide = clampSize({ width: 6000, height: 1000 })
    expect(wide.width).toBeLessThanOrEqual(MAX_WIDTH)
    expect(clampSize({ width: 1200, height: 4000 }).height).toBeLessThanOrEqual(MAX_HEIGHT)
  })

  it("raises a small size to 1024x768", () => {
    expect(clampSize({ width: 300, height: 200 })).toEqual({ width: 1024, height: 768 })
    expect(clampSize({ width: 1600, height: 500 })).toEqual({ width: 1600, height: 768 })
  })

  it("everything it returns fits", () => {
    for (const w of [1, 800, 1024, 1999, 2560, 3456, 4000, 5120, 9000]) {
      for (const h of [1, 600, 768, 1117, 1600, 2160, 2234, 3000, 5000]) {
        const s = clampSize({ width: w, height: h })
        expect(bytes(s)).toBeLessThanOrEqual(MAX_FRAMEBUFFER_BYTES)
        expect(s.width).toBeLessThanOrEqual(MAX_WIDTH)
        expect(s.height).toBeLessThanOrEqual(MAX_HEIGHT)
        expect(s.width % 16).toBe(0)
      }
    }
  })
})

describe("guestSizeFor", () => {
  it("is the view in device pixels", () => {
    expect(guestSizeFor({ width: 1280, height: 800 }, 2)).toEqual({ width: 2560, height: 1600 })
    expect(guestSizeFor({ width: 1280.6, height: 800.4 }, 2)).toEqual({ width: 2560, height: 1600 })
    expect(guestSizeFor({ width: 1440, height: 900 }, 1)).toEqual({ width: 1440, height: 900 })
    expect(guestSizeFor({ width: 1001, height: 700.5 }, 1.5)).toEqual({ width: 1488, height: 1050 })
  })

  it("treats a missing ratio as 1", () => {
    expect(guestSizeFor({ width: 1280, height: 800 }, Number.NaN)).toEqual({ width: 1280, height: 800 })
    expect(guestSizeFor({ width: 1280, height: 800 }, 0)).toEqual({ width: 1280, height: 800 })
  })
})

describe("scaleFor and parseSize", () => {
  it("maps a pixel ratio to the nearest Windows scale", () => {
    expect(scaleFor(1)).toBe(100)
    expect(scaleFor(2)).toBe(200)
    expect(scaleFor(1.5)).toBe(150)
    expect(scaleFor(2.2)).toBe(225)
    expect(scaleFor(3)).toBe(300)
  })

  it("parses WxH", () => {
    expect(parseSize("2560x1600")).toEqual({ width: 2560, height: 1600 })
    expect(parseSize(" 1024X768 ")).toEqual({ width: 1024, height: 768 })
    expect(parseSize("virtio-gpu")).toBeNull()
  })
})

describe("SizeDebouncer", () => {
  function harness() {
    const sent: Size[] = []
    let pending: (() => void) | null = null
    const d = new SizeDebouncer((s) => sent.push(s), 300, {
      set: (fn) => {
        pending = fn
        return 1
      },
      clear: () => {
        pending = null
      },
    })
    const fire = (): void => {
      const f = pending
      pending = null
      f?.()
    }
    return { d, sent, fire }
  }

  it("sends only the last size of a burst, after the delay", () => {
    const { d, sent, fire } = harness()
    d.push({ width: 1000, height: 800 })
    d.push({ width: 1100, height: 800 })
    d.push({ width: 1200, height: 800 })
    expect(sent).toEqual([])
    fire()
    expect(sent).toEqual([{ width: 1200, height: 800 }])
  })

  it("flushes at once at the end of a live resize", () => {
    const { d, sent, fire } = harness()
    d.push({ width: 1000, height: 800 })
    d.flush()
    expect(sent).toEqual([{ width: 1000, height: 800 }])
    fire() // the cleared timer does nothing
    expect(sent).toHaveLength(1)
  })

  it("does not send the same size twice in a row, until reset", () => {
    const { d, sent, fire } = harness()
    d.push({ width: 1000, height: 800 })
    fire()
    d.push({ width: 1000, height: 800 })
    fire()
    expect(sent).toHaveLength(1)
    d.reset()
    d.push({ width: 1000, height: 800 })
    fire()
    expect(sent).toHaveLength(2)
  })

  it("cancel drops a pending size", () => {
    const { d, sent, fire } = harness()
    d.push({ width: 1000, height: 800 })
    d.cancel()
    fire()
    d.flush()
    expect(sent).toEqual([])
  })
})

describe("display device", () => {
  it("never puts a size on virtio-gpu's command line", () => {
    expect(displayArgs(VIRTIO_GPU)).toEqual(["-device", "virtio-gpu-pci"])
    expect(displayArgs(RAMFB)).toEqual(["-device", "ramfb"])
    // An instance switched by an earlier winvm keeps its size, so its saves still load.
    expect(displayArgs({ device: "virtio-gpu", legacySize: { width: 1920, height: 1080 } })).toEqual([
      "-device",
      "virtio-gpu-pci,xres=1920,yres=1080",
    ])
    expect(sameDevice(VIRTIO_GPU, { device: "virtio-gpu", legacySize: { width: 1920, height: 1080 } })).toBe(false)
  })

  it("parses device names", () => {
    expect(parseDevice("virtio-gpu")).toEqual(VIRTIO_GPU)
    expect(parseDevice("RAMFB")).toEqual(RAMFB)
    expect(parseDevice("1920x1080")).toBeNull()
    expect(describeDisplay(VIRTIO_GPU)).toStartWith("virtio-gpu")
    expect(describeDisplay(RAMFB)).toStartWith("ramfb")
  })

  it("reads the running device back off a command line", () => {
    expect(deviceFromCommandLine("qemu -device virtio-gpu-pci -display none")).toBe("virtio-gpu")
    expect(deviceFromCommandLine("qemu -device virtio-gpu-pci,xres=1920,yres=1080 -display none")).toBe("virtio-gpu")
    expect(deviceFromCommandLine("qemu -device ramfb -display none")).toBe("ramfb")
    expect(deviceFromCommandLine("qemu -display none")).toBeNull()
  })

  describe("display.json", () => {
    let dir = ""
    beforeAll(() => {
      dir = mkdtempSync(resolve(tmpdir(), "winvm-display-"))
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const paths = (): Paths => ({ dir }) as Paths

    it("is ramfb when absent (instances older than the virtio-gpu default)", () => {
      expect(readDisplay(paths())).toEqual(RAMFB)
    })

    it("round-trips both devices, and reads an earlier winvm's sized file as legacy", () => {
      writeDisplay(paths(), VIRTIO_GPU)
      expect(readDisplay(paths())).toEqual(VIRTIO_GPU)
      writeDisplay(paths(), RAMFB)
      expect(readDisplay(paths())).toEqual(RAMFB)
      writeFileSync(resolve(dir, "display.json"), JSON.stringify({ device: "virtio-gpu", width: 1600, height: 900 }))
      expect(readDisplay(paths())).toEqual({ device: "virtio-gpu", legacySize: { width: 1600, height: 900 } })
    })
  })
})

describe("the save hash and the guest's resolution", () => {
  // qemu.ts takes the display device's arguments from displayArgs(readDisplay(p))
  // and nothing else; saves.ts hashes hardwareArgs() of the whole command line.
  // The guest's own resolution is not an input to either, so only the device is.
  let dir = ""
  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), "winvm-hash-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function hardwareFor(display: Parameters<typeof writeDisplay>[1] | null): readonly string[] {
    const p = { dir } as Paths
    if (display === null) rmSync(resolve(dir, "display.json"), { force: true })
    else writeDisplay(p, display)
    return hardwareArgs(["-machine", "virt,accel=hvf", ...displayArgs(readDisplay(p)), "-display", "none", "-vnc", "127.0.0.1:3"])
  }

  it("has no size in it on virtio-gpu, so resizing the guest cannot change it", () => {
    const hw = hardwareFor(VIRTIO_GPU)
    expect(hw).toContain("virtio-gpu-pci")
    expect(hw.join(" ")).not.toMatch(/xres|yres/)
    expect(compatHash(parts(hw))).toBe(compatHash(parts(hardwareFor(VIRTIO_GPU))))
  })

  it("changes with the device: switching makes the other device's saves unloadable", () => {
    expect(compatHash(parts(hardwareFor(VIRTIO_GPU)))).not.toBe(compatHash(parts(hardwareFor(RAMFB))))
    expect(hardwareFor(null)).toEqual(hardwareFor(RAMFB)) // an instance older than the default is ramfb
  })

  it("qemu.ts builds the display arguments from display.json alone", () => {
    // `o.display` is a device, never a size: saves.currentCompat passes one to
    // ask "what if this instance had the other device?" without writing it.
    const src = readFileSync(resolve(import.meta.dir, "../src/qemu.ts"), "utf8")
    expect(src).toContain("const display = o.installMedia ? RAMFB : (o.display ?? readDisplay(p))")
    expect(src).toContain("...displayArgs(display),")
    expect(src).toContain("readonly display?: DisplayConfig")
  })
})

const parts = (hw: readonly string[]) => ({ base: "b", hardware: JSON.stringify(hw), firmware: "f", qemu: "11.1.2" })

describe("wire formats", () => {
  it("builds RFB SetDesktopSize for one screen", () => {
    const m = setDesktopSizeMessage(2560, 1600, 7, 0)
    expect(m.length).toBe(24)
    expect(m[0]).toBe(251)
    expect(m.readUInt16BE(2)).toBe(2560)
    expect(m.readUInt16BE(4)).toBe(1600)
    expect(m[6]).toBe(1)
    expect(m.readUInt32BE(8)).toBe(7)
    expect(m.readUInt16BE(16)).toBe(2560)
    expect(m.readUInt16BE(18)).toBe(1600)
  })

  it("answers VNC's DES challenge as noVNC does (bit-reversed password key)", () => {
    const challenge = Uint8Array.from({ length: 16 }, (_, i) => i * 17)
    // Computed with noVNC's own core/crypto/des.js (packages/core/web/novnc).
    expect(vncAuthResponse("password", challenge).toString("hex")).toBe("b7b9c87777661a7a2299733209bfdfce")
    expect(vncAuthResponse("passwordTOOLONG", challenge).toString("hex")).toBe("b7b9c87777661a7a2299733209bfdfce")
  })

  it("maps /display requests to winvm-display.exe arguments", () => {
    expect(displayArgv({ op: "get" })).toEqual(["get"])
    expect(displayArgv({ op: "set", width: 2560, height: 1600 })).toEqual(["set", "2560", "1600", "2000", "0"])
    expect(displayArgv({ op: "set", width: 2560, height: 1600, waitMs: 500, scale: 200 })).toEqual(["set", "2560", "1600", "500", "200"])
    expect(displayArgv({ op: "scale", scale: 150 })).toEqual(["scale", "150"])
    expect(displayArgv({ op: "set", width: 2560 })).toBeNull()
    expect(displayArgv({ op: "set", width: -1, height: 2 })).toBeNull()
    expect(displayArgv({ op: "nope" } as unknown as Parameters<typeof displayArgv>[0])).toBeNull()
  })
})

describe("drawSize", () => {
  it("draws one guest pixel per device pixel when the guest can match the view", () => {
    expect(drawSize({ width: 2560, height: 1600 }, { width: 1280, height: 800 }, 2)).toEqual({ width: 1280, height: 800 })
  })

  it("never draws larger than the view while a bigger guest is switching away", () => {
    expect(drawSize({ width: 3200, height: 2000 }, { width: 1280, height: 800 }, 2)).toEqual({ width: 1280, height: 800 })
  })

  it("scales a capped guest up to fill a view past the limits", () => {
    // A full-screen Studio Display window: 2560x1440 points at 2x.
    const view = { width: 2560, height: 1380 }
    const guest = guestSizeFor(view, 2)
    expect(guest.height).toBeLessThanOrEqual(MAX_HEIGHT)
    expect(drawSize(guest, view, 2)).toEqual(view)
  })

  it("stops at 5K device pixels", () => {
    // A 6K display's full-screen window at 2x is 3008x1692 points.
    const view = { width: 3008, height: 1692 }
    expect(drawSize(guestSizeFor(view, 2), view, 2)).toEqual({ width: 2560, height: 1440 })
  })
})
