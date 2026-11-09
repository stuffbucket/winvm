/**
 * Who has the keyboard and the pointer over the screen. Pure, so the tests
 * drive it.
 *
 * The guest gets input only while it is live and answering: Windows running,
 * no verb under way (starting, restarting, saving, loading, pausing, locking,
 * waking: all of them busy). In every other phase the frame is a picture, not a
 * window into the machine, and the Mac keeps what is its own:
 *
 * - the pointer: no event reaches noVNC, and the Mac's arrow shows over the
 *   frame, never the guest's cursor and never a hidden one;
 * - the keyboard: nothing is captured (one that was is released, and says so),
 *   no key is swallowed, and none is sent;
 * - the buttons that send input (Capture Keyboard, Send Windows Key, Send
 *   Ctrl-Alt-Delete) are off, and say why.
 *
 * Asleep is the one exception that listens: its first key wakes the machine
 * (held.ts), and goes no further.
 */
import type { Phase } from "../../model"

export interface InputRule {
  /** Mouse, wheel and keys go to the guest. */
  readonly forward: boolean
  /** Over the frame: the guest's own cursor, or the Mac's arrow. */
  readonly cursor: "guest" | "arrow"
  /** Keyboard capture can be engaged, or is released (and stays so until it is asked for again). */
  readonly capture: "allowed" | "released"
  /** A click on the frame takes keyboard focus, so a key can wake an asleep machine. */
  readonly focusOnClick: boolean
  /** An i18n key saying why the guest takes no input; null when it does. */
  readonly why: string | null
  /** An i18n key for the quiet note beside the toolbar when this released a capture; null when it can't. */
  readonly released: string | null
}

const LIVE: InputRule = { forward: true, cursor: "guest", capture: "allowed", focusOnClick: true, why: null, released: null }

const off = (name: string, focusOnClick = false): InputRule => ({
  forward: false,
  cursor: "arrow",
  capture: "released",
  focusOnClick,
  why: `input.why.${name}`,
  released: `input.released.${name}`,
})

/** `busy`: a verb is under way (or there is no word yet from the machine, or the host isn't ready). */
export function inputRule(phase: Phase | null | undefined, busy: boolean): InputRule {
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

// ---------------------------------------------------------------------------
// The pointer, while the guest takes input

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

// DOM button numbers are not bit positions: middle is button 1, but bit 2.
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

  constructor(private readonly release: (point: PointerPoint | null) => void) {}

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

    if (!this.enabled || !this.focused || this.resizing || !owned || event.buttons !== next) {
      if (this.buttons !== 0) this.releaseAll()
      // A missed mouseup must not leave the guest dragging. Resume hover at once;
      // a host-held button, however, stays outside until it is actually released.
      if (this.enabled && this.focused && !this.resizing && event.type === "mousemove" && event.buttons === 0) {
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

/** Release before viewOnly/disconnect, and never flush a queued stale drag first. */
export function releaseNoVncPointer(conn: NoVncPointer, point: PointerPoint, releaseCapture: () => void): void {
  if (conn._mouseMoveTimer !== null) {
    clearTimeout(conn._mouseMoveTimer)
    conn._mouseMoveTimer = null
  }
  if (conn._mouseButtonMask !== 0) conn._handleMouseButton(point.x, point.y, 0)
  releaseCapture()
}
