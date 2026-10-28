import type { ReactNode } from "react"

import { Button } from "../../components/Button"
import { Icon } from "../../components/Icon"
import { cx } from "../../components/cx"
import { t } from "../../i18n"
import type { Checks, Status } from "../../model"
import { detailRows, phase } from "../../model"
import { Resources, type UsageContext } from "../usage/Resources"
import type { UsageView } from "../usage/useUsage"
import type { Ran } from "../winvm/useWinvm"

interface PanelProps {
  readonly status: Status | null
  readonly checks: Checks | null
  readonly checksError: string | null
  readonly last: Ran | null
  readonly usage: UsageView
  readonly usageContext: UsageContext
  readonly canForceStop: boolean
  onForceStop(): void
}

function Section({ title, hint, open, children }: { title: string; hint?: string; open?: boolean; children: ReactNode }): JSX.Element {
  return (
    <details className="advanced-section" open={open}>
      <summary className="advanced-section__summary">
        <span className="advanced-section__title">{title}</span>
        {hint !== undefined && <span className="advanced-section__hint">{hint}</span>}
      </summary>
      <div className="advanced-section__body">{children}</div>
    </details>
  )
}

/** Details on demand, over the display: resources, status, this Mac and troubleshooting. */
export function Panel(p: PanelProps): JSX.Element {
  const rows = p.status === null ? [] : detailRows(p.status)
  const macReady = p.checks?.ready ?? false
  return (
    <aside className="panel" aria-label={t("action.details")}>
      <Section title={t("panel.resources")} open>
        <Resources usage={p.usage} context={p.usageContext} />
      </Section>

      <Section title={t("panel.status")} open>
        {rows.length === 0 ? (
          <p className="panel__note">{p.status === null ? t("state.loading") : t(`state.${phase(p.status)}`)}</p>
        ) : (
          <dl className="kv">
            {rows.map((r) => (
              <div className="kv__row" key={r.key}>
                <dt>{t(r.key)}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {p.status !== null && p.status.state !== "missing" && p.status.notes.length > 0 && (
          <ul className="checks" aria-label={t("panel.notes")}>
            {p.status.notes.map((n) => (
              <li className="check" key={n}>
                <span className="muted">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("panel.mac")} hint={macReady ? t("mac.ready") : undefined} open={p.checks !== null && !macReady}>
        {p.checks === null ? (
          <p className="panel__note">{p.checksError ?? t("state.loading")}</p>
        ) : (
          <ul className="checks">
            {p.checks.checks.map((c) => (
              <li key={c.label} className={cx("check", !c.ok && "check--missing")}>
                <span className="check__mark">
                  <Icon name={c.ok ? "check" : "cross"} />
                </span>
                <span>
                  {c.label}
                  {!c.ok && c.hint !== "" && <span className="check__hint mono">{c.hint}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("panel.troubleshooting")}>
        <p className="panel__note">{t("trouble.forceStopBody")}</p>
        <div className="actions">
          <Button size="sm" variant="destructive" disabled={!p.canForceStop} onClick={p.onForceStop}>
            {t("action.forceStop")}
          </Button>
        </div>
        <p className="panel__note">{t("trouble.lastCommand")}</p>
        {p.last === null ? (
          <p className="panel__note">{t("trouble.noCommand")}</p>
        ) : (
          <pre className="output">{`$ winvm ${p.last.verb}\n${p.last.output}`}</pre>
        )}
      </Section>
    </aside>
  )
}
