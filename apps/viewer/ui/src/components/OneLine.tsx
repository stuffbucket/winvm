import type { JSX } from "react"
export function OneLine({ value, keep }: { readonly value: string; readonly keep?: number }): JSX.Element {
  const tail = keep ?? (value.length > 16 ? 8 : 0)
  const kept = tail >= value.length ? 0 : tail
  return (
    <code className="mono oneline" title={value}>
      <span className="oneline__head">{kept === 0 ? value : value.slice(0, -kept)}</span>
      {kept > 0 && <span className="oneline__tail">{value.slice(-kept)}</span>}
    </code>
  )
}
