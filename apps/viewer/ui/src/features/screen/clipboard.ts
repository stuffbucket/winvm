/**
 * The clipboard between the Mac and Windows, text only, while the window is in
 * front: what Windows copies goes on the Mac's clipboard, and what the Mac's
 * clipboard holds goes to Windows when the window comes forward (and once
 * when the screen connects). QEMU's qemu-vdagent carries it to and from
 * Windows, through noVNC's (extended) clipboard.
 *
 * `shared` is the text both sides are known to hold, so neither side's copy
 * comes back as a change from the other (no echo), and coming forward with
 * the same Mac clipboard sends nothing.
 */
export interface ClipboardPorts {
  /** The Mac's clipboard text; empty when it holds none. */
  readMac(): Promise<string>
  writeMac(text: string): Promise<void>
  /** Hands text to Windows. */
  toGuest(text: string): void
  /** The window is in front. */
  focused(): boolean
}

export class ClipboardSync {
  private readonly ports: ClipboardPorts
  private shared: string | null = null
  /** Bumped by each copy from Windows, so a Mac read begun before it doesn't undo it. */
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

  /**
   * The screen is connected and the clipboard can carry text: the Mac's goes
   * to Windows first, if the window is in front. Until then what Windows says
   * is ignored, so a reconnect doesn't replace the Mac's clipboard with
   * Windows' older one.
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) return
    try {
      await this.fromMac()
    } finally {
      this.started = true
    }
  }

  /** Cancel late reads and queued writes when the screen disconnects or changes machine. */
  stop(): void {
    this.stopped = true
    this.generation++
    this.again = false
    this.pendingGuest = null
  }

  /** Windows' clipboard changed. */
  fromGuest(text: string): void {
    if (this.stopped || !this.started || !this.ports.focused() || (text === this.shared && this.writing === null)) return
    this.generation++
    this.pendingGuest = text
    // Native writes are asynchronous. Starting each immediately can let an
    // older write finish last and leave the Mac holding stale Windows text.
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
        // Do not remember a failed native write as shared: the same Windows
        // text must be allowed to retry rather than suppressed forever.
        this.shared = null
        console.warn("putting Windows' clipboard on the Mac failed", error)
      }
    }
  }

  /** The window came forward: send the Mac's clipboard to Windows if it changed. */
  fromMac(): Promise<void> {
    if (this.stopped || !this.ports.focused()) return Promise.resolve()
    // Do not read the previous Mac value while a Windows copy is landing.
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
    if (this.stopped || text === "" || text === this.shared || before !== this.generation || !this.ports.focused()) return
    try {
      this.ports.toGuest(text)
      this.shared = text
    } catch (error) {
      // A disconnected transport must not suppress the next attempt.
      console.warn("putting the Mac's clipboard in Windows failed", error)
    }
  }
}
