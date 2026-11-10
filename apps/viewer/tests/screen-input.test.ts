import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"

import { GuestPointerRouter, releaseNoVncPointer, type NoVncPointer, type PointerPoint, type RoutedPointerEvent } from "../ui/src/features/screen/input"

function event(type: string, buttons = 0, button = 0, x = 50, y = 60) {
  return {
    type, buttons, button, clientX: x, clientY: y,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true },
    stopImmediatePropagation() { this.stopped = true },
  } satisfies RoutedPointerEvent & { prevented: boolean; stopped: boolean }
}

function setup() {
  const released: (PointerPoint | null)[] = []
  const router = new GuestPointerRouter((point) => released.push(point))
  const pass = (e: ReturnType<typeof event>): boolean => {
    router.handle(e)
    expect(e.prevented).toBe(e.stopped)
    return !e.stopped
  }
  return { router, released, pass }
}

describe("absolute guest pointer ownership", () => {
  it("passes ordinary hover, edge motion, clicks and scrolling immediately and unchanged", () => {
    const { pass, released } = setup()
    for (const x of [0, 1, 50, 99, 100, 1]) {
      const move = event("mousemove", 0, 0, x, 20)
      expect(pass(move)).toBe(true)
      expect(move.clientX).toBe(x)
    }
    expect(pass(event("wheel"))).toBe(true)
    expect(pass(event("mousedown", 1))).toBe(true)
    expect(pass(event("mouseup", 0))).toBe(true)
    expect(pass(event("mousedown", 2, 2))).toBe(true)
    expect(pass(event("mouseup", 0, 2))).toBe(true)
    expect(released).toEqual([])
  })

  it("does not adopt a host drag on edge reentry, but resumes on its first unpressed move", () => {
    const { pass, released } = setup()
    expect(pass(event("mousemove", 1, 0, 99))).toBe(false)
    expect(pass(event("mousemove", 1, 0, 50))).toBe(false)
    expect(pass(event("wheel", 1))).toBe(false)
    expect(pass(event("mouseup"))).toBe(false)
    expect(pass(event("mousemove"))).toBe(true)
    expect(pass(event("mousedown", 1))).toBe(true)
    expect(released).toEqual([])
  })

  it("keeps a guest-origin drag across the edge and back, without changing its coordinates", () => {
    const { pass, released } = setup()
    expect(pass(event("mousedown", 1))).toBe(true)
    for (const x of [99, 120, -30, 60]) expect(pass(event("mousemove", 1, 0, x))).toBe(true)
    expect(pass(event("mouseup", 0, 0, 140))).toBe(true)
    expect(released).toEqual([])
  })

  it("tracks left, middle, right and extended buttons without conflating DOM bits", () => {
    const { pass } = setup()
    let buttons = 0
    for (const [button, bit] of [[0, 1], [1, 4], [2, 2], [3, 8], [4, 16]] as const) {
      buttons |= bit
      expect(pass(event("mousedown", buttons, button))).toBe(true)
    }
    for (const [button, bit] of [[2, 2], [0, 1], [4, 16], [1, 4], [3, 8]] as const) {
      buttons &= ~bit
      expect(pass(event("mouseup", buttons, button))).toBe(true)
    }
  })

  it("does not inherit another host-held button on a new guest press", () => {
    const { pass } = setup()
    expect(pass(event("mousedown", 3, 2))).toBe(false)
    expect(pass(event("mousemove", 3))).toBe(false)
    expect(pass(event("mouseup", 1, 2))).toBe(false)
    expect(pass(event("mouseup", 0))).toBe(false)
    expect(pass(event("mousedown", 1))).toBe(true)
  })

  it("releases a missed button up before allowing ordinary hover again", () => {
    const { pass, released } = setup()
    expect(pass(event("mousedown", 1, 0, 80, 90))).toBe(true)
    expect(pass(event("mousemove"))).toBe(true)
    expect(released).toEqual([{ x: 80, y: 90 }])
    expect(pass(event("mousedown", 1))).toBe(true)
  })

  it("releases all buttons when part of a chord is lost, without adopting what remains", () => {
    const { pass, released } = setup()
    expect(pass(event("mousedown", 1))).toBe(true)
    expect(pass(event("mousedown", 3, 2))).toBe(true)
    expect(pass(event("mousemove", 2))).toBe(false)
    expect(pass(event("mousemove", 2))).toBe(false)
    expect(released).toHaveLength(1)
    expect(pass(event("mousemove", 0))).toBe(true)
  })

  for (const mode of ["resize", "blur", "held/modal"] as const) {
    it(`releases capture on ${mode}, ignores its drag, and needs no reentry delay`, () => {
      const { router, pass, released } = setup()
      const block = (on: boolean): void => {
        if (mode === "resize") router.setResizing(on)
        else if (mode === "blur") router.setFocused(!on)
        else router.setEnabled(!on)
      }
      expect(pass(event("mousedown", 1, 0, 70, 80))).toBe(true)
      block(true)
      block(true)
      expect(released).toEqual([{ x: 70, y: 80 }])
      expect(pass(event("mousemove"))).toBe(false)
      expect(pass(event("mousedown", 1))).toBe(false)
      expect(pass(event("wheel"))).toBe(false)
      block(false)
      expect(pass(event("mousemove", 1))).toBe(false)
      expect(pass(event("mouseup"))).toBe(false)
      expect(pass(event("mousemove"))).toBe(true)
      expect(pass(event("mousedown", 1))).toBe(true)
    })
  }
})

// Exercise the exact private noVNC methods and real document capture proxy used
// by Screen, not a second implementation of their button/timer/capture behavior.
GlobalRegistrator.register()
const { default: RFB } = await import("novnc/core/rfb.js")
const { clientToElement } = await import("novnc/core/util/element.js")
const { releaseCapture } = await import("novnc/core/util/events.js")

interface TestPointer extends NoVncPointer {
  _handleMouse(event: MouseEvent): void
  _mouseLastMoveTime: number
}

let dispose: (() => void) | null = null
afterEach(() => {
  dispose?.()
  dispose = null
  releaseCapture()
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

function noVnc() {
  const host = document.createElement("div")
  const canvas = document.createElement("canvas")
  host.append(canvas)
  document.body.append(host)
  canvas.getBoundingClientRect = () => new DOMRect(10, 20, 100, 100)
  const sent: { x: number; y: number; buttons: number }[] = []
  const conn: TestPointer = Object.assign(Object.create(RFB.prototype), {
    _canvas: canvas,
    _mouseButtonMask: 0,
    _mouseMoveTimer: null,
    _mouseLastMoveTime: 0,
    _sendMouse: (x: number, y: number, buttons: number) => sent.push({ x, y, buttons }),
  })
  const router = new GuestPointerRouter((point) => {
    const pos = point === null ? { x: 0, y: 0 } : clientToElement(point.x, point.y, canvas)
    releaseNoVncPointer(conn, pos, releaseCapture)
  })
  for (const name of ["mousedown", "mouseup", "mousemove"] as const) {
    host.addEventListener(name, (e) => router.handle(e), true)
    canvas.addEventListener(name, (e) => conn._handleMouse(e))
  }
  dispose = () => router.releaseAll()
  const send = (target: EventTarget, type: string, buttons = 0, x = 50, y = 60): void => {
    conn._mouseLastMoveTime = 0
    target.dispatchEvent(new MouseEvent(type, { buttons, clientX: x, clientY: y, bubbles: true, cancelable: true }))
  }
  const captured = (): boolean => document.getElementById("noVNC_mouse_capture_elem")?.style.display === ""
  return { canvas, conn, router, sent, send, captured }
}

describe("noVNC drag capture integration", () => {
  it("creates no document capture for a host drag entering the canvas", () => {
    const { canvas, sent, send, captured } = noVnc()
    send(canvas, "mousemove", 1)
    send(canvas, "mouseup")
    expect(sent).toEqual([])
    expect(captured()).toBe(false)
    send(canvas, "mousemove")
    expect(sent).toEqual([{ x: 40, y: 40, buttons: 0 }])
  })

  it("keeps noVNC's standard captured guest drag and edge clipping, then releases normally", () => {
    const { canvas, sent, send, captured } = noVnc()
    send(canvas, "mousedown", 1)
    expect(captured()).toBe(true)
    send(window, "mousemove", 1, 150, 170)
    send(window, "mouseup", 0, 150, 170)
    expect(sent).toEqual([
      { x: 40, y: 40, buttons: 1 },
      { x: 99, y: 99, buttons: 1 },
      { x: 99, y: 99, buttons: 0 },
    ])
    expect(captured()).toBe(false)
  })

  it("releases at the last actual position, cancels queued movement, and removes the overlay on live resize", async () => {
    const { canvas, conn, router, sent, send, captured } = noVnc()
    send(canvas, "mousedown", 1, 80, 90)
    send(canvas, "mousemove", 1, 85, 95)
    // Force a queued move using the actual noVNC throttle.
    conn._mouseLastMoveTime = Date.now()
    canvas.dispatchEvent(new MouseEvent("mousemove", { buttons: 1, clientX: 90, clientY: 100, bubbles: true }))
    expect(conn._mouseMoveTimer).not.toBeNull()
    const before = sent.length
    router.setResizing(true)
    expect(sent.slice(before)).toEqual([{ x: 80, y: 80, buttons: 0 }])
    expect(conn._mouseMoveTimer).toBeNull()
    expect(conn._mouseButtonMask).toBe(0)
    expect(captured()).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent).toHaveLength(before + 1)
    router.setResizing(false)
    send(canvas, "mousemove")
    expect(sent.at(-1)).toEqual({ x: 40, y: 40, buttons: 0 })
  })

  it("releases every held button and the document overlay on focus loss", () => {
    const { canvas, conn, router, sent, send, captured } = noVnc()
    send(canvas, "mousedown", 1)
    canvas.dispatchEvent(new MouseEvent("mousedown", { buttons: 3, button: 2, clientX: 60, clientY: 70, bubbles: true }))
    expect(conn._mouseButtonMask).toBe(5) // noVNC's RFB bits, not the DOM bits
    router.setFocused(false)
    expect(sent.at(-1)).toEqual({ x: 50, y: 50, buttons: 0 })
    expect(conn._mouseButtonMask).toBe(0)
    expect(captured()).toBe(false)
    router.setFocused(true)
    send(canvas, "mousemove", 3)
    expect(sent.at(-1)?.buttons).toBe(0)
  })
})
