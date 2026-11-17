import { setCheckpointPresentation } from "../../backend"

export class PresentationQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly change: (enabled: boolean) => Promise<void>

  constructor(change: (enabled: boolean) => Promise<void>) {
    this.change = change
  }

  set(enabled: boolean): Promise<void> {
    const next = this.tail
      .catch(() => undefined)
      .then(() => this.change(enabled))
    this.tail = next
    return next
  }
}

export const checkpointPresentation = new PresentationQueue(
  setCheckpointPresentation,
)
