/**
 * monimal's spatial-canvas.test.tsx, moved to bun:test and happy-dom and cut
 * to what this package keeps: the layers' geometry and class names, the
 * chrome's semantics, search, the surface, and the camera hook's flights.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const canvas = await import("../src/index")

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

function render(node: JSX.Element): HTMLElement {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
  return host
}

const zoomLabels = { group: "Zoom", zoomOut: "Zoom out", zoomIn: "Zoom in", reset: "Fit everything" }

describe("SpatialCanvas", () => {
  it("owns its geometry and class names", () => {
    const host = render(
      <canvas.SpatialCanvasSurface open embedded title="Checkpoints" description="Every checkpoint on a canvas" data-testid="surface">
        <canvas.SpatialCanvas data-testid="board">
          <canvas.SpatialCanvasViewport tool="hand" camera={{ x: 40, y: 60, zoom: 1.25 }} aria-label="Canvas">
            <canvas.SpatialCanvasScene x={40} y={60} zoom={1.25}>
              <canvas.SpatialCanvasNode x={10} y={20} width={280} height={120} selected>
                card
              </canvas.SpatialCanvasNode>
              <canvas.SpatialCanvasLabel x={0} y={-30}>
                Today
              </canvas.SpatialCanvasLabel>
              <canvas.SpatialCanvasMarquee x={0} y={0} width={20} height={30} />
            </canvas.SpatialCanvasScene>
          </canvas.SpatialCanvasViewport>
        </canvas.SpatialCanvas>
      </canvas.SpatialCanvasSurface>,
    )
    const surface = host.querySelector('[data-testid="surface"]')
    expect(surface?.className).toContain("spatial-canvas-surface--embedded")
    expect(surface?.getAttribute("role")).toBe("region")
    expect(surface?.getAttribute("aria-label")).toBe("Checkpoints")
    expect(host.querySelector('[data-testid="board"]')?.className).toBe("spatial-canvas")
    expect(host.querySelector('[aria-label="Canvas"]')?.getAttribute("data-tool")).toBe("hand")
    expect(host.querySelector(".spatial-canvas__grid")?.getAttribute("style")).toContain("background-size:")
    expect(host.querySelector(".spatial-canvas__scene")?.getAttribute("style")).toContain("translate3d(40px, 60px, 0) scale(1.25)")
    const node = host.querySelector(".spatial-canvas__node")
    expect(node?.getAttribute("style")).toContain("width: 280px")
    expect(node?.getAttribute("data-selected")).toBe("true")
    expect(host.querySelector(".spatial-canvas__label")?.textContent).toBe("Today")
    expect(host.querySelector(".spatial-canvas__marquee")?.getAttribute("style")).toContain("height: 30px")
  })

  it("anchors the grid to the camera and lets it breathe with the zoom", () => {
    const at1 = canvas.gridStyle({ x: 0, y: 0, zoom: 1 })
    expect(at1.backgroundSize).toBe("16px 16px")
    const panned = canvas.gridStyle({ x: 20, y: -4, zoom: 1 })
    expect(panned.backgroundPosition).toBe("4px 12px")
    const zoomedIn = Number.parseFloat(String(canvas.gridStyle({ x: 0, y: 0, zoom: 4 }).backgroundSize))
    const zoomedOut = Number.parseFloat(String(canvas.gridStyle({ x: 0, y: 0, zoom: 0.25 }).backgroundSize))
    expect(zoomedIn).toBeGreaterThan(16)
    expect(zoomedIn).toBeLessThan(20)
    expect(zoomedOut).toBeLessThan(16)
    expect(zoomedOut).toBeGreaterThan(12)
  })

  it("portals a modal surface over the page, and gives focus back after", () => {
    const before = document.createElement("button")
    document.body.append(before)
    before.focus()
    const host = render(
      <canvas.SpatialCanvasSurface open title="Checkpoints" description="d" phase="entering">
        <button type="button">inside</button>
      </canvas.SpatialCanvasSurface>,
    )
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(host.contains(dialog)).toBe(false)
    expect(dialog?.getAttribute("aria-modal")).toBe("true")
    expect(dialog?.getAttribute("data-phase")).toBe("entering")
    expect(dialog?.contains(document.activeElement)).toBe(true)
    act(() => root?.render(<canvas.SpatialCanvasSurface open={false} title="Checkpoints" description="d" children={null} />))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(before)
  })

  it("gives chrome its semantics and the app its words", () => {
    const onZoomIn = mock(() => undefined)
    const onReset = mock(() => undefined)
    const onClose = mock(() => undefined)
    const host = render(
      <>
        <canvas.SpatialCanvasTopBar>
          <canvas.SpatialCanvasCorner>
            <canvas.CanvasIconButton label="Search (⌘F)" selected>
              <canvas.CanvasGlyph>{canvas.GLYPHS.search}</canvas.CanvasGlyph>
            </canvas.CanvasIconButton>
          </canvas.SpatialCanvasCorner>
        </canvas.SpatialCanvasTopBar>
        <canvas.SpatialCanvasZoomControls zoom={1.25} labels={zoomLabels} onZoomOut={() => undefined} onReset={onReset} onZoomIn={onZoomIn} />
        <canvas.SpatialCanvasSidePanel label="Checkpoint" title="before-install" closeLabel="Close before-install" onClose={onClose}>
          body
        </canvas.SpatialCanvasSidePanel>
      </>,
    )
    const search = host.querySelector<HTMLButtonElement>('[aria-label="Search (⌘F)"]')
    expect(search?.getAttribute("aria-pressed")).toBe("true")
    expect(search?.querySelector("svg")).not.toBeNull()
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Zoom")
    const value = host.querySelector<HTMLButtonElement>(".spatial-canvas__zoom-value")
    expect(value?.textContent).toBe("125%")
    act(() => {
      value?.click()
      host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click()
      host.querySelector<HTMLButtonElement>('[aria-label="Close before-install"]')?.click()
    })
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onZoomIn).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(host.querySelector(".spatial-canvas__side-panel > header > strong")?.textContent).toBe("before-install")
  })

  it("lists search matches, or says there are none", () => {
    const onSelect = mock(() => undefined)
    const host = render(
      <canvas.SpatialCanvasSearchResults label="Matches" emptyMessage="No checkpoints match">
        <canvas.SpatialCanvasSearchResult title="before-install" description="Today at 1:33 PM" active onSelect={onSelect} />
      </canvas.SpatialCanvasSearchResults>,
    )
    const result = host.querySelector<HTMLButtonElement>(".spatial-canvas__search-result")
    expect(result?.getAttribute("role")).toBe("option")
    expect(result?.getAttribute("aria-selected")).toBe("true")
    act(() => result?.click())
    expect(onSelect).toHaveBeenCalledTimes(1)
    act(() => root?.render(<canvas.SpatialCanvasSearchResults label="Matches" emptyMessage="No checkpoints match" children={[]} />))
    expect(host.querySelector(".spatial-canvas__search-empty")?.textContent).toBe("No checkpoints match")
  })
})

describe("useCanvasCamera", () => {
  it("flies to a camera through eased steps and lands exactly", async () => {
    const seen: number[] = []
    let api: ReturnType<typeof canvas.useCanvasCamera> | null = null
    function Probe(): JSX.Element {
      api = canvas.useCanvasCamera({ x: 0, y: 0, zoom: 1 }, () => ({ width: 800, height: 600 }))
      seen.push(api.camera.zoom)
      return <span>{api.camera.zoom}</span>
    }
    render(<Probe />)
    let arrived = null as boolean | null
    await act(async () => {
      const flight = api!.fly({ x: -400, y: -300, zoom: 2 }, { duration: 160 })
      await new Promise((r) => setTimeout(r, 60))
      seen.push(api!.current().zoom)
      arrived = await flight
      await new Promise((r) => setTimeout(r, 40))
    })
    expect(arrived).toBe(true)
    expect(api!.camera).toEqual({ x: -400, y: -300, zoom: 2 })
    expect(seen.some((z) => z > 1 && z < 2)).toBe(true)
  })

  it("stops a flight when the camera is set directly", async () => {
    let api: ReturnType<typeof canvas.useCanvasCamera> | null = null
    function Probe(): JSX.Element {
      api = canvas.useCanvasCamera({ x: 0, y: 0, zoom: 1 }, () => ({ width: 800, height: 600 }))
      return <span />
    }
    render(<Probe />)
    let arrived = null as boolean | null
    await act(async () => {
      const flight = api!.fly({ x: -400, y: -300, zoom: 2 }, { duration: 500 })
      api!.set({ x: 5, y: 5, zoom: 1 })
      arrived = await flight
      await new Promise((r) => setTimeout(r, 40))
    })
    expect(arrived).toBe(false)
    expect(api!.camera).toEqual({ x: 5, y: 5, zoom: 1 })
  })
})
