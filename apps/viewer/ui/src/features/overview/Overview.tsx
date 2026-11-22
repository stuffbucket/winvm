import type { JSX } from "react"
import { Button } from "../../components/Button"
import { cx } from "../../components/cx"
import { Icon } from "../../components/Icon"
import { t } from "../../i18n"
import type { Phase, Status, Step } from "../../model"
import { facts } from "../../model"
import { Abilities } from "../help/Abilities"
import { MachineHeading, TITLE_MARK } from "../machines/MachineHeading"
import { Backdrop } from "./Backdrop"
import { useBackdropPicture } from "./backdropPicture"
import { MachineNotes } from "./MachineNotes"

interface OverviewProps {
  readonly instance?: string | null
  readonly title?: string | undefined
  readonly hasTitle?: boolean | undefined
  onRename?: ((title: string) => Promise<string | null>) | undefined
  readonly phase: Phase | null
  readonly status: Status | null
  readonly steps: readonly Step[] | null
  readonly canStart: boolean
  onStart: () => void
}

function Steps({ steps }: { readonly steps: readonly Step[] }): JSX.Element {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li
          key={s.key}
          className={cx("step", `step--${s.state}`)}
          aria-current={s.state === "current" ? "step" : undefined}
        >
          <span className="step__mark" aria-hidden="true">
            {s.state === "done" && <Icon name="check" />}
          </span>
          {t(s.key)}
        </li>
      ))}
    </ol>
  )
}

export function Overview(p: OverviewProps): JSX.Element {
  const suspended = p.steps === null && p.phase === "stowed"
  const picture = useBackdropPicture(p.instance ?? null, suspended)
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
  if (
    p.phase === null ||
    p.phase === "running" ||
    p.phase === "starting" ||
    p.phase === "paused" ||
    p.phase === "asleep"
  ) {
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

  const which =
    p.phase === "missing" || p.phase === "stowed" ? p.phase : "stopped"
  const rows = p.status === null ? [] : facts(p.status)
  const heading =
    which === "missing" ? (
      <h1 className="overview__title">{t("overview.missing.title")}</h1>
    ) : (
      <MachineHeading
        key={p.instance ?? ""}
        text={t(`overview.${which}.title`, { title: TITLE_MARK })}
        shown={p.title ?? p.instance ?? ""}
        hasTitle={p.hasTitle === true}
        {...(p.onRename === undefined ? {} : { onRename: p.onRename })}
      />
    )
  return (
    <div className={cx("overview", which === "stowed" && "overview--notes")}>
      {which === "stowed" && <Backdrop picture={picture} />}
      <div className="overview__content">
        {which === "stowed" ? (
          <MachineNotes instance={p.instance ?? null} heading={heading} />
        ) : (
          heading
        )}
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
            {t("overview.missing.noImage")}{" "}
            <code className="mono">
              winvm build --iso &lt;Windows 11 ISO&gt;
            </code>
          </p>
        )}
        <Abilities phase={p.phase} />
      </div>
    </div>
  )
}
