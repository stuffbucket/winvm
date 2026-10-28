/**
 * The Files window's list: column headings that sort, and the folder's
 * entries as rows. Only the rows in view (and a few either side) are in the
 * DOM, so a folder of thousands scrolls as smoothly as one of ten.
 */
import { type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react"

import { cx } from "../../components/cx"
import { t } from "../../i18n"
import type { Entry, Sort, SortKey } from "./files"
import { finderDate, formatBytes } from "./files"
import { CHEVRON, glyphOf, kindLabel, kindOf } from "./kinds"

export interface Renaming {
  readonly name: string
  readonly draft: string
}

interface FileListProps {
  readonly list: RefObject<HTMLDivElement | null>
  readonly label: string
  readonly entries: readonly Entry[]
  readonly sort: Sort
  readonly selected: ReadonlySet<string>
  readonly active: string | null
  readonly renaming: Renaming | null
  /** A folder row something is being dragged onto. */
  readonly target: string | null
  /** Being dragged: drawn dimmed. */
  readonly carried: ReadonlySet<string>
  readonly now: number
  readonly empty: boolean
  readonly loading: boolean
  readonly more: string | null
  onSort(key: SortKey): void
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void
  onRowPointerDown(e: PointerEvent<HTMLDivElement>, entry: Entry): void
  onRowDoubleClick(entry: Entry): void
  onContextMenu(e: MouseEvent<HTMLDivElement>, entry: Entry | null): void
  onBackgroundPointerDown(e: PointerEvent<HTMLDivElement>): void
  onDraft(draft: string): void
  onRenameDone(commit: boolean): void
}

const COLUMNS: readonly { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: "files.name", className: "files__c-name" },
  { key: "modified", label: "files.modified", className: "files__c-date" },
  { key: "size", label: "files.size", className: "files__c-size" },
  { key: "kind", label: "files.kind", className: "files__c-kind" },
]

/** Rows drawn beyond the visible ones, above and below. */
const OVERSCAN = 8

export const rowId = (name: string): string => `files-row-${encodeURIComponent(name)}`

/** The row height the stylesheet sets, in CSS pixels. */
export function rowHeight(el: HTMLElement | null): number {
  if (el === null) return 24
  const px = Number.parseFloat(getComputedStyle(el).getPropertyValue("--files-row"))
  return Number.isFinite(px) && px > 0 ? px : 24
}

function When({ ms, now }: { readonly ms: number; readonly now: number }): JSX.Element {
  const d = finderDate(ms, now, t)
  return (
    <>
      <span className="files__date-long">{d.long}</span>
      <span className="files__date-medium">{d.medium}</span>
      <span className="files__date-short">{d.short}</span>
    </>
  )
}

/** The editable name: the stem selected, as Finder does, so typing keeps the extension. */
function NameField({ draft, onDraft, onDone }: { readonly draft: string; onDraft(d: string): void; onDone(commit: boolean): void }): JSX.Element {
  const input = useRef<HTMLInputElement | null>(null)
  const cancelled = useRef(false)
  useLayoutEffect(() => {
    const el = input.current
    if (el === null) return
    el.focus()
    const dot = el.value.lastIndexOf(".")
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
  }, [])
  return (
    <input
      ref={input}
      className="files__rename"
      aria-label={t("files.rename")}
      value={draft}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onDraft(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") {
          e.preventDefault()
          onDone(true)
        } else if (e.key === "Escape") {
          e.preventDefault()
          cancelled.current = true
          onDone(false)
        }
      }}
      onBlur={() => {
        if (!cancelled.current) onDone(true)
      }}
    />
  )
}

export function FileList(p: FileListProps): JSX.Element {
  const [view, setView] = useState({ top: 0, height: 600, row: 24 })

  useEffect(() => {
    const el = p.list.current
    if (el === null) return
    const measure = (): void => setView({ top: el.scrollTop, height: el.clientHeight, row: rowHeight(el) })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [p.list])

  const n = p.entries.length
  const first = Math.max(0, Math.floor(view.top / view.row) - OVERSCAN)
  const last = Math.min(n, Math.ceil((view.top + view.height) / view.row) + OVERSCAN)
  const rows = p.entries.slice(first, last)

  return (
    <div className="files__table">
      <div className="files__head" role="row">
        {COLUMNS.map((c) => {
          const on = p.sort.key === c.key
          return (
            <button
              key={c.key}
              type="button"
              role="columnheader"
              aria-sort={on ? (p.sort.descending ? "descending" : "ascending") : "none"}
              className={cx("files__heading", c.className, on && "files__heading--on")}
              // A heading sorts without taking the keyboard from the list, as in Finder.
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => p.onSort(c.key)}
            >
              <span className="files__heading-label">{t(c.label)}</span>
              <span className="files__chevron" aria-hidden="true">
                {on ? (p.sort.descending ? CHEVRON.down : CHEVRON.up) : ""}
              </span>
            </button>
          )
        })}
      </div>
      <div
        ref={p.list as RefObject<HTMLDivElement>}
        className="files__list"
        role="listbox"
        aria-multiselectable="true"
        aria-label={p.label}
        aria-busy={p.loading}
        aria-activedescendant={p.active !== null && p.renaming === null ? rowId(p.active) : undefined}
        tabIndex={0}
        onKeyDown={p.onKeyDown}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop
          setView((v) => (v.top === top ? v : { ...v, top }))
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("files__rows")) p.onBackgroundPointerDown(e)
        }}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("files__rows")) p.onContextMenu(e, null)
        }}
      >
        <div className="files__rows" style={{ height: `${String(n * view.row)}px` }}>
          {rows.map((e, k) => {
            const i = first + k
            const renaming = p.renaming?.name === e.name ? p.renaming : null
            return (
              <div
                key={e.name}
                id={rowId(e.name)}
                role="option"
                aria-selected={p.selected.has(e.name)}
                className={cx(
                  "files__row",
                  i % 2 === 1 && "files__row--alt",
                  e.name === p.active && "files__row--active",
                  e.name === p.target && "files__row--target",
                  p.carried.has(e.name) && "files__row--carried",
                  e.hidden && "files__row--hidden",
                )}
                style={{ transform: `translateY(${String(i * view.row)}px)` }}
                title={renaming === null ? e.name : undefined}
                data-name={e.name}
                data-dir={e.dir ? "" : undefined}
                onPointerDown={(ev) => p.onRowPointerDown(ev, e)}
                onDoubleClick={() => p.onRowDoubleClick(e)}
                onContextMenu={(ev) => p.onContextMenu(ev, e)}
              >
                <span className="files__c-name files__name">
                  <span className={cx("files__glyph", `files__glyph--${kindOf(e.name, e.dir)}`)} aria-hidden="true">
                    {glyphOf(e.name, e.dir)}
                  </span>
                  {renaming === null ? (
                    <span className="files__label">{e.name}</span>
                  ) : (
                    <NameField draft={renaming.draft} onDraft={p.onDraft} onDone={p.onRenameDone} />
                  )}
                </span>
                <span className="files__c-date files__num">{e.modified === null ? "" : <When ms={e.modified} now={p.now} />}</span>
                <span className="files__c-size files__num">{e.size === null ? "--" : formatBytes(e.size)}</span>
                <span className="files__c-kind files__kind">{kindLabel(e.name, e.dir, t)}</span>
              </div>
            )
          })}
        </div>
        {p.empty && <p className="files__empty">{t("files.empty")}</p>}
        {p.loading && n === 0 && <p className="files__empty">{t("state.loading")}</p>}
        {p.more !== null && <p className="files__more">{p.more}</p>}
      </div>
    </div>
  )
}
