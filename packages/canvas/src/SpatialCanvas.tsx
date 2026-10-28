/**
 * The canvas's layers, from monimal's
 * `packages/maximal-design-system/src/components/spatial-canvas/spatial-canvas.tsx`:
 * the root, the viewport with its dot grid, the scene that carries the
 * camera's transform, positioned nodes and the selection marquee.
 *
 * Left out: monimal's project cards, sticky notes, connectors, comment pins
 * and collaborators' cursors (its project map's own things). A node here is
 * any positioned content (`SpatialCanvasNode`), and the app draws its own.
 */
import { forwardRef, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from "react"

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

/** The canvas's root: it clips, and isolates its stacking and layout from the page. */
export function SpatialCanvas({ children, className, ...props }: SpatialCanvasProps): JSX.Element {
  return (
    <div {...props} className={join("spatial-canvas", className)}>
      {children}
    </div>
  )
}

/**
 * The dot grid's spacing and offset for a camera. It drifts with a pan and
 * breathes a little with the zoom (16 to 20 px), rather than scaling with
 * it, so it reads as a surface at every zoom.
 */
export function gridStyle({ x, y, zoom }: Camera): CSSProperties {
  const spacing = 16 + 4 * Math.tanh(Math.log(Math.max(zoom, Number.EPSILON)) * 0.35)
  const offset = (translation: number): number => ((translation % spacing) + spacing) % spacing
  return {
    backgroundPosition: `${String(offset(x))}px ${String(offset(y))}px`,
    backgroundSize: `${String(spacing)}px ${String(spacing)}px`,
  }
}

export type SpatialCanvasViewportProps = ComponentPropsWithoutRef<"div"> & {
  /** What a press on empty canvas does, for the cursor: "select" or "hand" (pans). */
  readonly tool?: string
  readonly camera?: Camera
  /** The grid's own camera, when it should lag or lead the scene's. */
  readonly gridCamera?: Camera
  /** No dot grid. */
  readonly plain?: boolean
}

/** Takes the pointer, wheel and keys; keeps the dot grid anchored to the camera. */
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

/** Applies the camera's translation and zoom to world-space children. */
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

/** Positions content at world-space bounds. */
export function SpatialCanvasNode({ x, y, width, height, selected = false, className, children, ...props }: SpatialCanvasNodeProps): JSX.Element {
  return (
    <div {...props} className={join("spatial-canvas__node", className)} data-selected={selected} style={sizedStyle({ x, y, width, height })}>
      {children}
    </div>
  )
}

/** A world-space label, positioned at its top left. */
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

/** A world-space rectangular selection marquee. */
export function SpatialCanvasMarquee(bounds: Rect): JSX.Element {
  return <div className="spatial-canvas__marquee" style={sizedStyle(bounds)} />
}
