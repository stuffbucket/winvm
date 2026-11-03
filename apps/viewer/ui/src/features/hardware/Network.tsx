import { useEffect, useRef, useState } from "react"

import { copyText } from "../../backend"
import { Icon } from "../../components/Icon"
import { OneLine } from "../../components/OneLine"
import { t } from "../../i18n"
import { endpoint, forwardKey, listenerKey, windowsAddress } from "./info"
import type { MachineInfoView } from "./useMachineInfo"

/** A value and a button that copies `copy` (default: the value itself). */
function CopyRow({ label, value, copy }: { readonly label: string; readonly value: string; readonly copy?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const text = copy ?? value
  const tip = copied ? t("network.copied") : t("network.copy", { value: text })
  const onCopy = (): void => {
    copyText(text)
      .then(() => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }
  return (
    <div className="kv__row kv__row--center">
      <dt>{label}</dt>
      <dd className="copyable">
        <OneLine value={value} />
        <button type="button" className="btn btn--ghost btn--icon" aria-label={tip} title={tip} onClick={onCopy}>
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </dd>
    </div>
  )
}

/**
 * The panel's Network, read-only: QEMU's NAT, the addresses Windows sees, and
 * the ports on this Mac that reach into Windows (forwards) or show its screen
 * (listeners). Forwards and listeners exist only while the machine runs.
 */
export function Network({ view }: { readonly view: MachineInfoView }): JSX.Element {
  const info = view.info
  if (info === null)
    return view.error === null ? <p className="panel__note">{t("state.loading")}</p> : <p className="action__error">{view.error}</p>

  const n = info.network
  const mode = n.mode === "user" ? t("network.mode.user") : n.label
  const ports = [
    ...n.forwards.map((f) => ({
      key: `f${String(f.hostPort)}`,
      label: t(forwardKey(f.kind)),
      value: t("network.forwardValue", { from: endpoint(f.host, f.hostPort), to: f.guestPort }),
      copy: endpoint(f.host, f.hostPort),
    })),
    ...n.listeners.map((l) => ({ key: `l${String(l.port)}`, label: t(listenerKey(l.kind)), value: endpoint(l.host, l.port), copy: undefined })),
  ]

  return (
    <div className="action">
      <dl className="kv">
        <div className="kv__row">
          <dt>{t("network.mode")}</dt>
          <dd>{mode}</dd>
        </div>
        <CopyRow
          label={n.windows?.adapter == null ? t("network.windows") : t("network.windowsOn", { adapter: n.windows.adapter })}
          value={windowsAddress(info)}
        />
        <CopyRow label={t("network.gateway")} value={n.gateway} />
        <CopyRow label={t("network.dns")} value={n.dns} />
      </dl>

      <div className="action__section">
        <p className="action__label">{t("network.ports")}</p>
        {ports.length === 0 ? (
          <p className="action__hint">{t(info.running ? "network.noPorts" : "network.portsWhenRunning")}</p>
        ) : (
          <dl className="kv kv--stacked">
            {ports.map((p) => (
              <CopyRow key={p.key} label={p.label} value={p.value} copy={p.copy} />
            ))}
          </dl>
        )}
        <p className="action__hint">{t("network.reach", { gateway: n.gateway })}</p>
      </div>
      {view.error !== null && <p className="action__error">{view.error}</p>}
    </div>
  )
}
