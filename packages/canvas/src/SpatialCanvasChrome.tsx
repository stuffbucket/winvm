/**
 * The controls that float over a canvas, from monimal's
 * `spatial-canvas-chrome.tsx`: the top bar and its corners, a control group,
 * a floating panel, a side panel and the zoom controls.
 *
 * Changed here: icons are inline Lucide paths (monimal imports lucide-react),
 * every word comes in as a prop so the app's catalog supplies it, and the
 * buttons are the canvas's own (`spatial-canvas__button`), not monimal's
 * design-system IconButton. Left out: monimal's page tabs and project
 * switcher, presence avatars and tool buttons (its whiteboard's tools).
 */
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react"

/** A 16 px Lucide glyph, stroked in the current color. */
export function CanvasGlyph({ children, size = 16 }: { readonly children: ReactNode; readonly size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

// lucide: minus, plus, x, search
export const GLYPHS = {
  minus: <path d="M5 12h14" />,
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
} as const

export type CanvasButtonProps = Omit<ComponentPropsWithoutRef<"button">, "aria-label"> & {
  /** The accessible name, and the tooltip. */
  readonly label: string
  readonly selected?: boolean
}

/** A compact icon button for canvas chrome. */
export const CanvasIconButton = forwardRef<HTMLButtonElement, CanvasButtonProps>(function CanvasIconButton(
  { label, selected, className, children, type = "button", ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      aria-pressed={selected}
      className={["spatial-canvas__button", "spatial-canvas__button--icon", className].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  )
})

/** Positions the canvas's primary actions across the top edge. */
export function SpatialCanvasTopBar({ children }: { readonly children: ReactNode }): JSX.Element {
  return <header className="spatial-canvas__topbar">{children}</header>
}

/** Groups controls within a top bar corner. */
export function SpatialCanvasCorner({ children, className }: { readonly children: ReactNode; readonly className?: string }): JSX.Element {
  return <div className={["spatial-canvas__corner", className].filter(Boolean).join(" ")}>{children}</div>
}

/** A labelled group of controls, centred on the bottom edge. */
export function SpatialCanvasControlGroup({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element {
  return (
    <nav className="spatial-canvas__controls" aria-label={label}>
      {children}
    </nav>
  )
}

/** A compact floating inspector over the canvas. */
export function SpatialCanvasFloatingPanel({ label, children, className }: { readonly label: string; readonly children: ReactNode; readonly className?: string }): JSX.Element {
  return (
    <aside className={["spatial-canvas__floating-panel", className].filter(Boolean).join(" ")} aria-label={label}>
      {children}
    </aside>
  )
}

/** A dismissible panel along the canvas's right edge. */
export function SpatialCanvasSidePanel({
  label,
  title,
  closeLabel,
  onClose,
  children,
  footer,
  header,
  className,
}: {
  readonly label: string
  readonly title: string
  /** "Close <title>", in the app's words. */
  readonly closeLabel: string
  onClose(): void
  readonly children: ReactNode
  readonly footer?: ReactNode
  readonly header?: ReactNode
  readonly className?: string
}): JSX.Element {
  return (
    <aside className={["spatial-canvas__side-panel", className].filter(Boolean).join(" ")} aria-label={label}>
      <header>
        {header ?? <strong>{title}</strong>}
        <CanvasIconButton label={closeLabel} onClick={onClose}>
          <CanvasGlyph>{GLYPHS.close}</CanvasGlyph>
        </CanvasIconButton>
      </header>
      <div className="spatial-canvas__side-panel-body">{children}</div>
      {footer}
    </aside>
  )
}

export interface ZoomLabels {
  readonly group: string
  readonly zoomOut: string
  readonly zoomIn: string
  /** The reset button's tooltip; its face is the zoom as a percentage. */
  readonly reset: string
}

/** Zoom out, the zoom (resets), zoom in. */
export function SpatialCanvasZoomControls({
  zoom,
  labels,
  onZoomOut,
  onReset,
  onZoomIn,
}: {
  readonly zoom: number
  readonly labels: ZoomLabels
  onZoomOut(): void
  onReset(): void
  onZoomIn(): void
}): JSX.Element {
  return (
    <div className="spatial-canvas__zoom" role="group" aria-label={labels.group}>
      <CanvasIconButton label={labels.zoomOut} onClick={onZoomOut}>
        <CanvasGlyph>{GLYPHS.minus}</CanvasGlyph>
      </CanvasIconButton>
      <button type="button" className="spatial-canvas__button spatial-canvas__zoom-value" title={labels.reset} onClick={onReset}>
        {Math.round(zoom * 100)}%
      </button>
      <CanvasIconButton label={labels.zoomIn} onClick={onZoomIn}>
        <CanvasGlyph>{GLYPHS.plus}</CanvasGlyph>
      </CanvasIconButton>
    </div>
  )
}
