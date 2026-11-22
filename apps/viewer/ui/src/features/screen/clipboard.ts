export interface ClipboardPorts {
  readMac(): Promise<string>
  writeMac(text: string): Promise<void>
  toGuest(text: string): void
  focused(): boolean
}

export class ClipboardSync {
  private readonly ports: ClipboardPorts
  private shared: string | null = null
  private generation = 0
  private reading: Promise<void> | null = null
  private again = false
  private started = false
  private stopped = false
  private writing: Promise<void> | null = null
  private pendingGuest: string | null = null

  constructor(ports: ClipboardPorts) {
    this.ports = ports
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return
    try {
      await this.fromMac()
    } finally {
      this.started = true
    }
  }

  stop(): void {
    this.stopped = true
    this.generation++
    this.again = false
    this.pendingGuest = null
  }

  fromGuest(text: string): void {
    if (
      this.stopped ||
      !this.started ||
      !this.ports.focused() ||
      (text === this.shared && this.writing === null)
    )
      return
    this.generation++
    this.pendingGuest = text
    this.flushGuest()
  }

  private flushGuest(): void {
    this.writing ??= this.writeGuest().finally(() => {
      this.writing = null
      if (this.pendingGuest !== null) this.flushGuest()
    })
  }

  private async writeGuest(): Promise<void> {
    while (this.pendingGuest !== null) {
      const text = this.pendingGuest
      this.pendingGuest = null
      if (this.stopped || !this.ports.focused()) return
      try {
        await this.ports.writeMac(text)
        this.shared = text
      } catch (error) {
        this.shared = null
        console.warn("putting Windows' clipboard on the Mac failed", error)
      }
    }
  }

  fromMac(): Promise<void> {
    if (this.stopped || !this.ports.focused()) return Promise.resolve()
    if (this.writing !== null) return this.writing.then(() => this.fromMac())
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
      this.stopped ||
      text === "" ||
      text === this.shared ||
      before !== this.generation ||
      !this.ports.focused()
    )
      return
    try {
      this.ports.toGuest(text)
      this.shared = text
    } catch (error) {
      console.warn("putting the Mac's clipboard in Windows failed", error)
    }
  }
}
