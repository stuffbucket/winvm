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

export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { min: 0.1, max: 4 }

const WHEEL_ZOOM_RATE = 0.0014

export function clampZoom(value: number, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): number {
  return Math.min(limits.max, Math.max(limits.min, value))
}

export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * WHEEL_ZOOM_RATE)
}

export function screenToWorld(point: Point, camera: Camera, bounds: { readonly left: number; readonly top: number }): Point {
  return {
    x: (point.x - bounds.left - camera.x) / camera.zoom,
    y: (point.y - bounds.top - camera.y) / camera.zoom,
  }
}

export function worldToScreen(point: Point, camera: Camera): Point {
  return { x: point.x * camera.zoom + camera.x, y: point.y * camera.zoom + camera.y }
}

export function editableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

export function zoomAround(camera: Camera, factor: number, anchor: Point, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): Camera {
  const zoom = clampZoom(camera.zoom * factor, limits)
  const wx = (anchor.x - camera.x) / camera.zoom
  const wy = (anchor.y - camera.y) / camera.zoom
  return { zoom, x: anchor.x - wx * zoom, y: anchor.y - wy * zoom }
}

export function fitRect(rect: Rect, viewport: Size, padding = 0, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): Camera {
  const w = Math.max(1, viewport.width - padding * 2)
  const h = Math.max(1, viewport.height - padding * 2)
  const zoom = clampZoom(Math.min(w / Math.max(1, rect.width), h / Math.max(1, rect.height)), limits)
  return centreOn({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, zoom, viewport)
}

export function centreOn(centre: Point, zoom: number, viewport: Size): Camera {
  return { zoom, x: viewport.width / 2 - centre.x * zoom, y: viewport.height / 2 - centre.y * zoom }
}

export function centreOf(camera: Camera, viewport: Size): Point {
  return { x: (viewport.width / 2 - camera.x) / camera.zoom, y: (viewport.height / 2 - camera.y) / camera.zoom }
}

export function cameraForScreenRect(world: Rect, screen: Rect): Camera {
  const zoom = screen.width / Math.max(1, world.width)
  return { zoom, x: screen.x - world.x * zoom, y: screen.y - world.y * zoom }
}

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

export function clampCamera(camera: Camera, content: Rect, viewport: Size, margin = 0, limits: ZoomLimits = DEFAULT_ZOOM_LIMITS): Camera {
  const zoom = clampZoom(camera.zoom, limits)
  const scaled = zoom === camera.zoom ? camera : zoomAround(camera, zoom / camera.zoom, { x: viewport.width / 2, y: viewport.height / 2 }, limits)
  return clampPan(scaled, content, viewport, margin)
}

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

export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2
}

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

export function flightDuration(from: Camera, to: Camera, viewport: Size, base = 420, max = 900): number {
  const zoomChange = Math.abs(Math.log(to.zoom / from.zoom))
  const c0 = centreOf(from, viewport)
  const c1 = centreOf(to, viewport)
  const screens = Math.hypot((c1.x - c0.x) * Math.min(from.zoom, to.zoom), (c1.y - c0.y) * Math.min(from.zoom, to.zoom)) / Math.max(1, Math.hypot(viewport.width, viewport.height))
  return Math.round(Math.min(max, base + 160 * zoomChange + 220 * Math.min(1.5, screens)))
}

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
  readonly duration?: number
  readonly easing?: (t: number) => number
}

export interface CanvasCamera {
  readonly camera: Camera
  current: () => Camera
  set: (next: Camera) => void
  fly: (to: Camera, options?: FlyOptions) => Promise<boolean>
  stop(): void
}

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

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
  return { camera, current, set, fly, stop }
}
