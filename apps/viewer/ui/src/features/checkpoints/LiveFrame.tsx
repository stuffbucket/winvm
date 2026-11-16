import { type JSX, useEffect, useRef } from "react"

const INTERVAL_MS = 125
const MAX_WIDTH = 1280

export function LiveFrame({
  source,
  className,
  interval = INTERVAL_MS,
  maxWidth = MAX_WIDTH,
}: {
  source: () => HTMLCanvasElement | null
  readonly className?: string
  readonly interval?: number
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
          target.dataset.live = "true"
        } catch {}
      }
      timer = setTimeout(copy, interval)
    }
    copy()
    return () => {
      if (timer !== null) clearTimeout(timer)
    }
  }, [interval, maxWidth])

  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabIndex is not focusable; this one only shows a copied frame
    <canvas
      ref={ref}
      className={className}
      aria-hidden="true"
      width={0}
      height={0}
    />
  )
}
