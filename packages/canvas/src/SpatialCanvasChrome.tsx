import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type JSX,
  type ReactNode,
} from "react"

export function CanvasGlyph({
  children,
  size = 16,
}: {
  readonly children: ReactNode
  readonly size?: number
}): JSX.Element {
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

export type CanvasButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "aria-label"
> & {
  readonly label: string
  readonly selected?: boolean
}

export const CanvasIconButton = forwardRef<
  HTMLButtonElement,
  CanvasButtonProps
>(function CanvasIconButton(
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
      className={[
        "spatial-canvas__button",
        "spatial-canvas__button--icon",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </button>
  )
})

export function SpatialCanvasTopBar({
  children,
}: {
  readonly children: ReactNode
}): JSX.Element {
  return <header className="spatial-canvas__topbar">{children}</header>
}

export function SpatialCanvasCorner({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}): JSX.Element {
  return (
    <div
      className={["spatial-canvas__corner", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  )
}

export function SpatialCanvasControlGroup({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <nav className="spatial-canvas__controls" aria-label={label}>
      {children}
    </nav>
  )
}

export function SpatialCanvasFloatingPanel({
  label,
  children,
  className,
}: {
  readonly label: string
  readonly children: ReactNode
  readonly className?: string
}): JSX.Element {
  return (
    <aside
      className={["spatial-canvas__floating-panel", className]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
    >
      {children}
    </aside>
  )
}

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
  readonly closeLabel: string
  onClose: () => void
  readonly children: ReactNode
  readonly footer?: ReactNode
  readonly header?: ReactNode
  readonly className?: string
}): JSX.Element {
  return (
    <aside
      className={["spatial-canvas__side-panel", className]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
    >
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
  readonly reset: string
}

export function SpatialCanvasZoomControls({
  zoom,
  labels,
  onZoomOut,
  onReset,
  onZoomIn,
}: {
  readonly zoom: number
  readonly labels: ZoomLabels
  onZoomOut: () => void
  onReset: () => void
  onZoomIn: () => void
}): JSX.Element {
  return (
    <div
      className="spatial-canvas__zoom"
      role="group"
      aria-label={labels.group}
    >
      <CanvasIconButton label={labels.zoomOut} onClick={onZoomOut}>
        <CanvasGlyph>{GLYPHS.minus}</CanvasGlyph>
      </CanvasIconButton>
      <button
        type="button"
        className="spatial-canvas__button spatial-canvas__zoom-value"
        title={labels.reset}
        onClick={onReset}
      >
        {Math.round(zoom * 100)}%
      </button>
      <CanvasIconButton label={labels.zoomIn} onClick={onZoomIn}>
        <CanvasGlyph>{GLYPHS.plus}</CanvasGlyph>
      </CanvasIconButton>
    </div>
  )
}
