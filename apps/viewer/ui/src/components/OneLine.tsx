/**
 * A long value on one line: when it doesn't fit, the middle gives way and both
 * ends stay. `keep` is how much of the end stays whole (a token's last 8
 * characters, a path's last part); the whole value is the tooltip.
 */
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
