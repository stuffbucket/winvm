import { useSyncExternalStore } from "react"

export const pixelRatio = (): number =>
  typeof window !== "undefined" && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1

type Listener = (ratio: number) => void

const listeners = new Set<Listener>()
let media: MediaQueryList | null = null

function arm(): void {
  media?.removeEventListener("change", onChange)
  media = window.matchMedia(`(resolution: ${String(pixelRatio())}dppx)`)
  media.addEventListener("change", onChange)
}

function onChange(): void {
  arm()
  const ratio = pixelRatio()
  for (const l of [...listeners]) l(ratio)
}

export function watchPixelRatio(listener: Listener): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => undefined
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

export function usePixelRatio(): number {
  return useSyncExternalStore(
    (notify) => watchPixelRatio(notify),
    pixelRatio,
    () => 1,
  )
}
