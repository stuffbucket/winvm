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

const ABILITIES: readonly { icon: IconName; key: string; commands: readonly string[] }[] = [
  { icon: "terminal", key: "ability.exec", commands: ["winvm exec -- <command>"] },
  { icon: "folder", key: "ability.files", commands: ["winvm put", "winvm get"] },
  { icon: "history", key: "ability.saves", commands: ["winvm save", "winvm load"] },
  { icon: "agent", key: "ability.agent", commands: ["winvm cua"] },
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

/** What fills the display while there is no screen: the state, what it is, how to start it, and what else it does. */
export function Overview(p: OverviewProps): JSX.Element {
  if (p.steps !== null) {
    return (
      <div className="overview">
        <div className="overview__content">
          <h1 className="overview__title">{t("overview.starting.title")}</h1>
          <p className="overview__body">{t("overview.starting.body")}</p>
          <Steps steps={p.steps} />
        </div>
      </div>
    )
  }
  if (p.phase === null || p.phase === "running" || p.phase === "starting" || p.phase === "paused") {
    return (
      <div className="overview overview--quiet">
        <div className="overview__content">
          <p className="overview__body muted" role="status">
            {p.phase === null ? t("state.loading") : t("overview.connecting")}
          </p>
        </div>
      </div>
    )
  }

  const which = p.phase === "missing" || p.phase === "stowed" ? p.phase : "stopped"
  const line = p.status === null ? [] : facts(p.status).map((f) => t(f.key, f.values))
  return (
    <div className="overview">
      <div className="overview__content">
        <h1 className="overview__title">{t(`overview.${which}.title`)}</h1>
        <p className="overview__body">{t(`overview.${which}.body`)}</p>
        {line.length > 0 && <p className="overview__facts">{line.join(" · ")}</p>}
        <div className="actions">
          <Button variant="primary" disabled={!p.canStart} onClick={p.onStart}>
            <Icon name="play" />
            {t("action.startWindows")}
          </Button>
        </div>
        {which === "missing" && (
          <p className="overview__hint">
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
                <span className="ability__text">
                  {t(a.key)}
                  <span className="ability__commands mono">{a.commands.join("  ·  ")}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
