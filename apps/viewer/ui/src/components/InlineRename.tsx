import { type JSX, useEffect, useRef } from "react"

import { cx } from "./cx"

interface InlineRenameProps {
  readonly value: string
  readonly label: string
  readonly className?: string
  readonly maxLength?: number
  onDone: (next: string | null) => void
}

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
      onBlur={(e) => { finish(e.currentTarget.value) }}
      onClick={(e) => { e.stopPropagation() }}
      onDoubleClick={(e) => { e.stopPropagation() }}
    />
  )
}
