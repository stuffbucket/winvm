import { forwardRef, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode, type JSX } from "react"

import type { Camera, Point, Rect } from "./camera"

function positionStyle({ x, y }: Point): CSSProperties {
  return { transform: `translate3d(${String(x)}px, ${String(y)}px, 0)` }
}

function sizedStyle({ x, y, width, height }: Rect): CSSProperties {
  return { ...positionStyle({ x, y }), width, height }
}

const join = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ")

export interface SpatialCanvasProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  readonly children: ReactNode
}

export function SpatialCanvas({ children, className, ...props }: SpatialCanvasProps): JSX.Element {
  return (
    <div {...props} className={join("spatial-canvas", className)}>
      {children}
    </div>
  )
}

export function gridStyle({ x, y, zoom }: Camera): CSSProperties {
  const spacing = 16 + 4 * Math.tanh(Math.log(Math.max(zoom, Number.EPSILON)) * 0.35)
  const offset = (translation: number): number => ((translation % spacing) + spacing) % spacing
  return {
    backgroundPosition: `${String(offset(x))}px ${String(offset(y))}px`,
    backgroundSize: `${String(spacing)}px ${String(spacing)}px`,
  }
}

export type SpatialCanvasViewportProps = ComponentPropsWithoutRef<"div"> & {
  readonly tool?: string
  readonly camera?: Camera
  readonly gridCamera?: Camera
  readonly plain?: boolean
}

export const SpatialCanvasViewport = forwardRef<HTMLDivElement, SpatialCanvasViewportProps>(function SpatialCanvasViewport(
  { tool = "select", camera = { x: 0, y: 0, zoom: 1 }, gridCamera, plain = false, className, children, ...props },
  ref,
) {
  return (
    <div {...props} ref={ref} className={join("spatial-canvas__viewport", className)} data-tool={tool}>
      {!plain && <span className="spatial-canvas__grid" style={gridStyle(gridCamera ?? camera)} aria-hidden="true" />}
      {children}
    </div>
  )
})

export function SpatialCanvasScene({ x, y, zoom, children }: Camera & { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="spatial-canvas__scene" style={{ transform: `translate3d(${String(x)}px, ${String(y)}px, 0) scale(${String(zoom)})` }}>
      {children}
    </div>
  )
}

export type SpatialCanvasNodeProps = Rect &
  Omit<ComponentPropsWithoutRef<"div">, "style"> & {
    readonly selected?: boolean
    readonly children: ReactNode
  }

export function SpatialCanvasNode({ x, y, width, height, selected = false, className, children, ...props }: SpatialCanvasNodeProps): JSX.Element {
  return (
    <div {...props} className={join("spatial-canvas__node", className)} data-selected={selected} style={sizedStyle({ x, y, width, height })}>
      {children}
    </div>
  )
}

export function SpatialCanvasLabel({
  x,
  y,
  className,
  children,
  ...props
}: Point & Omit<ComponentPropsWithoutRef<"div">, "style" | "children"> & { readonly children: ReactNode }): JSX.Element {
  return (
    <div {...props} className={join("spatial-canvas__label", className)} style={positionStyle({ x, y })}>
      {children}
    </div>
  )
}

export function SpatialCanvasMarquee(bounds: Rect): JSX.Element {
  return <div className="spatial-canvas__marquee" style={sizedStyle(bounds)} />
}
