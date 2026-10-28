/**
 * The size a resizable guest screen (virtio-gpu) should be for a window, and
 * the limits that size must stay inside. Pure arithmetic, no Node or Bun
 * imports: the app's UI bundles this same file.
 *
 * ## Where the limits come from (measured on win11-arm64, QEMU 11.1.2)
 *
 * - FRAMEBUFFER: the guest's viogpudo driver (UTM's build, 22.7.38.43) cannot
 *   back a framebuffer above 30 MiB. Exactly 30 MiB works (3840x2048,
 *   4096x1920); 3840x2050 and anything larger is ACCEPTED by Windows
 *   (ChangeDisplaySettingsEx returns 0) but the driver never attaches memory
 *   to the new resource and QEMU shows "Display output is not active". A save
 *   taken in that state restores to a dead screen. Booting with a larger
 *   xres/yres does not raise the ceiling.
 * - VNC: QEMU's VNC server clamps to 5120x2160 (ui/vnc.h VNC_MAX_WIDTH /
 *   VNC_MAX_HEIGHT); anything larger is cropped for every viewer.
 * - MINIMUM: the driver's fixed modes start at 1024x768, and Windows needs
 *   about that much room at 100%.
 * - WIDTH A MULTIPLE OF 16: QEMU's VNC server pads other widths up to one (1500
 *   shows as 1504 in ServerInit, 3336 as 3344; VNC_DIRTY_PIXELS_PER_BIT), and
 *   display drivers prefer aligned pitches. At most 15 device pixels go unused.
 */

export const MAX_FRAMEBUFFER_BYTES = 30 * 1024 * 1024
export const BYTES_PER_PIXEL = 4
export const MAX_WIDTH = 5120
export const MAX_HEIGHT = 2160
export const MIN_WIDTH = 1024
export const MIN_HEIGHT = 768
export const WIDTH_STEP = 16

/** The display scales Windows offers, in percent, in the order its DPI steps go. */
export const SCALES = [100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500] as const

export interface Size {
  readonly width: number
  readonly height: number
}

const floorTo = (n: number, step: number): number => Math.floor(n / step) * step

const fits = (s: Size): boolean =>
  s.width <= MAX_WIDTH && s.height <= MAX_HEIGHT && s.width * s.height * BYTES_PER_PIXEL <= MAX_FRAMEBUFFER_BYTES

/**
 * The nearest size inside the limits: a size that already fits only has its
 * width rounded down to a multiple of 16; a bigger one shrinks keeping its
 * shape; a smaller one is raised to the minimum on each side.
 */
export function clampSize(want: Size): Size {
  let w = Math.max(Math.floor(want.width), 1)
  let h = Math.max(Math.floor(want.height), 1)
  if (!fits({ width: w, height: h })) {
    const k = Math.min(1, MAX_WIDTH / w, MAX_HEIGHT / h, Math.sqrt(MAX_FRAMEBUFFER_BYTES / BYTES_PER_PIXEL / (w * h)))
    w = Math.floor(w * k)
    h = Math.floor(h * k)
  }
  w = Math.max(MIN_WIDTH, floorTo(w, WIDTH_STEP))
  h = Math.max(MIN_HEIGHT, h)
  // Raising one side to its minimum can push the other past the byte limit.
  while (!fits({ width: w, height: h }) && h > MIN_HEIGHT) h -= 1
  while (!fits({ width: w, height: h }) && w > MIN_WIDTH) w -= WIDTH_STEP
  return { width: w, height: h }
}

/**
 * The guest size for a view of `css` CSS pixels at `dpr` device pixels per CSS
 * pixel: one guest pixel per device pixel, inside the limits.
 */
export function guestSizeFor(css: Size, dpr: number): Size {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return clampSize({ width: Math.floor(css.width * ratio), height: Math.floor(css.height * ratio) })
}

/** The most device pixels the screen is drawn at, scaled up or not: 5K. */
export const MAX_DRAW = { width: 5120, height: 2880 } as const

/**
 * The CSS size to draw a `guest` framebuffer at in a `view` of CSS pixels.
 * While the guest can match the view it is drawn one guest pixel per device
 * pixel, never larger than the view. Past the limits the guest stays at its
 * cap and is scaled up to fill the view, up to 5K device pixels.
 */
export function drawSize(guest: Size, view: Size, dpr: number): Size {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const raw = { width: Math.floor(view.width * ratio), height: Math.floor(view.height * ratio) }
  if (fits(raw)) {
    return { width: Math.min(guest.width / ratio, view.width), height: Math.min(guest.height / ratio, view.height) }
  }
  return { width: Math.min(view.width, MAX_DRAW.width / ratio), height: Math.min(view.height, MAX_DRAW.height / ratio) }
}

/** The Windows scale for a device pixel ratio: DPR x 100%, the nearest step Windows offers. */
export function scaleFor(dpr: number): number {
  const want = (Number.isFinite(dpr) && dpr > 0 ? dpr : 1) * 100
  let best: number = SCALES[0]
  for (const s of SCALES) if (Math.abs(s - want) < Math.abs(best - want)) best = s
  return best
}

/** "1920x1080" -> {1920, 1080}; null for anything else. */
export function parseSize(s: string): Size | null {
  const m = /^(\d{1,5})x(\d{1,5})$/.exec(s.trim().toLowerCase())
  if (m === null) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

export const sameSize = (a: Size | null, b: Size | null): boolean =>
  a !== null && b !== null && a.width === b.width && a.height === b.height

/**
 * Trailing debounce for a stream of sizes: `push` restarts the timer, `flush`
 * sends now (the end of a live resize). `send` gets only the latest size, and
 * never the same size twice in a row. Timers are injectable for tests.
 */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(t: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

export class SizeDebouncer {
  private pending: Size | null = null
  private last: Size | null = null
  private timer: unknown = null
  private readonly send: (s: Size) => void
  private readonly delayMs: number
  private readonly timers: Timers
  constructor(send: (s: Size) => void, delayMs = 300, timers: Timers = realTimers) {
    this.send = send
    this.delayMs = delayMs
    this.timers = timers
  }

  push(s: Size): void {
    this.pending = s
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = this.timers.set(() => this.flush(), this.delayMs)
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

  /** Forget what was sent, so the next size goes out even if unchanged (after a reconnect or a load). */
  reset(): void {
    this.last = null
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
    this.pending = null
  }
}
