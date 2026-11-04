import { Button } from "../../components/Button"
import { Icon } from "../../components/Icon"
import { cx } from "../../components/cx"
import { t } from "../../i18n"
import type { Phase, Status, Step } from "../../model"
import { facts } from "../../model"
import { Abilities } from "../help/Abilities"
import { MachineHeading, TITLE_MARK } from "../machines/MachineHeading"
import { Backdrop } from "./Backdrop"
import { useBackdropPicture } from "./backdropPicture"
import { MachineNotes } from "./MachineNotes"

interface OverviewProps {
  /** The machine shown: whose note and picture a suspended one has. */
  readonly instance?: string | null
  /** What the machine is called: its title, else its name (instance). */
  readonly title?: string
  /** It has a title of its own, so clearing the field in its heading gives the name back. */
  readonly hasTitle?: boolean
  /** Sets the machine's title (empty clears it); resolves with why it couldn't, or null. Absent: the heading's name can't be edited. */
  onRename?(title: string): Promise<string | null>
  readonly phase: Phase | null
  readonly status: Status | null
  readonly steps: readonly Step[] | null
  readonly canStart: boolean
  onStart(): void
}

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
  if (p.phase === null || p.phase === "running" || p.phase === "starting" || p.phase === "paused" || p.phase === "asleep") {
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
  // Off and suspended machines say which machine, and the name can be changed where it stands.
  const heading =
    which === "missing" ? (
      <h1 className="overview__title">{t("overview.missing.title")}</h1>
    ) : (
      <MachineHeading
        key={p.instance ?? ""}
        text={t(`overview.${which}.title`, { title: TITLE_MARK })}
        shown={p.title ?? p.instance ?? ""}
        hasTitle={p.hasTitle === true}
        onRename={p.onRename}
      />
    )
  return (
    <div className={cx("overview", which === "stowed" && "overview--notes")}>
      {which === "stowed" && <Backdrop picture={picture} />}
      <div className="overview__content">
        {which === "stowed" ? <MachineNotes instance={p.instance ?? null} heading={heading} /> : heading}
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
        <Abilities />
      </div>
    </div>
  )
}
