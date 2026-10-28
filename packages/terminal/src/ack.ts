export interface TerminalAckScheduler {
  schedule(callback: () => void): void;
}

/** Coalesces completed terminal writes into cumulative acknowledgements. */
export class TerminalAcknowledgements {
  private sequence = 0;
  private acknowledgedSequence = 0;
  private scheduled = false;
  private disposed = false;

  constructor(
    private readonly acknowledge: (sequence: number) => void,
    private readonly scheduler: TerminalAckScheduler,
  ) {}

  consume(sequence: number): void {
    if (this.disposed || sequence <= this.acknowledgedSequence) return;
    this.sequence = Math.max(sequence, this.sequence);
    if (this.scheduled) return;
    this.scheduled = true;
    this.scheduler.schedule(() => {
      this.scheduled = false;
      if (this.disposed) return;
      const sequence = this.sequence;
      this.sequence = 0;
      this.acknowledgedSequence = sequence;
      this.acknowledge(sequence);
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Coalesces emulator resizes to the latest dimensions once per frame. */
export class TerminalResizes {
  private pending: { cols: number; rows: number } | undefined;
  private scheduled = false;
  private disposed = false;

  constructor(
    private readonly resize: (cols: number, rows: number) => void,
    private readonly scheduler: TerminalAckScheduler,
  ) {}

  update(cols: number, rows: number): void {
    if (this.disposed) return;
    this.pending = { cols, rows };
    if (this.scheduled) return;
    this.scheduled = true;
    this.scheduler.schedule(() => {
      this.scheduled = false;
      if (this.disposed) return;
      const { cols, rows } = this.pending!;
      this.pending = undefined;
      this.resize(cols, rows);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
  }
}

/** Use browser frames when available, with a Node-safe microtask fallback. */
class AnimationFrameScheduler implements TerminalAckScheduler {
  schedule(callback: () => void): void {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(callback);
    } else {
      queueMicrotask(callback);
    }
  }
}

export const animationFrameScheduler: TerminalAckScheduler = new AnimationFrameScheduler();
