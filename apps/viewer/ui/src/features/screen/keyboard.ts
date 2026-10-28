export interface GuestKey {
  readonly keysym: number
  readonly code: string
}

export interface KeyboardSend {
  (keysym: number, code: string, down: boolean): void
}

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
  readonly releaseNoVnc: () => void
  readonly onCaptured: (captured: boolean) => void
}

const SUPER = 0xffeb
const SUPER_RIGHT = 0xffec
const CONTROL = 0xffe3

const stopGuest = (event: RoutedKeyEvent): void => event.stopImmediatePropagation()
const stopAll = (event: RoutedKeyEvent): void => {
  event.preventDefault()
  event.stopImmediatePropagation()
}

const isMeta = (code: string): boolean => code === "MetaLeft" || code === "MetaRight"
const isCaptureModifier = (code: string): boolean => code.startsWith("Control") || code.startsWith("Alt")

/**
 * Keeps Mac shortcuts on the Mac until keyboard capture is explicit.
 *
 * noVNC remains the normal keyboard implementation. This router runs in the
 * capture phase and only intercepts host Command keys, the capture chord, and
 * focus loss. Right Command is the deliberate uncaptured Windows modifier.
 */
export class GuestKeyboardRouter {
  private captured = false
  private captureChord = false
  private rightCommand = false
  private rightWindowsDown = false
  private readonly capturedWindows = new Map<string, GuestKey>()

  constructor(private readonly options: RouterOptions) {}

  setCaptured(captured: boolean): void {
    if (this.captured === captured) return
    this.releaseAll()
    this.captured = captured
  }

  isCaptured(): boolean {
    return this.captured
  }

  keyDown(event: RoutedKeyEvent): void {
    if (!event.repeat && isCaptureModifier(event.code) && event.ctrlKey && event.altKey) {
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
          const key = event.code === "MetaRight" ? { keysym: SUPER_RIGHT, code: "MetaRight" } : { keysym: SUPER, code: "MetaLeft" }
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
    if (isCaptureModifier(event.code) && !(event.ctrlKey && event.altKey)) this.captureChord = false
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

  /**
   * Releases everything before noVNC's own blur handler. If Windows is down,
   * Ctrl is pressed and released first, so the subsequent Windows-key release
   * cannot be interpreted as a lone press that opens Start.
   */
  releaseAll(): void {
    if (this.capturedWindows.size > 0 || this.rightWindowsDown) {
      this.options.send(CONTROL, "ControlLeft", true)
      this.options.send(CONTROL, "ControlLeft", false)
    }
    for (const key of this.capturedWindows.values()) this.options.send(key.keysym, key.code, false)
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
  send(0xffe9, "AltLeft", true)
  send(0xffff, "Delete", true)
  send(0xffff, "Delete", false)
  send(0xffe9, "AltLeft", false)
  send(CONTROL, "ControlLeft", false)
}
