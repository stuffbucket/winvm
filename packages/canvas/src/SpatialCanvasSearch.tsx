/**
 * Search results within canvas chrome, from monimal's
 * `spatial-canvas-search.tsx`. Changed here: the leading icon and a second
 * line are the caller's (monimal draws a repository folder), and the active
 * result is marked for arrow-key travel.
 */
import { Children, type ReactNode } from "react"

/** A list of matches, or what to say when there are none. */
export function SpatialCanvasSearchResults({
  children,
  emptyMessage,
  label,
}: {
  readonly children: ReactNode
  readonly emptyMessage: string
  readonly label: string
}): JSX.Element {
  return (
    <div className="spatial-canvas__search-results" role="listbox" aria-label={label}>
      {Children.count(children) > 0 ? children : <span className="spatial-canvas__search-empty">{emptyMessage}</span>}
    </div>
  )
}

/** One match: a title, a line under it, and what happens when it is chosen. */
export function SpatialCanvasSearchResult({
  id,
  title,
  description,
  icon,
  active = false,
  disabled = false,
  onSelect,
}: {
  readonly id?: string
  readonly title: string
  readonly description: string
  readonly icon?: ReactNode
  readonly active?: boolean
  readonly disabled?: boolean
  onSelect(): void
}): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      className="spatial-canvas__search-result"
      data-active={active}
      disabled={disabled}
      onClick={onSelect}
    >
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </button>
  )
}
