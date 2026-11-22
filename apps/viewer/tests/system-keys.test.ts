import { describe, expect, it } from "bun:test"

import {
  describeCode,
  nextSeq,
  SystemKeyGate,
} from "../ui/src/features/screen/systemKeys"
import { capturedLabel } from "../ui/src/features/toolbar/Toolbar"

function gate() {
  const arms: boolean[] = []
  return {
    gate: new SystemKeyGate((armed) => arms.push(armed)),
    arms,
  }
}

describe("system-shortcut gate", () => {
  it("arms only while captured and the display has focus", () => {
    const { gate: g, arms } = gate()
    g.setCaptured(true)
    expect(arms).toEqual([])
    g.setFocused(true)
    expect(arms).toEqual([true])
    g.setFocused(false)
    g.setFocused(true)
    g.setCaptured(false)
    expect(arms).toEqual([true, false, true, false])
  })

  it("asks the Mac once per change", () => {
    const { gate: g, arms } = gate()
    g.setFocused(true)
    g.setCaptured(true)
    g.setCaptured(true)
    g.setFocused(true)
    g.setFocused(false)
    g.setCaptured(false)
    expect(arms).toEqual([true, false])
  })
})

describe("request order", () => {
  it("keeps rising when the clock stalls or steps back", () => {
    const first = nextSeq(Number.MAX_SAFE_INTEGER / 4)
    const second = nextSeq(Number.MAX_SAFE_INTEGER / 4)
    const third = nextSeq(0)
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
  })
})

describe("guest keys for tapped codes", () => {
  it("names letters, digits and punctuation as a US keyboard does", () => {
    expect(describeCode("KeyQ")).toEqual({ key: "q", numpad: false })
    expect(describeCode("Digit3")).toEqual({ key: "3", numpad: false })
    expect(describeCode("Backquote")).toEqual({ key: "`", numpad: false })
    expect(describeCode("Space")).toEqual({ key: " ", numpad: false })
  })

  it("keeps named keys and marks the numeric keypad", () => {
    expect(describeCode("Tab")).toEqual({ key: "Tab", numpad: false })
    expect(describeCode("ArrowUp")).toEqual({ key: "ArrowUp", numpad: false })
    expect(describeCode("F11")).toEqual({ key: "F11", numpad: false })
    expect(describeCode("Numpad7")).toEqual({ key: "7", numpad: true })
    expect(describeCode("NumpadEnter")).toEqual({ key: "Enter", numpad: true })
  })
})

describe("captured status", () => {
  it("says when macOS keeps its shortcuts", () => {
    expect(capturedLabel("allowed")).toBe("input.captured")
    expect(capturedLabel(null)).toBe("input.captured")
    expect(capturedLabel("needsPermission")).toBe("input.capturedPartial")
    expect(capturedLabel("unavailable")).toBe("input.capturedPartial")
  })
})
