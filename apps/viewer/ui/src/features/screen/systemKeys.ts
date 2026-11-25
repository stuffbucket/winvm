export const SYSTEM_KEYS_RENEW_MS = 250

let issued = 0

export function nextSeq(): number {
  issued += 1
  return issued
}

export interface Repeater {
  repeat(fn: () => void, ms: number): unknown
  stop(handle: unknown): void
}

const intervals: Repeater = {
  repeat: (fn, ms) => setInterval(fn, ms),
  stop: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

export class SystemKeyGate {
  private captured = false
  private focused = false
  private renewal: unknown = null
  private readonly arm: (armed: boolean) => void
  private readonly repeater: Repeater

  constructor(arm: (armed: boolean) => void, repeater: Repeater = intervals) {
    this.arm = arm
    this.repeater = repeater
    this.arm(false)
  }

  setCaptured(captured: boolean): void {
    this.captured = captured
    this.update()
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    this.update()
  }

  private update(): void {
    const armed = this.captured && this.focused
    if (armed === (this.renewal !== null)) return
    if (armed) {
      this.arm(true)
      this.renewal = this.repeater.repeat(() => {
        this.arm(true)
      }, SYSTEM_KEYS_RENEW_MS)
    } else {
      this.repeater.stop(this.renewal)
      this.renewal = null
      this.arm(false)
    }
  }
}

const PRINTABLE: Readonly<Record<string, string>> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  IntlBackslash: "<",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
  NumpadDecimal: ".",
  NumpadMultiply: "*",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadDivide: "/",
  NumpadEqual: "=",
  NumpadComma: ",",
  NumpadEnter: "Enter",
  NumLock: "Clear",
  IntlYen: "¥",
  IntlRo: "\\",
}

export interface KeyDescription {
  readonly key: string
  readonly numpad: boolean
}

export function describeCode(code: string): KeyDescription {
  const numpad = code.startsWith("Numpad")
  const letter = /^Key([A-Z])$/.exec(code)?.[1]
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)?.[1]
  const key = letter?.toLowerCase() ?? digit ?? PRINTABLE[code] ?? code
  return { key, numpad }
}
