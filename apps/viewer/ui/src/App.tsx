import type { CSSProperties } from "react"
import { useEffect, useState } from "react"

import { showWindow } from "./backend"
import { Button } from "./components/Button"
import { Callout } from "./components/Callout"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { cx } from "./components/cx"
import { t } from "./i18n"
import type { Phase } from "./model"
import { controls, displaySize, startSteps } from "./model"
import { Overview } from "./features/overview/Overview"
import { Panel } from "./features/panel/Panel"
import { Screen } from "./features/screen/Screen"
import { Toolbar } from "./features/toolbar/Toolbar"
import type { Verb } from "./features/winvm/useWinvm"
import { useWinvm } from "./features/winvm/useWinvm"

type Confirm = "stop" | "reboot" | "kill"

const CONFIRM_ACTION: Record<Confirm, string> = { stop: "action.shutDown", reboot: "action.restart", kill: "action.forceStop" }

const isLive = (p: Phase | null): boolean => p === "running" || p === "starting" || p === "paused"

export function App(): JSX.Element {
  const w = useWinvm()
  const [fit, setFit] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [startedFrom, setStartedFrom] = useState<Phase | null>(null)

  // A hidden window gets no animation frames, so show it straight after the first commit.
  useEffect(() => showWindow(), [])

  const phase = w.phase
  const live = isLive(phase)
  const hostReady = w.checks === null || w.checks.ready
  const c = controls(phase ?? "missing", w.busy !== null || phase === null || !hostReady)
  const missing = w.checks?.checks.filter((x) => !x.ok) ?? []
  const runtimeMissing = missing.some((x) => x.hint === "winvm setup")
  const display = displaySize(w.status?.screen ?? null)
  const showScreen = live && w.connection !== null
  const steps = w.busy === "start" && !showScreen ? startSteps(startedFrom === "missing", w.status) : null

  const run = (verb: Verb): void => {
    if (verb === "start") setStartedFrom(phase)
    void w.act(verb)
  }

  const frame = { "--display-ratio": String(display.width / display.height) } as CSSProperties

  return (
    <div className="viewer" data-busy={w.busy !== null}>
      <div className="busybar" aria-hidden="true" />
      <Toolbar
        names={w.names}
        name={w.name}
        phase={phase}
        busyLabel={w.busy === null ? null : t(`busy.${w.busy}`)}
        controls={c}
        fit={fit}
        panelOpen={panelOpen}
        onSelect={w.select}
        onStart={() => run("start")}
        onShutDown={() => setConfirm("stop")}
        onRestart={() => setConfirm("reboot")}
        onPause={() => run("pause")}
        onResume={() => run("resume")}
        onFit={() => setFit((f) => !f)}
        onScreenSharing={() => void w.openScreenSharing()}
        onPanel={() => setPanelOpen((o) => !o)}
      />

      <div className="stage">
        <div className="display-area">
          {w.failure !== null && (
            <Callout
              tone="error"
              title={t(`error.${w.failure.verb}`)}
              action={
                <Button size="sm" variant="ghost" onClick={w.dismissFailure}>
                  {t("action.dismiss")}
                </Button>
              }
            >
              <pre className="output">{w.failure.output}</pre>
            </Callout>
          )}
          {w.checks !== null && !w.checks.ready && (
            <Callout
              tone="error"
              title={t("host.notReady")}
              action={
                runtimeMissing ? (
                  <Button size="sm" variant="primary" disabled={w.busy !== null} onClick={() => run("setup")}>
                    {t("action.setup")}
                  </Button>
                ) : undefined
              }
            >
              {missing.map((x) =>
                x.hint === "winvm setup" ? (
                  <p key={x.label}>{t("host.runtimeMissing")}</p>
                ) : (
                  <p key={x.label}>
                    {x.label} <span className="mono">{x.hint}</span>
                  </p>
                ),
              )}
            </Callout>
          )}
          {w.statusError !== null && (
            <Callout tone="error" title={t("error.status")}>
              <pre className="output">{w.statusError}</pre>
            </Callout>
          )}

          <div className="display-fit">
            <div className={cx("display", showScreen && "display--on", showScreen && !fit && "display--actual")} style={frame}>
              {showScreen && w.connection !== null ? (
                <Screen connection={w.connection} fit={fit} />
              ) : (
                <Overview phase={phase} status={w.status} steps={steps} canStart={c.start} onStart={() => run("start")} />
              )}
              {!showScreen && (
                <span className="display__size mono" aria-hidden="true">
                  {t("display.size", { width: display.width, height: display.height })}
                </span>
              )}
            </div>
          </div>
        </div>

        {panelOpen && (
          <Panel
            status={w.status}
            checks={w.checks}
            checksError={w.checksError}
            last={w.last}
            cliPath={w.cliPath}
            canForceStop={live && w.busy === null}
            onInstallCommand={() => void w.installCommand()}
            onForceStop={() => setConfirm("kill")}
          />
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === null ? "" : t(`confirm.${confirm}.title`)}
        body={confirm === null ? "" : <p>{t(`confirm.${confirm}.body`)}</p>}
        confirmLabel={confirm === null ? "" : t(CONFIRM_ACTION[confirm])}
        cancelLabel={t("confirm.cancel")}
        tone={confirm === "reboot" ? "default" : "danger"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const verb = confirm
          setConfirm(null)
          if (verb !== null) run(verb)
        }}
      />
    </div>
  )
}
