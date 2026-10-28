import { useState } from "react"

import { revealInFinder } from "../../backend"
import { Button } from "../../components/Button"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { Icon } from "../../components/Icon"
import { OneLine } from "../../components/OneLine"
import { t } from "../../i18n"
import { homePath, needsSetup, tailToKeep } from "./folder"
import type { SharedFolderView } from "./useSharedFolder"

interface SharedFolderProps {
  readonly view: SharedFolderView
  /** Windows is up and its agent answers: the one-time setup can run. */
  readonly guestReady: boolean
}

/**
 * The panel's Shared folder: which Mac folder Windows sees, as which drive,
 * Choose folder… and Stop sharing; Windows' one-time setup when it lacks the
 * driver. A change made while Windows runs waits for its next start, and says so.
 */
export function SharedFolder({ view, guestReady }: SharedFolderProps): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const s = view.status
  const busy = view.working !== null

  if (s === null)
    return view.error === null ? <p className="panel__note">{t("state.loading")}</p> : <p className="action__error">{view.error}</p>

  if (!s.available) return <p className="panel__note">{s.reason ?? t("folder.unavailable")}</p>

  const shown = s.folder === null ? null : homePath(s.folder, view.home)
  const setup = needsSetup(s)
  const reveal = t("folder.reveal")

  return (
    <div className="action">
      {s.folder === null || shown === null ? (
        <p className="action__hint">{t("folder.body")}</p>
      ) : (
        <>
          <div className="copyable">
            <OneLine value={shown} keep={tailToKeep(shown)} />
            <button type="button" className="btn btn--ghost btn--icon" aria-label={reveal} title={reveal} onClick={() => void revealInFinder(s.folder ?? "")}>
              <Icon name="folder" />
            </button>
          </div>
          <p className="action__text">{t("folder.drive", { letter: s.letter })}</p>
          <label className="check-field">
            <input type="checkbox" checked={s.readonly} disabled={busy} onChange={(e) => view.setReadonly(e.currentTarget.checked)} />
            {t("folder.readonly")}
          </label>
        </>
      )}

      {s.pending && (
        <p className="action__hint" role="status">
          {t(s.folder === null ? "folder.pendingStop" : "folder.pending")}
        </p>
      )}
      {!s.pending && s.folder !== null && s.running && s.guest.installed === true && s.guest.mounted === false && (
        <p className="action__hint">{t("folder.notMounted", { letter: s.letter })}</p>
      )}

      <div className="action__row">
        <Button size="sm" disabled={busy} onClick={view.choose}>
          {t("folder.choose")}
        </Button>
        {s.folder !== null && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={view.stop}>
            {t("folder.stop")}
          </Button>
        )}
      </div>

      {view.working === "install" ? (
        <p className="action__hint" role="status">
          {t("folder.settingUp")}
        </p>
      ) : (
        setup && (
          <div className="action__section">
            <p className="action__hint">{t("folder.setupNeeded")}</p>
            <div className="action__row">
              <Button size="sm" variant="primary" disabled={busy || !guestReady} onClick={() => setConfirming(true)}>
                {t("folder.setup")}
              </Button>
              {!guestReady && <span className="action__hint">{t("folder.setupNeedsRunning")}</span>}
            </div>
          </div>
        )
      )}

      {view.error !== null && <p className="action__error">{view.error}</p>}

      <ConfirmDialog
        open={confirming}
        title={t("folder.setupTitle")}
        body={<p>{t("folder.setupBody")}</p>}
        confirmLabel={t("folder.setupConfirm")}
        cancelLabel={t("confirm.cancel")}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          view.install()
        }}
      />
    </div>
  )
}
