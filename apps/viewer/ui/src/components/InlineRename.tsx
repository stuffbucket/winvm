import { useEffect, useRef } from "react"

import { cx } from "./cx"

interface InlineRenameProps {
  /** What is there now, selected to type over. */
  readonly value: string
  /** The field's accessible name, e.g. "Tab name". */
  readonly label: string
  readonly className?: string
  readonly maxLength?: number
  /** Return or leaving the field: the text typed (empty asks for the automatic name). Escape: null, no change. */
  onDone(next: string | null): void
}

/**
 * A name edited where it is shown, as Finder and Terminal do: the field takes
 * the name's place, selected; Return or a click elsewhere keeps what was
 * typed, Escape puts the name back.
 */
export function InlineRename({ value, label, className, maxLength, onDone }: InlineRenameProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const finish = (next: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(next)
  }
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  return (
    <input
      ref={input}
      className={cx("rename", className)}
      type="text"
      aria-label={label}
      defaultValue={value}
      maxLength={maxLength}
      spellCheck={false}
      autoComplete="off"
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") finish(e.currentTarget.value)
        else if (e.key === "Escape") finish(null)
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}
