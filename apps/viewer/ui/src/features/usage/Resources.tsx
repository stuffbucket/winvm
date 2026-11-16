import type { JSX } from "react"
import { t } from "../../i18n"
import {
  type Amount,
  formatGB,
  formatPercent,
  fraction,
  type Usage,
} from "./usage"
import type { UsageView } from "./useUsage"

export interface UsageContext {
  readonly cpus: number | null
  readonly overlayBytes: number | null
}

function Sparkline({
  values,
}: {
  readonly values: readonly number[]
}): JSX.Element {
  const w = 100
  const h = 24
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  const step = values.length > 1 ? w / (values.length - 1) : 0
  const pts = values.map(
    (v, i) => `${(i * step).toFixed(1)},${(h - clamp(v) * h).toFixed(1)}`,
  )
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {values.length > 1 && (
        <>
          <polygon
            className="sparkline__area"
            points={`0,${String(h)} ${pts.join(" ")} ${String(w)},${String(h)}`}
          />
          <polyline
            className="sparkline__line"
            points={pts.join(" ")}
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  )
}

function Bar({ fill }: { readonly fill: number }): JSX.Element {
  return (
    <span className="resource__bar" aria-hidden="true">
      <span
        className="resource__fill"
        style={{
          inlineSize: `${String(Math.round(Math.min(1, Math.max(0, fill)) * 100))}%`,
        }}
      />
    </span>
  )
}

interface ResourceProps {
  readonly label: string
  readonly value: string
  readonly fill: number
  readonly note?: string | undefined
  readonly children: JSX.Element
}

function Resource({
  label,
  value,
  fill,
  note,
  children,
}: ResourceProps): JSX.Element {
  return (
    <div
      className="resource"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fill * 100)}
      aria-valuetext={value}
    >
      <div className="resource__head">
        <span className="resource__label">{label}</span>
        <span className="resource__value">{value}</span>
      </div>
      {children}
      {note !== undefined && <p className="resource__note">{note}</p>}
    </div>
  )
}

const cpuNote = (u: Usage, cpus: number): string =>
  u.cpuSource === "windows"
    ? t("usage.cpuWindowsNote", {
        mac: u.macCpu === null ? "…" : formatPercent(u.macCpu),
      })
    : t("usage.cpuNote", { cpus })

const memoryValue = (
  m: Amount & { readonly source: "windows" | "mac" },
): string =>
  m.source === "windows"
    ? t("usage.memoryValue", {
        used: formatGB(m.used),
        total: formatGB(m.total),
      })
    : t("usage.memoryMacValue", { used: formatGB(m.used) })

export function Resources({
  usage,
  context,
  held = null,
}: {
  readonly usage: UsageView
  readonly context: UsageContext
  readonly held?: "paused" | "asleep" | null
}): JSX.Element {
  if (held !== null)
    return (
      <p className="panel__note">
        {t(held === "asleep" ? "usage.asleep" : "usage.paused")}
      </p>
    )
  const u = usage.now
  if (u === null) return <p className="panel__note">{t("usage.none")}</p>
  return (
    <div className="resources">
      {u.cpu !== null && (
        <Resource
          label={t("usage.cpu")}
          value={formatPercent(u.cpu)}
          fill={u.cpu / 100}
          note={cpuNote(u, context.cpus ?? 1)}
        >
          <Sparkline values={usage.cpuHistory.map((v) => v / 100)} />
        </Resource>
      )}
      {u.memory !== null && (
        <Resource
          label={t("usage.memory")}
          value={memoryValue(u.memory)}
          fill={fraction(u.memory)}
          note={
            u.memory.source === "mac" ? t("usage.memoryMacNote") : undefined
          }
        >
          <Sparkline values={usage.memoryHistory} />
        </Resource>
      )}
      {u.disk !== null && (
        <Resource
          label={t("usage.disk")}
          value={t("usage.diskValue", {
            used: formatGB(u.disk.used),
            total: formatGB(u.disk.total),
          })}
          fill={fraction(u.disk)}
          note={
            context.overlayBytes === null
              ? undefined
              : t("usage.diskMacNote", { size: formatGB(context.overlayBytes) })
          }
        >
          <Bar fill={fraction(u.disk)} />
        </Resource>
      )}
    </div>
  )
}
