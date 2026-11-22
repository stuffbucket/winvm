import type { Phase } from "../../model"

export interface InputRule {
  readonly forward: boolean
  readonly cursor: "guest" | "arrow"
  readonly capture: "allowed" | "released"
  readonly focusOnClick: boolean
  readonly why: string | null
  readonly released: string | null
}

const LIVE: InputRule = {
  forward: true,
  cursor: "guest",
  capture: "allowed",
  focusOnClick: true,
  why: null,
  released: null,
}

const off = (name: string, focusOnClick = false): InputRule => ({
  forward: false,
  cursor: "arrow",
  capture: "released",
  focusOnClick,
  why: `input.why.${name}`,
  released: `input.released.${name}`,
})

export function inputRule(
  phase: Phase | null | undefined,
  busy: boolean,
): InputRule {
  switch (phase) {
    case "running":
      return busy ? off("busy") : LIVE
    case "starting":
      return off("starting")
    case "paused":
      return off("paused")
    case "asleep":
      return off("asleep", true)
    case "stopped":
    case "stowed":
    case "missing":
    case null:
    case undefined:
      return off("off")
  }
}

export interface PointerPoint {
  readonly x: number
  readonly y: number
}

export interface RoutedPointerEvent {
  readonly type: string
  readonly button: number
  readonly buttons: number
  readonly clientX: number
  readonly clientY: number
  preventDefault(): void
  stopImmediatePropagation(): void
}

const BUTTON_BITS = [1, 4, 2, 8, 16] as const
const buttonBit = (button: number): number => BUTTON_BITS[button] ?? 0

/**
 * noVNC owns ordinary absolute motion, scrolling and guest-origin drags, including
 * its temporary document capture while a guest button is held. That is not
 * relative mouse capture. A host drag entering the view must not become one.
 *
 * UTM uses immediate absolute motion when uncaptured, relative motion only on
 * explicit capture; no edge delay or averaging (VMMetalView.swift, lines 283-305):
 * https://github.com/utmapp/UTM/blob/f3985949e22ce56c8d18e848a8d4dd95274aee70/Platform/macOS/Display/VMMetalView.swift#L283-L305
 * Likewise, this gate neither changes coordinates nor delays ordinary input.
 */
export class GuestPointerRouter {
  private buttons = 0
  private point: PointerPoint | null = null
  private enabled = true
  private focused = true
  private resizing = false
  private readonly release: (point: PointerPoint | null) => void

  constructor(release: (point: PointerPoint | null) => void) {
    this.release = release
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) this.releaseAll()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    if (!focused) this.releaseAll()
  }

  setResizing(resizing: boolean): void {
    if (this.resizing === resizing) return
    this.resizing = resizing
    if (resizing) this.releaseAll()
  }

  handle(event: RoutedPointerEvent): void {
    let next = this.buttons
    const bit = buttonBit(event.button)
    let owned = true
    if (event.type === "mousedown") {
      next |= bit
      owned = bit !== 0
    } else if (event.type === "mouseup") {
      owned = (next & bit) !== 0
      next &= ~bit
    }

    if (
      !this.enabled ||
      !this.focused ||
      this.resizing ||
      !owned ||
      event.buttons !== next
    ) {
      if (this.buttons !== 0) this.releaseAll()
      if (
        this.enabled &&
        this.focused &&
        !this.resizing &&
        event.type === "mousemove" &&
        event.buttons === 0
      ) {
        this.point = { x: event.clientX, y: event.clientY }
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }

    this.buttons = next
    this.point = { x: event.clientX, y: event.clientY }
  }

  releaseAll(): void {
    this.buttons = 0
    this.release(this.point)
  }
}

export interface NoVncPointer {
  _mouseMoveTimer: ReturnType<typeof setTimeout> | null
  readonly _mouseButtonMask: number
  _handleMouseButton(x: number, y: number, buttons: number): void
}

export function releaseNoVncPointer(
  conn: NoVncPointer,
  point: PointerPoint,
  releaseCapture: () => void,
): void {
  if (conn._mouseMoveTimer !== null) {
    clearTimeout(conn._mouseMoveTimer)
    conn._mouseMoveTimer = null
  }
  if (conn._mouseButtonMask !== 0) conn._handleMouseButton(point.x, point.y, 0)
  releaseCapture()
}
