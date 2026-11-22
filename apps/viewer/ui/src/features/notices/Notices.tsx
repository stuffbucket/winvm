import type { JSX } from "react"

import type { CloseSession } from "../../backend"
import { Button } from "../../components/Button"
import { Callout } from "../../components/Callout"
import { t } from "../../i18n"
import { type Checks, RESTORED_BUSY } from "../../model"
import { SessionEndNote } from "../close/SessionEndNote"
import type { CopyJob, CopyResult } from "../files/useCopies"
import type { Ran } from "../winvm/useWinvm"

export interface Notice {
  readonly tone: "notice" | "error"
  readonly title: string
  readonly detail?: string
}

export interface NoticesProps {
  readonly failure: Ran | null
  readonly session: CloseSession | null
  readonly closeFailed: { readonly message: string } | null
  readonly finding: string | null
  readonly notice: Notice | null
  readonly copyJob: CopyJob | null
  readonly copyResult: CopyResult | null
  readonly checks: Checks | null
  readonly operating: boolean
  readonly statusError: string | null
  onDismissFailure: () => void
  onDismissCloseFailed: () => void
  onDismissNotice: () => void
  onDismissCopy: () => void
  onReveal: (path: string) => void
  onSetup: () => void
}

function Dismiss({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      {t("action.dismiss")}
    </Button>
  )
}

export function Notices(p: NoticesProps): JSX.Element | null {
  const missing = p.checks?.checks.filter((x) => !x.ok) ?? []
  const runtimeMissing = missing.some((x) => x.hint === "winvm setup")
  const notReady = p.checks !== null && !p.checks.ready
  const result = p.copyJob === null ? p.copyResult : null
  if (
    p.failure === null &&
    p.closeFailed === null &&
    p.session === null &&
    p.finding === null &&
    p.notice === null &&
    p.copyJob === null &&
    result === null &&
    !notReady &&
    p.statusError === null
  )
    return null
  return (
    <div className="notices">
      {p.failure !== null && (
        <Callout
          tone={p.failure.code === RESTORED_BUSY ? "notice" : "error"}
          title={
            p.failure.code === RESTORED_BUSY
              ? t("notice.restoredBusy")
              : t(`error.${p.failure.verb}`)
          }
          action={<Dismiss onClick={p.onDismissFailure} />}
        >
          <pre className="output">{p.failure.output}</pre>
        </Callout>
      )}
      {p.session !== null && (
        <Callout tone="notice" title={t("close.sessionTitle")}>
          <SessionEndNote session={p.session} />
        </Callout>
      )}
      {p.closeFailed !== null && (
        <Callout
          tone="error"
          title={t("close.failed")}
          action={<Dismiss onClick={p.onDismissCloseFailed} />}
        >
          {p.closeFailed.message !== p.failure?.output && (
            <pre className="output">{p.closeFailed.message}</pre>
          )}
        </Callout>
      )}
      {p.finding !== null && (
        <Callout
          tone="notice"
          title={t("files.finder.opening", { place: p.finding })}
        >
          <p>{t("files.finder.firstTime")}</p>
        </Callout>
      )}
      {p.notice !== null && (
        <Callout
          tone={p.notice.tone}
          title={p.notice.title}
          action={<Dismiss onClick={p.onDismissNotice} />}
        >
          {p.notice.detail !== undefined && (
            <pre className="output">{p.notice.detail}</pre>
          )}
        </Callout>
      )}
      {p.copyJob !== null && (
        <Callout
          tone="notice"
          title={t("files.copying", { name: p.copyJob.name })}
        >
          {p.copyJob.total > 1 && (
            <p>
              {t("files.ofTotal", {
                done: p.copyJob.done + 1,
                total: p.copyJob.total,
              })}
            </p>
          )}
        </Callout>
      )}
      {result !== null && (
        <Callout
          tone={result.ok ? "notice" : "error"}
          title={result.title}
          action={
            result.reveal !== undefined ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  p.onReveal(result.reveal ?? "")
                }}
              >
                {t("files.reveal")}
              </Button>
            ) : (
              <Dismiss onClick={p.onDismissCopy} />
            )
          }
        >
          {result.detail !== undefined && (
            <pre className="output">{result.detail}</pre>
          )}
        </Callout>
      )}
      {notReady && (
        <Callout
          tone="error"
          title={t("host.notReady")}
          action={
            runtimeMissing ? (
              <Button
                size="sm"
                variant="primary"
                disabled={p.operating}
                onClick={p.onSetup}
              >
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
      {p.statusError !== null && (
        <Callout tone="error" title={t("error.status")}>
          <pre className="output">{p.statusError}</pre>
        </Callout>
      )}
    </div>
  )
}
