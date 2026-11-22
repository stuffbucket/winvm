export interface GuestKey {
  readonly keysym: number
  readonly code: string
}

export type KeyboardSend = (keysym: number, code: string, down: boolean) => void

export interface RoutedKeyEvent {
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly repeat: boolean
  preventDefault(): void
  stopImmediatePropagation(): void
}

interface RouterOptions {
  readonly send: KeyboardSend
  readonly translate: (event: RoutedKeyEvent) => GuestKey | null
  readonly fromCode: (code: string) => GuestKey | null
  readonly releaseNoVnc: () => void
  readonly onCaptured: (captured: boolean) => void
}

const SUPER = 0xffeb
const SUPER_RIGHT = 0xffec
const CONTROL = 0xffe3
const ALT = 0xffe9
const DELETE = 0xffff

const stopGuest = (event: RoutedKeyEvent): void => {
  event.stopImmediatePropagation()
}
const stopAll = (event: RoutedKeyEvent): void => {
  event.preventDefault()
  event.stopImmediatePropagation()
}

const isMeta = (code: string): boolean =>
  code === "MetaLeft" || code === "MetaRight"
const isCaptureModifier = (code: string): boolean =>
  code.startsWith("Control") || code.startsWith("Alt")

export class GuestKeyboardRouter {
  private captured = false
  private enabled = true
  private captureChord = false
  private rightCommand = false
  private rightWindowsDown = false
  private readonly capturedWindows = new Map<string, GuestKey>()
  private readonly systemHeld = new Map<string, GuestKey>()
  private readonly options: RouterOptions

  constructor(options: RouterOptions) {
    this.options = options
  }

  setCaptured(captured: boolean): void {
    if (this.captured === captured || (captured && !this.enabled)) return
    this.releaseAll()
    this.captured = captured
  }

  isCaptured(): boolean {
    return this.captured
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    if (!enabled) this.lostFocus()
    this.enabled = enabled
  }

  keyDown(event: RoutedKeyEvent): void {
    if (!this.enabled) return
    if (
      !event.repeat &&
      isCaptureModifier(event.code) &&
      event.ctrlKey &&
      event.altKey
    ) {
      stopAll(event)
      if (!this.captureChord) {
        this.captureChord = true
        this.releaseAll()
        this.captured = !this.captured
        this.options.onCaptured(this.captured)
      }
      return
    }

    if (this.captured) {
      if (isMeta(event.code)) {
        stopAll(event)
        if (!this.capturedWindows.has(event.code)) {
          const key =
            event.code === "MetaRight"
              ? { keysym: SUPER_RIGHT, code: "MetaRight" }
              : { keysym: SUPER, code: "MetaLeft" }
          this.capturedWindows.set(event.code, key)
          this.options.send(key.keysym, key.code, true)
        }
      }
      return
    }

    if (event.code === "MetaLeft") {
      stopGuest(event)
      return
    }
    if (event.code === "MetaRight") {
      stopAll(event)
      this.rightCommand = true
      return
    }
    if (event.metaKey) {
      if (this.rightCommand) {
        stopAll(event)
        const key = this.options.translate(event)
        if (key !== null) {
          if (!this.rightWindowsDown) {
            this.options.send(SUPER, "MetaLeft", true)
            this.rightWindowsDown = true
          }
          this.options.send(key.keysym, key.code, true)
          this.options.send(key.keysym, key.code, false)
        }
      } else {
        stopGuest(event)
      }
    }
  }

  keyUp(event: RoutedKeyEvent): void {
    if (!this.enabled) return
    if (isCaptureModifier(event.code) && !(event.ctrlKey && event.altKey))
      this.captureChord = false
    if (this.captured) {
      if (isMeta(event.code)) {
        stopAll(event)
        const key = this.capturedWindows.get(event.code)
        if (key !== undefined) {
          this.options.send(key.keysym, key.code, false)
          this.capturedWindows.delete(event.code)
        }
      }
      return
    }
    if (event.code === "MetaLeft") {
      stopGuest(event)
      return
    }
    if (event.code === "MetaRight") {
      stopAll(event)
      if (this.rightCommand) {
        if (this.rightWindowsDown) this.options.send(SUPER, "MetaLeft", false)
        this.rightCommand = false
        this.rightWindowsDown = false
      }
      return
    }
    if (event.metaKey) stopGuest(event)
  }

  systemKey(code: string, down: boolean): void {
    if (!this.enabled || !this.captured) return
    const key = down
      ? this.options.fromCode(code)
      : (this.systemHeld.get(code) ?? null)
    if (key === null) return
    if (down) this.systemHeld.set(code, key)
    else this.systemHeld.delete(code)
    this.options.send(key.keysym, key.code, down)
  }

  releaseAll(): void {
    for (const key of this.systemHeld.values())
      this.options.send(key.keysym, key.code, false)
    this.systemHeld.clear()
    if (this.capturedWindows.size > 0 || this.rightWindowsDown) {
      this.options.send(CONTROL, "ControlLeft", true)
      this.options.send(CONTROL, "ControlLeft", false)
    }
    for (const key of this.capturedWindows.values())
      this.options.send(key.keysym, key.code, false)
    this.capturedWindows.clear()
    if (this.rightWindowsDown) this.options.send(SUPER, "MetaLeft", false)
    this.rightCommand = false
    this.rightWindowsDown = false
    this.options.releaseNoVnc()
  }

  lostFocus(): void {
    this.releaseAll()
    this.captureChord = false
    if (this.captured) {
      this.captured = false
      this.options.onCaptured(false)
    }
  }
}

export function sendWindowsKey(send: KeyboardSend): void {
  send(SUPER, "MetaLeft", true)
  send(SUPER, "MetaLeft", false)
}

export function sendCtrlAltDelete(send: KeyboardSend): void {
  send(CONTROL, "ControlLeft", true)
  send(ALT, "AltLeft", true)
  send(DELETE, "Delete", true)
  send(DELETE, "Delete", false)
  send(ALT, "AltLeft", false)
  send(CONTROL, "ControlLeft", false)
}
