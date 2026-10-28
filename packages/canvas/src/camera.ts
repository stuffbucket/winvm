/**
 * The canvas camera: where the world sits on the screen, and how big.
 *
 * A camera `{ x, y, zoom }` maps a world point to the viewport as
 * `screen = world * zoom + (x, y)`, in CSS pixels from the viewport's top
 * left. The scene layer applies exactly that transform (SpatialCanvasScene).
 *
 * From monimal's `packages/maximal-project-browser/src/view.ts` (Camera,
 * Point, clampZoom, wheelZoomFactor, screenToWorld, editableTarget,
 * useRafCamera). Added here: zooming about a point, fitting and clamping,
 * the visible world rectangle, and eased camera flights.
 */
import { useCallback, useEffect, useRef, useState } from "react"

export interface Camera {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Rect extends Point, Size {}

export interface ZoomLimits {
  readonly min: number
  readonly max: number
}

export const INITIAL_CAMERA: Camera = { x: 340, y: 100, zoom: 1 }

/** monimal's limits: a tenth to four times. */
export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { min: 0.1, max: 4 }

const WHEEL_ZOOM_RATE = 0.0014

export function clampZoom(value: number, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): number {
  return Math.min(limits.max, Math.max(limits.min, value))
}

/** A wheel or pinch delta as a zoom factor: smooth for trackpads, a notch at a time for wheels. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * WHEEL_ZOOM_RATE)
}

/** A client point (e.g. a pointer event's) in world coordinates; `bounds` is the viewport's client rect. */
export function screenToWorld(point: Point, camera: Camera, bounds: { readonly left: number; readonly top: number }): Point {
  return {
    x: (point.x - bounds.left - camera.x) / camera.zoom,
    y: (point.y - bounds.top - camera.y) / camera.zoom,
  }
}

/** A world point in viewport coordinates. */
export function worldToScreen(point: Point, camera: Camera): Point {
  return { x: point.x * camera.zoom + camera.x, y: point.y * camera.zoom + camera.y }
}

/** Whether a key event belongs to a text field rather than the canvas. */
export function editableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/** Zoom by `factor`, keeping the world point under `anchor` (viewport coordinates) where it is. */
export function zoomAround(camera: Camera, factor: number, anchor: Point, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): Camera {
  const zoom = clampZoom(camera.zoom * factor, limits)
  const wx = (anchor.x - camera.x) / camera.zoom
  const wy = (anchor.y - camera.y) / camera.zoom
  return { zoom, x: anchor.x - wx * zoom, y: anchor.y - wy * zoom }
}

/** The camera that shows `rect` whole and centred, `padding` CSS pixels clear of every edge. */
export function fitRect(rect: Rect, viewport: Size, padding = 0, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): Camera {
  const w = Math.max(1, viewport.width - padding * 2)
  const h = Math.max(1, viewport.height - padding * 2)
  const zoom = clampZoom(Math.min(w / Math.max(1, rect.width), h / Math.max(1, rect.height)), limits)
  return centreOn({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, zoom, viewport)
}

/** The camera at `zoom` with world point `centre` in the middle of the viewport. */
export function centreOn(centre: Point, zoom: number, viewport: Size): Camera {
  return { zoom, x: viewport.width / 2 - centre.x * zoom, y: viewport.height / 2 - centre.y * zoom }
}

/** The world point in the middle of the viewport. */
export function centreOf(camera: Camera, viewport: Size): Point {
  return { x: (viewport.width / 2 - camera.x) / camera.zoom, y: (viewport.height / 2 - camera.y) / camera.zoom }
}

/**
 * The camera that lays world rectangle `world` exactly over viewport
 * rectangle `screen` (by width; give them the same aspect). This is how a
 * card and the thing it stands for change places: fly to it, and the card is
 * where the real one is.
 */
export function cameraForScreenRect(world: Rect, screen: Rect): Camera {
  const zoom = screen.width / Math.max(1, world.width)
  return { zoom, x: screen.x - world.x * zoom, y: screen.y - world.y * zoom }
}

/**
 * Keep the content in reach: never pan so far that it leaves the viewport.
 * When the content is larger than the viewport, the viewport stays within
 * the content plus `margin`; when it is smaller, the content stays within
 * the viewport less `margin`.
 */
export function clampPan(camera: Camera, content: Rect, viewport: Size, margin = 0): Camera {
  const axis = (pos: number, start: number, length: number, view: number): number => {
    const a = view - margin - (start + length) * camera.zoom
    const b = margin - start * camera.zoom
    return Math.min(Math.max(a, b), Math.max(Math.min(a, b), pos))
  }
  return {
    zoom: camera.zoom,
    x: axis(camera.x, content.x, content.width, viewport.width),
    y: axis(camera.y, content.y, content.height, viewport.height),
  }
}

/** Zoom within `limits`, then pan within reach of `content`. */
export function clampCamera(camera: Camera, content: Rect, viewport: Size, margin = 0, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): Camera {
  const zoom = clampZoom(camera.zoom, limits)
  const scaled = zoom === camera.zoom ? camera : zoomAround(camera, zoom / camera.zoom, { x: viewport.width / 2, y: viewport.height / 2 }, limits)
  return clampPan(scaled, content, viewport, margin)
}

/** The world rectangle the viewport shows, grown by `overscan` CSS pixels each side. */
export function visibleWorld(camera: Camera, viewport: Size, overscan = 0): Rect {
  return {
    x: (-camera.x - overscan) / camera.zoom,
    y: (-camera.y - overscan) / camera.zoom,
    width: (viewport.width + overscan * 2) / camera.zoom,
    height: (viewport.height + overscan * 2) / camera.zoom,
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Slow out, fast through the middle, slow in: every camera move. */
export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2
}

/**
 * A camera part way (`t`, 0 to 1, already eased) from `from` to `to`.
 *
 * The zoom moves evenly in log space, so a 4x zoom feels the same as a
 * quarter one. The centre moves with the scale, not with time: in step with
 * 1/zoom, so a flight that zooms in crosses most of the distance while it is
 * still zoomed out (little moves on screen), then closes in, and one that
 * zooms out leaves first and travels once wide.
 */
export function interpolateCamera(from: Camera, to: Camera, t: number, viewport: Size): Camera {
  if (t <= 0) return from
  if (t >= 1) return to
  const z0 = Math.log(from.zoom)
  const z1 = Math.log(to.zoom)
  const zoom = Math.exp(z0 + (z1 - z0) * t)
  const c0 = centreOf(from, viewport)
  const c1 = centreOf(to, viewport)
  const w0 = 1 / from.zoom
  const w1 = 1 / to.zoom
  const s = Math.abs(z1 - z0) < 0.05 ? t : (1 / zoom - w0) / (w1 - w0)
  return centreOn({ x: c0.x + (c1.x - c0.x) * s, y: c0.y + (c1.y - c0.y) * s }, zoom, viewport)
}

/** How long a flight takes: longer for a bigger change of view, within bounds. */
export function flightDuration(from: Camera, to: Camera, viewport: Size, base = 420, max = 900): number {
  const zoomChange = Math.abs(Math.log(to.zoom / from.zoom))
  const c0 = centreOf(from, viewport)
  const c1 = centreOf(to, viewport)
  const screens = Math.hypot((c1.x - c0.x) * Math.min(from.zoom, to.zoom), (c1.y - c0.y) * Math.min(from.zoom, to.zoom)) / Math.max(1, Math.hypot(viewport.width, viewport.height))
  return Math.round(Math.min(max, base + 160 * zoomChange + 220 * Math.min(1.5, screens)))
}

/**
 * monimal's camera state: updates coalesce to one React render per animation
 * frame, however many pointer or wheel events arrive in it.
 */
export function useRafCamera(initial: Camera): [Camera, (next: Camera) => void] {
  const [camera, setCamera] = useState(initial)
  const pending = useRef<Camera | undefined>(undefined)
  const frame = useRef<number | undefined>(undefined)

  const schedule = useCallback((next: Camera) => {
    pending.current = next
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      if (pending.current) setCamera(pending.current)
    })
  }, [])

  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    },
    [],
  )

  return [camera, schedule]
}

export interface FlyOptions {
  /** Milliseconds; by default from flightDuration. */
  readonly duration?: number
  readonly easing?: (t: number) => number
}

export interface CanvasCamera {
  /** What is drawn now. */
  readonly camera: Camera
  /** The latest camera asked for, drawn or not: where the next move starts from. */
  current(): Camera
  /** Jump (coalesced to the next frame); stops a flight. */
  set(next: Camera): void
  /** Ease to `to`; resolves true when it arrives, false when something else moved the camera first. */
  fly(to: Camera, options?: FlyOptions): Promise<boolean>
  /** Stop a flight where it is. */
  stop(): void
}

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * useRafCamera plus flights. Every move eases in and out unless the person
 * asked for reduced motion, which jumps (docs/design/motion.md: honoured
 * literally). `viewport` reports the viewport's size when a flight starts.
 */
export function useCanvasCamera(initial: Camera, viewport: () => Size): CanvasCamera {
  const [camera, schedule] = useRafCamera(initial)
  const latest = useRef(initial)
  const flight = useRef<{ frame: number; done: (arrived: boolean) => void } | null>(null)
  const size = useRef(viewport)
  size.current = viewport

  const stop = useCallback(() => {
    const f = flight.current
    if (f === null) return
    flight.current = null
    cancelAnimationFrame(f.frame)
    f.done(false)
  }, [])

  const set = useCallback(
    (next: Camera) => {
      stop()
      latest.current = next
      schedule(next)
    },
    [schedule, stop],
  )

  const fly = useCallback(
    (to: Camera, options: FlyOptions = {}): Promise<boolean> => {
      stop()
      const from = latest.current
      const view = size.current()
      const duration = options.duration ?? flightDuration(from, to, view)
      if (prefersReducedMotion() || duration <= 0) {
        latest.current = to
        schedule(to)
        return Promise.resolve(true)
      }
      const easing = options.easing ?? easeInOutCubic
      return new Promise<boolean>((resolve) => {
        const started = performance.now()
        const step = (now: number): void => {
          const t = Math.min(1, (now - started) / duration)
          const next = t >= 1 ? to : interpolateCamera(from, to, easing(t), view)
          latest.current = next
          schedule(next)
          if (t >= 1) {
            flight.current = null
            resolve(true)
            return
          }
          if (flight.current !== null) flight.current.frame = requestAnimationFrame(step)
        }
        flight.current = { frame: requestAnimationFrame(step), done: resolve }
      })
    },
    [schedule, stop],
  )

  useEffect(() => stop, [stop])

  const current = useCallback(() => latest.current, [])
  // The functions never change, so callers can depend on them without re-rendering on every frame.
  return { camera, current, set, fly, stop }
}
