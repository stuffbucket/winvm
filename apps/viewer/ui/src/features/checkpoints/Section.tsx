import { CanvasGlyph, GLYPHS, SpatialCanvasNode } from "@winvm/canvas"
import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react"

import { t } from "../../i18n"
import {
  HANDLES,
  type Handle,
  SECTION_NAME_MAX,
  type Section,
} from "./sections"

const EDGES: readonly Handle[] = ["n", "e", "s", "w"]

export interface SectionViewProps {
  readonly s: Section
  readonly count: number
  readonly zoom: number
  readonly selected: boolean
  readonly editing: boolean
  readonly target: boolean
  readonly moving: boolean
  readonly onRename: (
    id: string,
    typed: string | null,
  ) => "long" | "control" | null
  readonly onRemove: (id: string) => void
  readonly onKeyDown: (e: KeyboardEvent<HTMLElement>, id: string) => void
}

const problemText = (why: "long" | "control"): string =>
  why === "long"
    ? t("machine.title.long", { max: SECTION_NAME_MAX })
    : t("machine.title.control")

function TabField({
  value,
  onDone,
}: {
  readonly value: string
  readonly onDone: (typed: string | null) => "long" | "control" | null
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const [typed, setTyped] = useState(value)
  const [problem, setProblem] = useState<"long" | "control" | null>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (next: string | null): void => {
    if (done.current) return
    const why = onDone(next)
    if (why === null) done.current = true
    else if (next !== null) setProblem(why)
  }
  return (
    <>
      <span className="section__field" data-value={typed}>
        <input
          ref={input}
          className="section__input"
          type="text"
          aria-label={t("checkpoints.section.nameField")}
          aria-invalid={problem !== null}
          value={typed}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setTyped(e.target.value)
            setProblem(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") finish(typed)
            else if (e.key === "Escape") finish(null)
          }}
          onBlur={() => {
            if (done.current) return
            if (onDone(typed) !== null) onDone(null)
            done.current = true
          }}
          onClick={(e) => {
            e.stopPropagation()
          }}
        />
      </span>
      {problem !== null && (
        <span className="section__problem" role="alert">
          {problemText(problem)}
        </span>
      )}
    </>
  )
}

export function SectionView({
  s,
  count,
  zoom,
  selected,
  editing,
  target,
  moving,
  onRename,
  onRemove,
  onKeyDown,
}: SectionViewProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const was = useRef(editing)
  useEffect(() => {
    const node = root.current?.parentElement
    if (
      was.current &&
      !editing &&
      node != null &&
      (document.activeElement === document.body ||
        node.contains(document.activeElement))
    )
      node.focus({ preventScroll: true })
    was.current = editing
  }, [editing])
  const frame = {
    "--inv": String(1 / zoom),
    "--tab-max": `${String(Math.max(96, s.w * zoom))}px`,
  } as CSSProperties
  return (
    <SpatialCanvasNode
      x={s.x}
      y={s.y}
      width={s.w}
      height={s.h}
      selected={selected}
      className="section"
      role="group"
      tabIndex={0}
      aria-label={t("checkpoints.section.label", { name: s.name, count })}
      data-target={target}
      data-moving={moving}
      data-editing={editing}
      data-section={s.id}
      onKeyDown={(e) => {
        onKeyDown(e, s.id)
      }}
    >
      <div className="section__frame" style={frame} ref={root}>
        <div
          className="section__body"
          data-part="body"
          data-section-id={s.id}
        />
        {EDGES.map((h) => (
          <span
            key={h}
            className="section__edge"
            data-part="edge"
            data-handle={h}
            data-section-id={s.id}
          />
        ))}
        {selected &&
          HANDLES.filter((h) => h.length === 2).map((h) => (
            <span
              key={h}
              className="section__corner"
              data-part="corner"
              data-handle={h}
              data-section-id={s.id}
            />
          ))}
        <div
          className="section__tab"
          data-part="tab"
          data-section-id={s.id}
          data-editing={editing}
        >
          {editing ? (
            <TabField
              value={s.name}
              onDone={(typed) => onRename(s.id, typed)}
            />
          ) : (
            <span className="section__name">{s.name}</span>
          )}
          {selected && !editing && (
            <button
              type="button"
              className="section__remove"
              aria-label={t("checkpoints.section.remove")}
              title={t("checkpoints.section.removeTip")}
              onClick={() => {
                onRemove(s.id)
              }}
            >
              <CanvasGlyph size={12}>{GLYPHS.close}</CanvasGlyph>
            </button>
          )}
        </div>
      </div>
    </SpatialCanvasNode>
  )
}

export function SectionDraft({
  box,
  ok,
}: {
  readonly box: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly ok: boolean
}): JSX.Element {
  return (
    <div
      className="section-draft"
      data-ok={ok}
      style={{
        transform: `translate3d(${String(box.x)}px, ${String(box.y)}px, 0)`,
        width: box.width,
        height: box.height,
      }}
      aria-hidden="true"
    />
  )
}

export function SectionGrid({
  camera,
  grid,
  on,
}: {
  readonly camera: {
    readonly x: number
    readonly y: number
    readonly zoom: number
  }
  readonly grid: number
  readonly on: boolean
}): JSX.Element {
  let step = grid * camera.zoom
  while (step < 10) step *= 2
  const at = (v: number): number => (((v - step / 2) % step) + step) % step
  return (
    <span
      className="checkpoints__grid"
      data-on={on}
      aria-hidden="true"
      style={{
        backgroundSize: `${String(step)}px ${String(step)}px`,
        backgroundPosition: `${String(at(camera.x))}px ${String(at(camera.y))}px`,
      }}
    />
  )
}
