import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"

interface PopoverProps {
  readonly anchor: HTMLElement | null
  readonly label: string
  readonly onClose: () => void
  readonly children: ReactNode
}

/**
 * A panel under a toolbar button: layer 2, short-lived. Escape or a click
 * outside it (other than on its button) closes it.
 */
export function Popover({ anchor, label, onClose, children }: PopoverProps): JSX.Element {
  const panel = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    const measure = (): void => {
      if (anchor === null) return
      const r = anchor.getBoundingClientRect()
      setPlace({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right - 8) })
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [anchor])

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    const down = (e: PointerEvent): void => {
      const t = e.target as Node
      if (panel.current?.contains(t) === true || anchor?.contains(t) === true) return
      onClose()
    }
    window.addEventListener("keydown", key)
    window.addEventListener("pointerdown", down)
    return () => {
      window.removeEventListener("keydown", key)
      window.removeEventListener("pointerdown", down)
    }
  }, [anchor, onClose])

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input, button, textarea")?.focus()
  }, [])

  return (
    <div
      ref={panel}
      className="popover"
      role="dialog"
      aria-label={label}
      style={place === null ? { visibility: "hidden" } : { top: place.top, right: place.right }}
    >
      {children}
    </div>
  )
}
