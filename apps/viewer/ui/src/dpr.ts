import { useSyncExternalStore } from "react"

/**
 * The device pixel ratio of the display the window is on NOW: 1 on a standard display, 2 on
 * Retina, 1.5 on a scaled one. It is not constant for the life of a window: moving it to a
 * display of another ratio changes it with no resize event (and none with the same size).
 * Anything computed from it must be recomputed on `watchPixelRatio`, or read through
 * `usePixelRatio`, never captured once.
 */
export const pixelRatio = (): number => (typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1)

type Listener = (ratio: number) => void

const listeners = new Set<Listener>()
let media: MediaQueryList | null = null

/** A `resolution` query for exactly today's ratio stops matching the moment the ratio changes: that is the event. */
function arm(): void {
  media?.removeEventListener("change", onChange)
  media = window.matchMedia(`(resolution: ${String(pixelRatio())}dppx)`)
  media.addEventListener("change", onChange)
}

function onChange(): void {
  // The query for the old ratio is spent; watch for the next change from the new one.
  arm()
  const ratio = pixelRatio()
  for (const l of [...listeners]) l(ratio)
}

/**
 * Calls `onChange` with the new ratio when the window moves to a display with another one (or
 * the page zoom changes it). One media query serves every watcher. Returns the way to stop.
 */
export function watchPixelRatio(listener: Listener): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined
  if (listeners.size === 0) arm()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      media?.removeEventListener("change", onChange)
      media = null
    }
  }
}

/** The device pixel ratio, re-read (and the component rendered again) when it changes. */
export function usePixelRatio(): number {
  return useSyncExternalStore((notify) => watchPixelRatio(notify), pixelRatio, () => 1)
}
