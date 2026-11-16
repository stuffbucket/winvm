export interface TerminalAckScheduler {
  schedule(callback: () => void): void
}

export class TerminalAcknowledgements {
  private sequence = 0
  private acknowledgedSequence = 0
  private scheduled = false
  private disposed = false
  private readonly acknowledge: (sequence: number) => void
  private readonly scheduler: TerminalAckScheduler

  constructor(
    acknowledge: (sequence: number) => void,
    scheduler: TerminalAckScheduler,
  ) {
    this.acknowledge = acknowledge
    this.scheduler = scheduler
  }

  consume(sequence: number): void {
    if (this.disposed || sequence <= this.acknowledgedSequence) return
    this.sequence = Math.max(sequence, this.sequence)
    if (this.scheduled) return
    this.scheduled = true
    this.scheduler.schedule(() => {
      this.scheduled = false
      if (this.disposed) return
      const sequence = this.sequence
      this.sequence = 0
      this.acknowledgedSequence = sequence
      this.acknowledge(sequence)
    })
  }

  dispose(): void {
    this.disposed = true
  }
}

export class TerminalResizes {
  private pending: { cols: number; rows: number } | undefined
  private scheduled = false
  private disposed = false
  private readonly resize: (cols: number, rows: number) => void
  private readonly scheduler: TerminalAckScheduler

  constructor(
    resize: (cols: number, rows: number) => void,
    scheduler: TerminalAckScheduler,
  ) {
    this.resize = resize
    this.scheduler = scheduler
  }

  update(cols: number, rows: number): void {
    if (this.disposed) return
    this.pending = { cols, rows }
    if (this.scheduled) return
    this.scheduled = true
    this.scheduler.schedule(() => {
      this.scheduled = false
      if (this.disposed) return
      const { cols, rows } = this.pending!
      this.pending = undefined
      this.resize(cols, rows)
    })
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
  }
}

class AnimationFrameScheduler implements TerminalAckScheduler {
  schedule(callback: () => void): void {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(callback)
    } else {
      queueMicrotask(callback)
    }
  }
}

export const animationFrameScheduler: TerminalAckScheduler =
  new AnimationFrameScheduler()
