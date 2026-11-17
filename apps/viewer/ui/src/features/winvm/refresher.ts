const FOLLOW_UP_FIRST_MS = 1000
const FOLLOW_UPS = 5

interface Slot {
  timer: ReturnType<typeof setTimeout> | undefined
  due: number
  reads: number
  again: boolean
  followUps: number
}

export class Refresher {
  private readonly slots = new Map<string, Slot>()
  private readonly read: (name: string) => void
  private stopped = false

  constructor(read: (name: string) => void) {
    this.read = read
  }

  private slot(name: string): Slot {
    let s = this.slots.get(name)
    if (s === undefined) {
      s = { timer: undefined, due: 0, reads: 0, again: false, followUps: 0 }
      this.slots.set(name, s)
    }
    return s
  }

  soon(name: string, ms: number): void {
    if (this.stopped) return
    const s = this.slot(name)
    const due = Date.now() + ms
    if (s.timer !== undefined) {
      if (s.due <= due) return
      clearTimeout(s.timer)
    }
    s.due = due
    s.timer = setTimeout(() => {
      s.timer = undefined
      if (s.reads > 0) s.again = true
      else this.read(name)
    }, ms)
  }

  changed(name: string, ms: number): void {
    this.slot(name).followUps = 0
    this.soon(name, ms)
  }

  begin(name: string): void {
    const s = this.slot(name)
    if (s.timer !== undefined) {
      clearTimeout(s.timer)
      s.timer = undefined
    }
    s.reads += 1
  }

  end(name: string, transient: boolean | null): void {
    const s = this.slot(name)
    s.reads = Math.max(0, s.reads - 1)
    if (s.reads === 0 && s.again) {
      s.again = false
      this.soon(name, 0)
      return
    }
    if (transient === null) return
    if (!transient) {
      s.followUps = 0
      return
    }
    if (s.followUps >= FOLLOW_UPS) return
    const wait = FOLLOW_UP_FIRST_MS * 2 ** s.followUps
    s.followUps += 1
    this.soon(name, wait)
  }

  start(): void {
    this.stopped = false
  }

  stop(): void {
    this.stopped = true
    for (const s of this.slots.values())
      if (s.timer !== undefined) clearTimeout(s.timer)
    this.slots.clear()
  }
}
