import { type JSX, useEffect, useRef } from "react"

import { t } from "../../i18n"
import { shownTitle } from "../../model"
import type { CloseChoice, CloseFlowState } from "./useCloseFlow"

interface ClosePolicyDialogProps {
  readonly state: CloseFlowState
  onChoose: (policy: CloseChoice) => void
  onRemember: (value: boolean) => void
  onCancel: () => void
}

const CHOICES = [
  { policy: "leave", key: "close.leave" },
  { policy: "stow", key: "close.stow" },
  { policy: "shutdown", key: "close.shutdown" },
] as const satisfies readonly { policy: CloseChoice; key: string }[]

export function ClosePolicyDialog({
  state,
  onChoose,
  onRemember,
  onCancel,
}: ClosePolicyDialogProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const shown =
    state.kind === "asking" || state.kind === "waiting" ? state : null
  const step =
    shown === null
      ? null
      : `${shown.kind}:${shown.machine.name}:${String(shown.index)}`

  useEffect(() => {
    const el = dialogRef.current
    if (el === null || el.open) return
    try {
      el.showModal()
    } catch {}
  }, [step])

  useEffect(() => {
    if (step !== null) cancelRef.current?.focus()
  }, [step])

  if (shown === null) return null
  const { machine, index, total } = shown

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog close-dialog"
      aria-labelledby="close-dialog-title"
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onCancel()
      }}
    >
      <div className="confirm-dialog__panel">
        <h2 id="close-dialog-title" className="confirm-dialog__title">
          {t("close.title")}
        </h2>
        <div className="confirm-dialog__body">
          <p className="close-dialog__machine">
            {shownTitle(machine.name, machine.title)}
          </p>
          {total > 1 && (
            <p className="close-dialog__progress">
              {t("close.progress", { index, total })}
            </p>
          )}
        </div>
        {shown.kind === "waiting" ? (
          <div className="confirm-dialog__body">
            <p
              className="close-dialog__operation"
              role="status"
              aria-live="polite"
            >
              {t(`operation.${shown.operation.operation}`)}
            </p>
            <p>{t("close.waiting")}</p>
          </div>
        ) : (
          <>
            <div className="close-dialog__choices">
              {CHOICES.map((c) => (
                <button
                  key={c.policy}
                  type="button"
                  className="close-dialog__choice"
                  onClick={() => {
                    onChoose(c.policy)
                  }}
                >
                  <span className="close-dialog__choice-label">{t(c.key)}</span>
                  <span className="close-dialog__choice-body">
                    {t(`${c.key}.body`)}
                  </span>
                </button>
              ))}
            </div>
            <label className="check-field">
              <input
                type="checkbox"
                name="remember-close"
                checked={shown.remember}
                onChange={(e) => {
                  onRemember(e.target.checked)
                }}
              />
              <span>{t("close.remember")}</span>
            </label>
          </>
        )}
        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost"
            onClick={onCancel}
          >
            {t("confirm.cancel")}
          </button>
        </div>
      </div>
    </dialog>
  )
}
