/**
 * A section on the canvas, after FigJam's: a soft body, its name on a tab
 * above its top left corner, and, when it is selected, eight handles. The tab
 * and the handles are drawn at one size on screen at any zoom (`--inv`, the
 * zoom's reciprocal, scales them back); the body is the section's own size in
 * the world. The tab's name is edited where it stands.
 *
 * The parts say what they are (`data-part`, `data-section-id`, `data-handle`)
 * for useSections' pointer rules; the section itself takes no pointer: its
 * body passes through to the canvas until it is selected (see useSections).
 */
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react"

import { CanvasGlyph, GLYPHS, SpatialCanvasNode } from "@winvm/canvas"

import { t } from "../../i18n"
import { type Handle, HANDLES, type Section, SECTION_NAME_MAX } from "./sections"

const EDGES: readonly Handle[] = ["n", "e", "s", "w"]

export interface SectionViewProps {
  readonly s: Section
  /** How many checkpoints are in it. */
  readonly count: number
  readonly zoom: number
  readonly selected: boolean
  readonly editing: boolean
  /** A card being carried is over it: it would join. */
  readonly target: boolean
  readonly moving: boolean
  /** Commits a typed name (null leaves it); says why it can't be kept, or null. */
  onRename(id: string, typed: string | null): "long" | "control" | null
  onRemove(id: string): void
  onKeyDown(e: KeyboardEvent<HTMLElement>, id: string): void
}

const problemText = (why: "long" | "control"): string => (why === "long" ? t("machine.title.long", { max: SECTION_NAME_MAX }) : t("machine.title.control"))

/** The name, as a field at the tab's size and face: Return or leaving keeps it, Esc puts it back, an empty name keeps the old one. */
function TabField({ value, onDone }: { readonly value: string; onDone(typed: string | null): "long" | "control" | null }): JSX.Element {
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
            // Leaving with a name that can't be kept puts the old one back.
            if (done.current) return
            if (onDone(typed) !== null) onDone(null)
            done.current = true
          }}
          onClick={(e) => e.stopPropagation()}
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

export function SectionView({ s, count, zoom, selected, editing, target, moving, onRename, onRemove, onKeyDown }: SectionViewProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const was = useRef(editing)
  // After a rename, the keys go on working: focus comes back to the section.
  useEffect(() => {
    const node = root.current?.parentElement
    if (was.current && !editing && node != null && (document.activeElement === document.body || node.contains(document.activeElement))) node.focus({ preventScroll: true })
    was.current = editing
  }, [editing])
  const frame = { "--inv": String(1 / zoom), "--tab-max": `${String(Math.max(96, s.w * zoom))}px` } as CSSProperties
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
      onKeyDown={(e) => onKeyDown(e, s.id)}
    >
      <div className="section__frame" style={frame} ref={root}>
        <div className="section__body" data-part="body" data-section-id={s.id} />
        {EDGES.map((h) => (
          <span key={h} className="section__edge" data-part="edge" data-handle={h} data-section-id={s.id} />
        ))}
        {selected && HANDLES.filter((h) => h.length === 2).map((h) => <span key={h} className="section__corner" data-part="corner" data-handle={h} data-section-id={s.id} />)}
        <div className="section__tab" data-part="tab" data-section-id={s.id} data-editing={editing}>
          {editing ? (
            <TabField value={s.name} onDone={(typed) => onRename(s.id, typed)} />
          ) : (
            <span className="section__name">{s.name}</span>
          )}
          {selected && !editing && (
            <button type="button" className="section__remove" aria-label={t("checkpoints.section.remove")} title={t("checkpoints.section.removeTip")} onClick={() => onRemove(s.id)}>
              <CanvasGlyph size={12}>{GLYPHS.close}</CanvasGlyph>
            </button>
          )}
        </div>
      </div>
    </SpatialCanvasNode>
  )
}

/** The rectangle being drawn, before it is a section. */
export function SectionDraft({ box, ok }: { readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly ok: boolean }): JSX.Element {
  return <div className="section-draft" data-ok={ok} style={{ transform: `translate3d(${String(box.x)}px, ${String(box.y)}px, 0)`, width: box.width, height: box.height }} aria-hidden="true" />
}

/**
 * The dot grid, shown only while a section is drawn, moved or resized: dots at
 * the grid's crossings, in the viewport's own pixels (so a dot is a dot at any
 * zoom). Far out, where the cells would crowd, every second, fourth… crossing.
 */
export function SectionGrid({ camera, grid, on }: { readonly camera: { readonly x: number; readonly y: number; readonly zoom: number }; readonly grid: number; readonly on: boolean }): JSX.Element {
  let step = grid * camera.zoom
  while (step < 10) step *= 2
  const at = (v: number): number => (((v - step / 2) % step) + step) % step
  return <span className="checkpoints__grid" data-on={on} aria-hidden="true" style={{ backgroundSize: `${String(step)}px ${String(step)}px`, backgroundPosition: `${String(at(camera.x))}px ${String(at(camera.y))}px` }} />
}
