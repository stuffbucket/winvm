import { describe, expect, it } from "bun:test"

import {
  cameraForScreenRect,
  centreOf,
  clampCamera,
  clampPan,
  clampZoom,
  easeInOutCubic,
  fitRect,
  flightDuration,
  interpolateCamera,
  rectsIntersect,
  screenToWorld,
  visibleWorld,
  wheelZoomFactor,
  worldToScreen,
  zoomAround,
} from "../src/camera"

const view = { width: 1000, height: 800 }
const close = (a: number, b: number, digits = 6): void => expect(a).toBeCloseTo(b, digits)

describe("camera maths", () => {
  it("round-trips screen and world points", () => {
    const camera = { x: 120, y: -40, zoom: 2.5 }
    const world = screenToWorld({ x: 620, y: 360 }, camera, { left: 100, top: 0 })
    const back = worldToScreen(world, camera)
    close(back.x, 520)
    close(back.y, 360)
  })

  it("clamps zoom to monimal's limits by default, or the given ones", () => {
    expect(clampZoom(20)).toBe(4)
    expect(clampZoom(0.01)).toBe(0.1)
    expect(clampZoom(0.01, { min: 0.05, max: 2 })).toBe(0.05)
  })

  it("zooms in on a notch of the wheel and out on the reverse", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
    close(wheelZoomFactor(100) * wheelZoomFactor(-100), 1)
  })

  it("keeps the world point under the anchor when zooming", () => {
    const camera = { x: 30, y: 50, zoom: 1 }
    const anchor = { x: 400, y: 300 }
    const before = screenToWorld(anchor, camera, { left: 0, top: 0 })
    const after = zoomAround(camera, 2, anchor)
    expect(after.zoom).toBe(2)
    const again = screenToWorld(anchor, after, { left: 0, top: 0 })
    close(again.x, before.x)
    close(again.y, before.y)
  })

  it("fits a rectangle in the middle, clear of the padding", () => {
    const camera = fitRect({ x: 100, y: 100, width: 400, height: 200 }, view, 100)
    close(camera.zoom, 2) // (1000 - 200) / 400 wins over (800 - 200) / 200
    const centre = centreOf(camera, view)
    close(centre.x, 300)
    close(centre.y, 200)
  })

  it("lays a world rectangle exactly over a screen rectangle", () => {
    const camera = cameraForScreenRect({ x: 10, y: 20, width: 320, height: 200 }, { x: 100, y: 60, width: 800, height: 500 })
    close(camera.zoom, 2.5)
    const topLeft = worldToScreen({ x: 10, y: 20 }, camera)
    close(topLeft.x, 100)
    close(topLeft.y, 60)
  })

  it("never pans the content out of reach", () => {
    const content = { x: 0, y: 0, width: 4000, height: 3000 }
    // Far past the right edge: the content's right side comes back to the margin.
    const right = clampPan({ x: -10_000, y: 0, zoom: 1 }, content, view, 80)
    close(right.x, view.width - 80 - 4000)
    // Far past the left: its left side stops at the margin.
    const left = clampPan({ x: 5000, y: 0, zoom: 1 }, content, view, 80)
    close(left.x, 80)
    // Small content stays inside the viewport, wherever it was dragged.
    const small = { x: 0, y: 0, width: 100, height: 100 }
    const lost = clampPan({ x: -900, y: 2000, zoom: 1 }, small, view, 20)
    close(lost.x, 20)
    close(lost.y, view.height - 20 - 100)
    // Within reach it is left alone.
    expect(clampPan({ x: 300, y: 200, zoom: 1 }, small, view, 20)).toEqual({ x: 300, y: 200, zoom: 1 })
  })

  it("clamps zoom about the middle of the view, then pans back within reach", () => {
    const content = { x: 0, y: 0, width: 1000, height: 800 }
    const camera = clampCamera({ x: 0, y: 0, zoom: 10 }, content, view, 0, { min: 0.2, max: 2 })
    expect(camera.zoom).toBe(2)
    const centre = centreOf(camera, view)
    // The middle (50, 40) at 2x would show past the content's top left, so it pans back.
    close(centre.x, 250)
    close(centre.y, 200)
  })

  it("reports the world the viewport shows, with overscan", () => {
    const camera = { x: -200, y: -100, zoom: 2 }
    expect(visibleWorld(camera, view)).toEqual({ x: 100, y: 50, width: 500, height: 400 })
    expect(visibleWorld(camera, view, 100)).toEqual({ x: 50, y: 0, width: 600, height: 500 })
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBe(false)
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 })).toBe(true)
  })
})

describe("flights", () => {
  it("eases in and out", () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBe(0.5)
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1)
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9)
    expect(easeInOutCubic(-1)).toBe(0)
    expect(easeInOutCubic(2)).toBe(1)
  })

  it("starts and ends exactly where asked", () => {
    const a = { x: 10, y: 20, zoom: 0.5 }
    const b = { x: -300, y: 40, zoom: 3 }
    expect(interpolateCamera(a, b, 0, view)).toEqual(a)
    expect(interpolateCamera(a, b, 1, view)).toEqual(b)
  })

  it("moves the zoom evenly in log space", () => {
    const mid = interpolateCamera({ x: 0, y: 0, zoom: 0.5 }, { x: 0, y: 0, zoom: 2 }, 0.5, view)
    close(mid.zoom, 1)
  })

  it("crosses the distance early when zooming in, late when zooming out", () => {
    const wide = fitRect({ x: 0, y: 0, width: 4000, height: 3000 }, view)
    const near = fitRect({ x: 3500, y: 2500, width: 400, height: 300 }, view)
    const travelled = (t: number, from = wide, to = near): number => {
      const c0 = centreOf(from, view)
      const c1 = centreOf(to, view)
      const c = centreOf(interpolateCamera(from, to, t, view), view)
      return Math.hypot(c.x - c0.x, c.y - c0.y) / Math.hypot(c1.x - c0.x, c1.y - c0.y)
    }
    expect(travelled(0.3)).toBeGreaterThan(0.5)
    expect(travelled(0.3, near, wide)).toBeLessThan(0.2)
  })

  it("pans in step with time when the zoom stays", () => {
    const a = { x: 0, y: 0, zoom: 1 }
    const b = { x: -1000, y: 0, zoom: 1 }
    close(interpolateCamera(a, b, 0.25, view).x, -250)
  })

  it("takes longer for bigger moves, within bounds", () => {
    const a = { x: 0, y: 0, zoom: 1 }
    const small = flightDuration(a, { x: -50, y: 0, zoom: 1 }, view)
    const big = flightDuration(a, { x: -5000, y: 0, zoom: 0.2 }, view)
    expect(small).toBeGreaterThanOrEqual(420)
    expect(big).toBeGreaterThan(small)
    expect(big).toBeLessThanOrEqual(900)
  })
})
