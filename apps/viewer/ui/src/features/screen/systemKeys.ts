let issued = 0

export function nextSeq(now: number = Date.now()): number {
  issued = Math.max(now, issued + 1)
  return issued
}

export class SystemKeyGate {
  private captured = false
  private focused = false
  private armed = false
  private readonly arm: (armed: boolean) => void

  constructor(arm: (armed: boolean) => void) {
    this.arm = arm
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
    if (armed === this.armed) return
    this.armed = armed
    this.arm(armed)
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
