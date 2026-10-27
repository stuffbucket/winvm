import { Button } from "../../components/Button"
import { Icon, type IconName } from "../../components/Icon"
import { cx } from "../../components/cx"
import { t } from "../../i18n"
import type { Phase, Status, Step } from "../../model"
import { facts } from "../../model"

interface OverviewProps {
  readonly phase: Phase | null
  readonly status: Status | null
  readonly steps: readonly Step[] | null
  readonly canStart: boolean
  onStart(): void
}

// The same glyphs as their toolbar buttons, so each reads as "that button".
const ABILITIES: readonly { icon: IconName; key: string }[] = [
  { icon: "terminal", key: "ability.exec" },
  { icon: "folder", key: "ability.files" },
  { icon: "history", key: "ability.saves" },
  { icon: "agent", key: "ability.agent" },
]

function Steps({ steps }: { readonly steps: readonly Step[] }): JSX.Element {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.key} className={cx("step", `step--${s.state}`)} aria-current={s.state === "current" ? "step" : undefined}>
          <span className="step__mark" aria-hidden="true">
            {s.state === "done" && <Icon name="check" />}
          </span>
          {t(s.key)}
        </li>
      ))}
    </ol>
  )
}

/** What fills the display while there is no screen: the state, what the instance is, Start, and what it does once on. */
export function Overview(p: OverviewProps): JSX.Element {
  if (p.steps !== null) {
    return (
      <div className="overview">
        <div className="overview__content">
          <h1 className="overview__title">{t("overview.starting.title")}</h1>
          <Steps steps={p.steps} />
        </div>
      </div>
    )
  }
  if (p.phase === null || p.phase === "running" || p.phase === "starting" || p.phase === "paused") {
    return (
      <div className="overview overview--quiet">
        <div className="overview__content">
          <p className="overview__note" role="status">
            {p.phase === null ? t("state.loading") : t("overview.connecting")}
          </p>
        </div>
      </div>
    )
  }

  const which = p.phase === "missing" || p.phase === "stowed" ? p.phase : "stopped"
  const rows = p.status === null ? [] : facts(p.status)
  return (
    <div className="overview">
      <div className="overview__content">
        <h1 className="overview__title">{t(`overview.${which}.title`)}</h1>
        {which === "stowed" && <p className="overview__note">{t("overview.stowed.body")}</p>}
        {rows.length > 0 && (
          <dl className="facts">
            {rows.map((r) => (
              <div className="fact" key={r.key}>
                <dt>{t(r.key)}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="actions">
          <Button variant="primary" disabled={!p.canStart} onClick={p.onStart}>
            <Icon name="play" />
            {t(which === "missing" ? "action.setUp" : "action.startWindows")}
          </Button>
        </div>
        {which === "missing" && (
          <p className="overview__note">
            {t("overview.missing.noImage")} <code className="mono">winvm build --iso &lt;Windows 11 ISO&gt;</code>
          </p>
        )}
        <section className="abilities" aria-labelledby="abilities-title">
          <h2 className="abilities__title" id="abilities-title">
            {t("abilities.title")}
          </h2>
          <ul className="abilities__list">
            {ABILITIES.map((a) => (
              <li key={a.key} className="ability">
                <span className="ability__icon" aria-hidden="true">
                  <Icon name={a.icon} />
                </span>
                {t(a.key)}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
