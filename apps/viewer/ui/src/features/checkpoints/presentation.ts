import { setCheckpointPresentation } from "../../backend"

/** Keep enter/leave in order, including effect cleanup/replay and a fast dismissal. */
export class PresentationQueue {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly change: (enabled: boolean) => Promise<void>) {}

  set(enabled: boolean): Promise<void> {
    const next = this.tail.catch(() => undefined).then(() => this.change(enabled))
    this.tail = next
    return next
  }
}

export const checkpointPresentation = new PresentationQueue(setCheckpointPresentation)
