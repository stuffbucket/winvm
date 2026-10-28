/**
 * Hosts a canvas edge to edge over the window, from monimal's
 * `spatial-canvas-surface.tsx`. monimal's version wraps its design system's
 * Dialog; here it is a portal of its own, so the app decides what Escape
 * means (step back out of a selection or a search before leaving), and so the
 * surface can ease in and out: `phase` drives the CSS.
 */
import { type ComponentPropsWithoutRef, type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react"
import { createPortal } from "react-dom"

export type SpatialCanvasSurfacePhase = "entering" | "open" | "leaving"

export interface SpatialCanvasSurfaceProps extends Omit<ComponentPropsWithoutRef<"section">, "title" | "children"> {
  readonly open: boolean
  readonly title: string
  readonly description: string
  readonly children: ReactNode
  /** In the page's flow, not over the window (tests, previews). */
  readonly embedded?: boolean
  readonly phase?: SpatialCanvasSurfacePhase
  /** Where the portal goes; document.body by default. */
  readonly container?: Element | null
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keeps Tab inside the surface, as a modal does. */
function trapTab(event: KeyboardEvent<HTMLElement>): void {
  // A modal <dialog> inside keeps Tab to itself.
  if (event.key !== "Tab" || (event.target instanceof Element && event.target.closest("dialog") !== null)) return
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
  const first = items[0]
  const last = items.at(-1)
  if (first === undefined || last === undefined) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

export function SpatialCanvasSurface({
  open,
  title,
  description,
  children,
  embedded = false,
  phase = "open",
  container,
  className,
  onKeyDown,
  ...props
}: SpatialCanvasSurfaceProps): JSX.Element | null {
  const describedBy = useId()
  const ref = useRef<HTMLElement>(null)
  const returnTo = useRef<Element | null>(null)

  // Focus comes in with the surface and goes back where it was after.
  useEffect(() => {
    if (!open || embedded) return
    returnTo.current = document.activeElement
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true })
    return () => {
      const back = returnTo.current
      if (back instanceof HTMLElement) back.focus({ preventScroll: true })
    }
  }, [open, embedded])

  if (!open) return null
  const section = (
    <section
      {...props}
      ref={ref}
      role={embedded ? "region" : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-label={title}
      aria-describedby={describedBy}
      tabIndex={-1}
      data-phase={phase}
      className={["spatial-canvas-surface", embedded && "spatial-canvas-surface--embedded", className].filter(Boolean).join(" ")}
      onKeyDown={(event) => {
        if (!embedded) trapTab(event)
        onKeyDown?.(event)
      }}
    >
      <span id={describedBy} className="spatial-canvas__sr-only">
        {description}
      </span>
      {children}
    </section>
  )
  if (embedded) return section
  const target = container ?? (typeof document === "undefined" ? null : document.body)
  return target === null ? section : createPortal(section, target)
}
