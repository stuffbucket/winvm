import { useEffect, useRef } from "react"

/** A few times a second: enough to read as live without costing the guest's screen anything noticeable. */
const INTERVAL_MS = 125
/** Sharp enough for the largest the Now card is drawn before the view hands back to the real screen. */
const MAX_WIDTH = 1280

/**
 * The live screen, copied into the Now card: noVNC draws Windows' screen on
 * its canvas under the view, and this copies that canvas a few times a second
 * while the view is open. When there is nothing to copy it shows nothing, and
 * the card's own placeholder shows through.
 */
export function LiveFrame({
  source,
  className,
  interval = INTERVAL_MS,
  maxWidth = MAX_WIDTH,
}: {
  source(): HTMLCanvasElement | null
  readonly className?: string
  /** How often to copy, in ms. */
  readonly interval?: number
  /** The widest copy kept, in pixels. */
  readonly maxWidth?: number
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const from = useRef(source)
  from.current = source

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const copy = (): void => {
      const target = ref.current
      const src = from.current()
      if (target !== null && src !== null && src.width > 0 && src.height > 0) {
        const scale = Math.min(1, maxWidth / src.width)
        const w = Math.round(src.width * scale)
        const h = Math.round(src.height * scale)
        if (target.width !== w || target.height !== h) {
          target.width = w
          target.height = h
        }
        try {
          target.getContext("2d")?.drawImage(src, 0, 0, w, h)
          target.dataset["live"] = "true"
        } catch {
          // a canvas that can't be read (or a test DOM): keep the placeholder
        }
      }
      timer = setTimeout(copy, interval)
    }
    copy()
    return () => {
      if (timer !== null) clearTimeout(timer)
    }
  }, [interval, maxWidth])

  return <canvas ref={ref} className={className} aria-hidden="true" width={0} height={0} />
}
