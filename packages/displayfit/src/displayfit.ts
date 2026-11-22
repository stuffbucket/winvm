export const MAX_FRAMEBUFFER_BYTES = 30 * 1024 * 1024
export const BYTES_PER_PIXEL = 4
export const MAX_WIDTH = 5120
export const MAX_HEIGHT = 2160
export const MIN_WIDTH = 1024
export const MIN_HEIGHT = 768
export const WIDTH_STEP = 16

export const SCALES = [
  100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500,
] as const

export interface Size {
  readonly width: number
  readonly height: number
}

const floorTo = (n: number, step: number): number => Math.floor(n / step) * step

const fits = (s: Size): boolean =>
  s.width <= MAX_WIDTH &&
  s.height <= MAX_HEIGHT &&
  s.width * s.height * BYTES_PER_PIXEL <= MAX_FRAMEBUFFER_BYTES

export function clampSize(want: Size): Size {
  let w = Math.max(Math.floor(want.width), 1)
  let h = Math.max(Math.floor(want.height), 1)
  if (!fits({ width: w, height: h })) {
    const k = Math.min(
      1,
      MAX_WIDTH / w,
      MAX_HEIGHT / h,
      Math.sqrt(MAX_FRAMEBUFFER_BYTES / BYTES_PER_PIXEL / (w * h)),
    )
    w = Math.floor(w * k)
    h = Math.floor(h * k)
  }
  w = Math.max(MIN_WIDTH, floorTo(w, WIDTH_STEP))
  h = Math.max(MIN_HEIGHT, h)
  while (!fits({ width: w, height: h }) && h > MIN_HEIGHT) h -= 1
  while (!fits({ width: w, height: h }) && w > MIN_WIDTH) w -= WIDTH_STEP
  return { width: w, height: h }
}

export function guestSizeFor(css: Size, dpr: number): Size {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return clampSize({
    width: Math.floor(css.width * ratio),
    height: Math.floor(css.height * ratio),
  })
}

export const MAX_DRAW = { width: 5120, height: 2880 } as const

export function drawSize(guest: Size, view: Size, dpr: number): Size {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const raw = {
    width: Math.floor(view.width * ratio),
    height: Math.floor(view.height * ratio),
  }
  if (fits(raw)) {
    return {
      width: Math.min(guest.width / ratio, view.width),
      height: Math.min(guest.height / ratio, view.height),
    }
  }
  return {
    width: Math.min(view.width, MAX_DRAW.width / ratio),
    height: Math.min(view.height, MAX_DRAW.height / ratio),
  }
}

export function scaleFor(dpr: number): number {
  const want = (Number.isFinite(dpr) && dpr > 0 ? dpr : 1) * 100
  let best: number = SCALES[0]
  for (const s of SCALES)
    if (Math.abs(s - want) < Math.abs(best - want)) best = s
  return best
}

export function parseSize(s: string): Size | null {
  const m = /^(\d{1,5})x(\d{1,5})$/.exec(s.trim().toLowerCase())
  if (m === null) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

export const sameSize = (a: Size | null, b: Size | null): boolean =>
  a !== null && b !== null && a.width === b.width && a.height === b.height

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(t: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => {
    clearTimeout(t as ReturnType<typeof setTimeout>)
  },
}

export class SizeDebouncer {
  private pending: Size | null = null
  private last: Size | null = null
  private timer: unknown = null
  private readonly send: (s: Size) => void
  private readonly delayMs: number
  private readonly timers: Timers
  constructor(
    send: (s: Size) => void,
    delayMs = 300,
    timers: Timers = realTimers,
  ) {
    this.send = send
    this.delayMs = delayMs
    this.timers = timers
  }

  push(s: Size): void {
    this.pending = s
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = this.timers.set(() => {
      this.flush()
    }, this.delayMs)
  }

  flush(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
    const s = this.pending
    this.pending = null
    if (s === null || sameSize(s, this.last)) return
    this.last = s
    this.send(s)
  }

  reset(): void {
    this.last = null
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
    this.pending = null
  }
}
