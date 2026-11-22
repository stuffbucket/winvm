import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  describeCode,
  nextSeq,
  type Repeater,
  SYSTEM_KEYS_RENEW_MS,
  SystemKeyGate,
} from "../ui/src/features/screen/systemKeys"
import { capturedLabel } from "../ui/src/features/toolbar/Toolbar"

function gate() {
  const arms: boolean[] = []
  const running = new Map<number, { fn: () => void; ms: number }>()
  let next = 0
  const repeater: Repeater = {
    repeat: (fn, ms) => {
      next += 1
      running.set(next, { fn, ms })
      return next
    },
    stop: (handle) => {
      running.delete(handle as number)
    },
  }
  const renew = (): void => {
    for (const { fn } of running.values()) fn()
  }
  return {
    gate: new SystemKeyGate((armed) => arms.push(armed), repeater),
    arms,
    running,
    renew,
  }
}

describe("system-shortcut gate", () => {
  it("disarms whatever an earlier page left armed as soon as it exists", () => {
    const { arms } = gate()
    expect(arms).toEqual([false])
  })

  it("arms only while captured and the display has focus", () => {
    const { gate: g, arms } = gate()
    g.setCaptured(true)
    expect(arms).toEqual([false])
    g.setFocused(true)
    expect(arms).toEqual([false, true])
    g.setFocused(false)
    g.setFocused(true)
    g.setCaptured(false)
    expect(arms).toEqual([false, true, false, true, false])
  })

  it("renews the lease while armed and stops renewing once disarmed", () => {
    const { gate: g, arms, running, renew } = gate()
    g.setFocused(true)
    g.setCaptured(true)
    expect([...running.values()].map((r) => r.ms)).toEqual([
      SYSTEM_KEYS_RENEW_MS,
    ])
    renew()
    renew()
    expect(arms).toEqual([false, true, true, true])
    g.setFocused(false)
    expect(running.size).toBe(0)
    renew()
    expect(arms).toEqual([false, true, true, true, false])
  })

  it("renews often enough that one late renewal does not drop the lease", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../src-tauri/src/keytap.rs"),
      "utf8",
    )
    const lease = Number(
      /pub const LEASE: Duration = Duration::from_millis\((\d+)\)/.exec(
        source,
      )?.[1],
    )
    expect(lease).toBeGreaterThan(SYSTEM_KEYS_RENEW_MS * 2)
  })

  it("asks the Mac once per change", () => {
    const { gate: g, arms, running } = gate()
    g.setFocused(true)
    g.setCaptured(true)
    g.setCaptured(true)
    g.setFocused(true)
    expect(running.size).toBe(1)
    g.setFocused(false)
    g.setCaptured(false)
    expect(arms).toEqual([false, true, false])
  })
})

describe("request order", () => {
  it("keeps rising, with no clock involved", () => {
    const first = nextSeq()
    const second = nextSeq()
    expect(second).toBe(first + 1)
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
