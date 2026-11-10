import { useEffect, useState } from "react"

import { t } from "../../i18n"
import { type Amount, formatGB, formatPercent, fraction, type Usage } from "./usage"
import type { UsageView } from "./useUsage"

export interface UsageContext {
  readonly cpus: number | null
  /** What the machine's changes take on the Mac (status' overlay): a second mark on the disk's bar. */
  readonly overlayBytes: number | null
}

/**
 * Recent values (0-1) as a line, oldest at the left, filled beneath. A second
 * series (`other`, on the same 0-1 scale) is a thinner dashed line without the
 * fill, so the two differ by stroke and weight, not by color alone. Both end at
 * the right edge: a shorter series starts later.
 */
export function Sparkline({ values, other = [] }: { readonly values: readonly number[]; readonly other?: readonly number[] }): JSX.Element {
  const w = 100
  const h = 24
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  const count = Math.max(values.length, other.length)
  const step = count > 1 ? w / (count - 1) : 0
  const line = (vs: readonly number[]): string[] => vs.map((v, i) => `${((count - vs.length + i) * step).toFixed(1)},${(h - clamp(v) * h).toFixed(1)}`)
  const pts = line(values)
  const otherPts = line(other)
  return (
    <svg className="sparkline" viewBox={`0 0 ${String(w)} ${String(h)}`} preserveAspectRatio="none" aria-hidden="true">
      {values.length > 1 && (
        <>
          <polygon className="sparkline__area" points={`${((count - values.length) * step).toFixed(1)},${String(h)} ${pts.join(" ")} ${String(w)},${String(h)}`} />
          <polyline className="sparkline__line" points={pts.join(" ")} vectorEffect="non-scaling-stroke" />
        </>
      )}
      {other.length > 1 && <polyline className="sparkline__line sparkline__line--other" points={otherPts.join(" ")} vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}

const percent = (v: number): string => `${String(Math.round(Math.min(1, Math.max(0, v)) * 10000) / 100)}%`

/**
 * A bar filled to `fill` (0-1): Windows' C: used, the main fill. `overlay`
 * (0-1, against the same total) is a thinner strip of ink across the same
 * track: what the machine's changes take on the Mac. It is a second measure on
 * the same scale, not a part of the fill. Never under 3 px, so a few MB show.
 */
export function Bar({ fill, overlay = null }: { readonly fill: number; readonly overlay?: number | null }): JSX.Element {
  return (
    <span className="resource__bar" aria-hidden="true">
      <span className="resource__fill" style={{ inlineSize: percent(fill) }} />
      {overlay !== null && overlay > 0 && <span className="resource__overlay" style={{ inlineSize: `max(calc(var(--border-width-thick) * 2),${percent(overlay)})` }} />}
    </span>
  )
}

/** One value in a meter's legend: its mark (the stroke or fill it has in the meter) and the value in words. */
interface LegendRow {
  readonly mark: "line" | "line-other" | "fill" | "strip"
  readonly text: string
}

interface ResourceProps {
  readonly label: string
  readonly value: string
  /** 0-1, for assistive tech when there is no legend. */
  readonly fill: number
  readonly legend?: readonly LegendRow[]
  readonly children: JSX.Element
}

/**
 * A meter. With two values to tell apart (`legend`) it is one image named in
 * full ("CPU. Windows: 3%. macOS: 12%.") that takes focus; pointing at it
 * or focusing it shows each value in words, Escape hides them. At rest only the
 * headline value shows.
 */
function Resource({ label, value, fill, legend = [], children }: ResourceProps): JSX.Element {
  const [over, setOver] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // Escape hides the legend wherever the focus is, while it is pointed at or focused.
  const active = over || focused
  useEffect(() => {
    if (!active) return
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDismissed(true)
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [active])
  useEffect(() => {
    if (!active) setDismissed(false)
  }, [active])
  const head = (
    <div className="resource__head">
      <span className="resource__label">{label}</span>
      <span className="resource__value">{value}</span>
    </div>
  )
  if (legend.length < 2) {
    return (
      <div className="resource" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)} aria-valuetext={value}>
        {head}
        {children}
      </div>
    )
  }
  return (
    <div
      className="resource resource--legend"
      role="img"
      tabIndex={0}
      aria-label={t("usage.meterName", { label, details: legend.map((r) => r.text).join(". ") })}
      data-dismissed={dismissed ? "" : undefined}
      onPointerEnter={() => setOver(true)}
      onPointerLeave={() => setOver(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {head}
      {children}
      <ul className="resource__legend" aria-hidden="true">
        {legend.map((r) => (
          <li key={r.mark} className="resource__legend-row">
            <span className={`resource__key resource__key--${r.mark}`} />
            {r.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Windows' own figure leads; what QEMU spends on the Mac (the screen and disk too) is the dashed line, named on hover. */
const cpuLegend = (u: Usage): LegendRow[] =>
  u.cpuSource === "windows" && u.cpu !== null && u.macCpu !== null
    ? [
        { mark: "line", text: t("usage.legendWindows", { value: formatPercent(u.cpu) }) },
        { mark: "line-other", text: t("usage.legendMac", { value: formatPercent(u.macCpu) }) },
      ]
    : []

/** C: as Windows counts it, and the file of the machine's changes on the Mac, both in bytes against C:'s size. */
const diskLegend = (disk: Amount, overlayBytes: number | null): LegendRow[] =>
  overlayBytes === null
    ? []
    : [
        { mark: "fill", text: t("usage.legendWindows", { value: t("usage.diskOf", { used: formatGB(disk.used), total: formatGB(disk.total) }) }) },
        { mark: "strip", text: t("usage.legendDiskMac", { size: formatGB(overlayBytes) }) },
      ]

const memoryValue = (m: Amount & { readonly source: "windows" | "mac" }): string =>
  m.source === "windows" ? t("usage.memoryValue", { used: formatGB(m.used), total: formatGB(m.total) }) : t("usage.memoryMacValue", { used: formatGB(m.used) })

/**
 * The details panel's Resources: CPU and memory with the last minute and a
 * half as a line, C: as a bar, each with its value in words. CPU also draws
 * what the Mac spends as a second, dashed line, and the disk what its changes
 * take on the Mac as a strip on the bar; hovering either names each value.
 * Read every 2.5 s while the machine runs (useUsage); nothing while it is off.
 */
export function Resources({
  usage,
  context,
  held = null,
}: {
  readonly usage: UsageView
  readonly context: UsageContext
  /** The machine is paused or asleep: Windows can't answer, so its figures wait. */
  readonly held?: "paused" | "asleep" | null
}): JSX.Element {
  if (held !== null) return <p className="panel__note">{t(held === "asleep" ? "usage.asleep" : "usage.paused")}</p>
  const u = usage.now
  if (u === null) return <p className="panel__note">{t("usage.none")}</p>
  return (
    <div className="resources">
      {u.cpu !== null && (
        <Resource
          label={t("usage.cpu")}
          value={u.cpuSource === "windows" ? formatPercent(u.cpu) : t("usage.cpuMacValue", { value: formatPercent(u.cpu) })}
          fill={u.cpu / 100}
          legend={cpuLegend(u)}
        >
          <Sparkline values={usage.cpuHistory.map((v) => v / 100)} other={u.cpuSource === "windows" ? usage.macCpuHistory.map((v) => v / 100) : []} />
        </Resource>
      )}
      {u.memory !== null && (
        <Resource label={t("usage.memory")} value={memoryValue(u.memory)} fill={fraction(u.memory)}>
          <Sparkline values={usage.memoryHistory} />
        </Resource>
      )}
      {u.disk !== null && (
        <Resource
          label={t("usage.disk")}
          value={t("usage.diskValue", { used: formatGB(u.disk.used), total: formatGB(u.disk.total) })}
          fill={fraction(u.disk)}
          legend={diskLegend(u.disk, context.overlayBytes)}
        >
          <Bar fill={fraction(u.disk)} overlay={context.overlayBytes === null ? null : fraction({ used: context.overlayBytes, total: u.disk.total })} />
        </Resource>
      )}
    </div>
  )
}
