export interface ClipboardPorts {
  readMac(): Promise<string>
  writeMac(text: string): Promise<void>
  toGuest(text: string): void
  focused(): boolean
  canSend?(): boolean
}

export class ClipboardSync {
  private readonly ports: ClipboardPorts
  private shared: string | null = null
  private generation = 0
  private reading: Promise<void> | null = null
  private again = false
  private started = false

  constructor(ports: ClipboardPorts) {
    this.ports = ports
  }

  async start(): Promise<void> {
    if (this.started) return
    try {
      await this.fromMac()
    } finally {
      this.started = true
    }
  }

  fromGuest(text: string): void {
    if (!this.started || !this.ports.focused() || text === this.shared) return
    this.shared = text
    this.generation++
    this.ports.writeMac(text).catch((error: unknown) => {
      console.warn("putting Windows' clipboard on the Mac failed", error)
    })
  }

  fromMac(): Promise<void> {
    if (!this.ports.focused() || this.ports.canSend?.() === false)
      return Promise.resolve()
    if (this.reading !== null) {
      this.again = true
      return this.reading
    }
    this.reading = this.read().finally(() => {
      this.reading = null
      if (this.again) {
        this.again = false
        void this.fromMac()
      }
    })
    return this.reading
  }

  private async read(): Promise<void> {
    const before = this.generation
    let text: string
    try {
      text = await this.ports.readMac()
    } catch (error) {
      console.warn("reading the Mac's clipboard failed", error)
      return
    }
    if (
      text === "" ||
      text === this.shared ||
      before !== this.generation ||
      !this.ports.focused() ||
      this.ports.canSend?.() === false
    )
      return
    this.shared = text
    this.ports.toGuest(text)
  }
}
