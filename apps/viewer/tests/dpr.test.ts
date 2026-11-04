/**
 * Anything computed from the device pixel ratio must follow the window to a display of another
 * ratio (which changes no size and fires no resize): the watcher, the hook's source, the checkpoint
 * card's sharp-picture rule, and where a drag from the Mac is.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeEach, describe, expect, it } from "bun:test"

GlobalRegistrator.register()

const { pixelRatio, watchPixelRatio } = await import("../ui/src/dpr")
const { dragPointToCss } = await import("../ui/src/backend")
const { sharpAt } = await import("../ui/src/features/checkpoints/CheckpointCard")

afterAll(() => GlobalRegistrator.unregister())

/** A stand-in for matchMedia whose queries can be made to stop matching, as the real one does when the ratio changes. */
interface FakeQuery {
  readonly media: string
  readonly listeners: Set<() => void>
}
let queries: FakeQuery[] = []

function setRatio(ratio: number | undefined): void {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: ratio })
}

/** The window moves to a display with this ratio: the ratio changes, then every armed query reports it. */
function moveTo(ratio: number): void {
  setRatio(ratio)
  for (const q of [...queries]) for (const l of [...q.listeners]) l()
}

beforeEach(() => {
  queries = []
  setRatio(2)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => {
      const q: FakeQuery = { media, listeners: new Set() }
      queries.push(q)
      return {
        media,
        matches: true,
        addEventListener: (_: string, l: () => void) => q.listeners.add(l),
        removeEventListener: (_: string, l: () => void) => {
          q.listeners.delete(l)
        },
      }
    },
  })
})

const armed = (): string[] => queries.filter((q) => q.listeners.size > 0).map((q) => q.media)

describe("pixelRatio", () => {
  it("is the window's ratio now, and 1 when there is none", () => {
    expect(pixelRatio()).toBe(2)
    setRatio(1.5)
    expect(pixelRatio()).toBe(1.5)
    setRatio(undefined)
    expect(pixelRatio()).toBe(1)
    setRatio(0)
    expect(pixelRatio()).toBe(1)
  })
})

describe("watchPixelRatio", () => {
  it("reports the new ratio when the window moves to another display, again for the next move, and in between asks the query for the ratio it is on", () => {
    const seen: number[] = []
    const stop = watchPixelRatio((r) => seen.push(r))
    expect(armed()).toEqual(["(resolution: 2dppx)"])
    moveTo(1)
    expect(seen).toEqual([1])
    expect(armed()).toEqual(["(resolution: 1dppx)"])
    moveTo(1.5)
    expect(seen).toEqual([1, 1.5])
    expect(armed()).toEqual(["(resolution: 1.5dppx)"])
    stop()
  })

  it("serves every watcher with one query, and lets the query go with the last", () => {
    const a: number[] = []
    const b: number[] = []
    const stopA = watchPixelRatio((r) => a.push(r))
    const stopB = watchPixelRatio((r) => b.push(r))
    expect(armed()).toHaveLength(1)
    moveTo(1)
    expect(a).toEqual([1])
    expect(b).toEqual([1])
    stopA()
    moveTo(2)
    expect(a).toEqual([1])
    expect(b).toEqual([1, 2])
    stopB()
    expect(armed()).toEqual([])
  })

  it("does nothing where there is no matchMedia", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined })
    const stop = watchPixelRatio(() => undefined)
    expect(() => stop()).not.toThrow()
  })
})

describe("a checkpoint card's picture", () => {
  it("is the full screenshot once the card is wider than the thumbnail in device pixels, whatever the display", () => {
    expect(sharpAt(400, 1)).toBe(false)
    expect(sharpAt(400, 2)).toBe(true)
    expect(sharpAt(400, 1.5)).toBe(true)
    expect(sharpAt(300, 1.5)).toBe(false)
    expect(sharpAt(561, 1)).toBe(true)
  })
})

describe("where a drag from the Mac is", () => {
  it("is already in CSS pixels on macOS, on any display (wry reports AppKit's points as 'physical')", () => {
    expect(dragPointToCss({ x: 120, y: 340 }, 2, "macos")).toEqual({ x: 120, y: 340 })
    expect(dragPointToCss({ x: 120, y: 340 }, 1, "macos")).toEqual({ x: 120, y: 340 })
    expect(dragPointToCss({ x: 120, y: 340 }, 1.5, "macos")).toEqual({ x: 120, y: 340 })
  })

  it("is device pixels elsewhere, divided by the ratio", () => {
    expect(dragPointToCss({ x: 300, y: 150 }, 1.5, "windows")).toEqual({ x: 200, y: 100 })
    expect(dragPointToCss({ x: 300, y: 150 }, 0, "linux")).toEqual({ x: 300, y: 150 })
  })
})
