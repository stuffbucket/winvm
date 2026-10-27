/**
 * The boot-prompt gate's frame classifier, on synthetic frames shaped like the
 * ones the build VM actually shows: cdboot's prompt (one line at the top of a
 * black screen), the UEFI shell (text further down), Windows Setup (all lit).
 */
import { describe, expect, it } from "bun:test"

import { classifyBootFrame } from "../src/qmp"

const W = 800
const H = 600

/** An 800x600 P6 frame with rows [top, bottom) lit in their first `cols` columns. */
function frame(rows: [number, number][], cols = 400, rgb: [number, number, number] = [170, 170, 170]): Buffer {
  const header = Buffer.from(`P6\n${String(W)} ${String(H)}\n255\n`, "latin1")
  const data = Buffer.alloc(W * H * 3)
  for (const [top, bottom] of rows) {
    for (let y = top; y < bottom; y += 1) for (let x = 0; x < cols; x += 1) data.set(rgb, (y * W + x) * 3)
  }
  return Buffer.concat([header, data])
}

describe("classifyBootFrame", () => {
  it("knows cdboot's prompt: one line at the top, nothing else", () => {
    const f = classifyBootFrame(frame([[5, 7]], 300))
    expect(f.kind).toBe("prompt")
    expect(f.lit).toBe(600)
  })

  it("counts the prompt's dots, which is how a waiting prompt is told from an answered one", () => {
    const before = classifyBootFrame(frame([[5, 7]], 300)).lit
    const after = classifyBootFrame(frame([[5, 7]], 302)).lit
    expect(after).toBeGreaterThan(before)
  })

  it("tells the shell's console from the prompt", () => {
    expect(classifyBootFrame(frame([[0, 20], [200, 220], [460, 480]])).kind).toBe("console")
  })

  it("calls Windows Setup and its full-screen blue graphical", () => {
    expect(classifyBootFrame(frame([[0, H]], W, [255, 255, 255])).kind).toBe("graphical")
    expect(classifyBootFrame(frame([[0, H]], W, [0, 90, 158])).kind).toBe("graphical")
  })

  it("calls an empty or unreadable frame blank", () => {
    expect(classifyBootFrame(frame([])).kind).toBe("blank")
    expect(classifyBootFrame(Buffer.from("P5\n800 600\n255\n")).kind).toBe("blank")
    expect(classifyBootFrame(frame([[5, 7]]).subarray(0, 1000)).kind).toBe("blank")
  })
})
