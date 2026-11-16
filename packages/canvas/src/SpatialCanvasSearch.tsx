import { Children, type JSX, type ReactNode } from "react"

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

export function SpatialCanvasSearchResult({
  id,
  title,
  description,
  icon,
  active = false,
  disabled = false,
  onSelect,
}: {
  readonly id?: string | undefined
  readonly title: string
  readonly description: string
  readonly icon?: ReactNode
  readonly active?: boolean
  readonly disabled?: boolean
  onSelect: () => void
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
