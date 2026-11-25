import type { Meta, StoryObj } from "@storybook/react-vite"
import { type JSX, useState } from "react"
import {
  CanvasGlyph,
  GLYPHS,
  SpatialCanvas,
  SpatialCanvasCorner,
  SpatialCanvasLabel,
  SpatialCanvasMarquee,
  SpatialCanvasNode,
  SpatialCanvasScene,
  SpatialCanvasSearchResult,
  SpatialCanvasSearchResults,
  SpatialCanvasSurface,
  SpatialCanvasViewport,
  SpatialCanvasZoomControls,
} from "../../../canvas/src/index"

const CARD = { width: 240, height: 150, gap: 24 }
const ROWS = [
  { label: "Last week", names: ["Baseline", "Office installed", "auto-1"] },
  { label: "Yesterday", names: ["Before update", "After update"] },
  { label: "Today", names: ["VS Code set up", "auto-3", "Clean desktop"] },
]
const ROW_HEIGHT = CARD.height + CARD.gap * 3
const ZOOM_STEP = 1.25
const LABELS = {
  group: "Zoom",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  reset: "Fit everything",
}
const ignore = (): void => undefined

function Board({
  selected,
}: {
  readonly selected: string | null
}): JSX.Element {
  const [zoom, setZoom] = useState(1)
  const camera = { x: CARD.gap * 2, y: CARD.gap * 2, zoom }
  return (
    <SpatialCanvasSurface
      open
      embedded
      title="Checkpoints"
      description="Every checkpoint on a canvas"
      className="sb-canvas"
    >
      <SpatialCanvas>
        <SpatialCanvasViewport tool="hand" camera={camera} aria-label="Canvas">
          <SpatialCanvasScene {...camera}>
            {ROWS.map((row, r) => (
              <div key={row.label}>
                <SpatialCanvasLabel x={0} y={r * ROW_HEIGHT}>
                  {row.label}
                </SpatialCanvasLabel>
                {row.names.map((name, i) => (
                  <SpatialCanvasNode
                    key={name}
                    x={i * (CARD.width + CARD.gap)}
                    y={r * ROW_HEIGHT + CARD.gap * 2}
                    width={CARD.width}
                    height={CARD.height}
                    selected={name === selected}
                  >
                    <div className="sb-canvas__card">{name}</div>
                  </SpatialCanvasNode>
                ))}
              </div>
            ))}
            {selected === null && (
              <SpatialCanvasMarquee
                x={-CARD.gap / 2}
                y={ROW_HEIGHT + CARD.gap}
                width={CARD.width * 2 + CARD.gap * 2}
                height={CARD.height + CARD.gap * 2}
              />
            )}
          </SpatialCanvasScene>
        </SpatialCanvasViewport>
        <SpatialCanvasCorner>
          <SpatialCanvasZoomControls
            zoom={zoom}
            labels={LABELS}
            onZoomOut={() => {
              setZoom((z) => z / ZOOM_STEP)
            }}
            onReset={() => {
              setZoom(1)
            }}
            onZoomIn={() => {
              setZoom((z) => z * ZOOM_STEP)
            }}
          />
        </SpatialCanvasCorner>
      </SpatialCanvas>
    </SpatialCanvasSurface>
  )
}

const meta = {
  title: "Canvas/Spatial Canvas",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta

type Story = StoryObj

export const Board_: Story = {
  name: "Board",
  render: () => <Board selected="After update" />,
}

export const Marquee: Story = {
  name: "Marquee selection",
  render: () => <Board selected={null} />,
}

export const SearchResults: Story = {
  name: "Search results",
  render: () => (
    <div className="sb-pane">
      <SpatialCanvasSearchResults label="Checkpoints" emptyMessage="No match">
        <SpatialCanvasSearchResult
          title="Office installed"
          description="12 days ago"
          icon={<CanvasGlyph>{GLYPHS.plus}</CanvasGlyph>}
          active
          onSelect={ignore}
        />
        <SpatialCanvasSearchResult
          title="Before the Office update"
          description="4 days ago"
          onSelect={ignore}
        />
        <SpatialCanvasSearchResult
          title="Office trial (incompatible)"
          description="31 days ago"
          disabled
          onSelect={ignore}
        />
      </SpatialCanvasSearchResults>
    </div>
  ),
}

export const NoResults: Story = {
  name: "Search, no results",
  render: () => (
    <div className="sb-pane">
      <SpatialCanvasSearchResults label="Checkpoints" emptyMessage="No match">
        {[]}
      </SpatialCanvasSearchResults>
    </div>
  ),
}
