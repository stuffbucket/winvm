import { useEffect, useRef } from "react"

import { Button } from "../../components/Button"
import { t } from "../../i18n"

interface ReferenceDialogProps {
  /** The CLI's own usage text, from `winvm help`; null while it loads. */
  readonly text: string | null
  onClose(): void
}

/** Help → winvm Command Reference: every command the CLI has, as it describes them. */
export function ReferenceDialog({ text, onClose }: ReferenceDialogProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const el = dialog.current
    if (el !== null && !el.open) el.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog reference"
      aria-labelledby="reference-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === dialog.current) onClose()
      }}
    >
      <div className="confirm-dialog__panel">
        <h2 className="confirm-dialog__title" id="reference-title">
          {t("reference.title")}
        </h2>
        <p className="confirm-dialog__body">{t("reference.body")}</p>
        <pre className="output reference__text">{text ?? t("state.loading")}</pre>
        <div className="confirm-dialog__actions">
          <Button variant="primary" onClick={onClose}>
            {t("reference.close")}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
