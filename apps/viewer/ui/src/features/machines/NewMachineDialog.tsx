import { useEffect, useRef, useState } from "react"

import { t } from "../../i18n"
import { nameProblem } from "./machines"

export interface NewMachine {
  readonly name: string
  /** The Windows image; null: the CLI's default. */
  readonly image: string | null
  readonly start: boolean
}

interface NewMachineDialogProps {
  readonly open: boolean
  /** The machines there are, so a taken name is caught before the CLI. */
  readonly names: readonly string[]
  /** The Windows images there are; null while they are being read. */
  readonly images: readonly string[] | null
  readonly busy: boolean
  /** What went wrong creating it, in the CLI's words. */
  readonly error: string | null
  onCreate(m: NewMachine): void
  onCancel(): void
}

/**
 * New Machine…: a name, checked as the CLI checks it; under Advanced, the
 * Windows image and whether to start it now (on). A native modal <dialog>,
 * like the confirmation dialog: top layer, focus kept inside, Esc cancels.
 */
export function NewMachineDialog(p: NewMachineDialogProps): JSX.Element | null {
  const dialog = useRef<HTMLDialogElement | null>(null)
  const [name, setName] = useState("")
  const [image, setImage] = useState<string | null>(null)
  const [start, setStart] = useState(true)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    const el = dialog.current
    if (el === null) return
    if (p.open && !el.open) {
      try {
        el.showModal()
      } catch {
        // already open
      }
    } else if (!p.open && el.open) el.close()
  }, [p.open])

  // A fresh form each time it opens.
  useEffect(() => {
    if (!p.open) return
    setName("")
    setImage(null)
    setStart(true)
    setTouched(false)
  }, [p.open])

  if (!p.open) return null
  const problem = nameProblem(name, p.names)
  const shownProblem = touched && problem !== null && problem !== "empty" ? problem : null
  const chosen = image ?? p.images?.[0] ?? null
  const cancel = (): void => {
    if (!p.busy) p.onCancel()
  }
  const submit = (): void => {
    setTouched(true)
    if (problem === null && !p.busy) p.onCreate({ name: name.trim(), image: chosen, start })
  }

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog new-machine"
      aria-labelledby="new-machine-title"
      onCancel={(e) => {
        e.preventDefault()
        cancel()
      }}
    >
      <form
        className="confirm-dialog__panel"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2 id="new-machine-title" className="confirm-dialog__title">
          {t("machine.newTitle")}
        </h2>
        <div className="confirm-dialog__body new-machine__body">
          <label className="field">
            <span className="field__label">{t("machine.nameLabel")}</span>
            <input
              className="input"
              name="name"
              value={name}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder={t("machine.namePlaceholder")}
              aria-invalid={shownProblem !== null}
              aria-describedby="new-machine-hint"
              disabled={p.busy}
              onChange={(e) => {
                setName(e.target.value)
                setTouched(true)
              }}
            />
            <span id="new-machine-hint" className={shownProblem === null ? "field__hint" : "field__hint field__hint--error"} role={shownProblem === null ? undefined : "alert"}>
              {shownProblem === null ? t("machine.nameHint") : t(`machine.name.${shownProblem}`)}
            </span>
          </label>
          <details className="new-machine__advanced">
            <summary>{t("machine.advanced")}</summary>
            <label className="field">
              <span className="field__label">{t("machine.imageLabel")}</span>
              <select className="input" name="image" value={chosen ?? ""} disabled={p.busy || p.images === null || p.images.length === 0} onChange={(e) => setImage(e.target.value)}>
                {p.images === null ? <option value="">{t("state.loading")}</option> : p.images.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>
            <label className="check-field">
              <input type="checkbox" name="start" checked={start} disabled={p.busy} onChange={(e) => setStart(e.target.checked)} />
              <span>{t("machine.startNow")}</span>
            </label>
          </details>
          {p.error !== null && (
            <p className="field__hint field__hint--error" role="alert">
              {p.error}
            </p>
          )}
        </div>
        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={cancel} disabled={p.busy}>
            {t("confirm.cancel")}
          </button>
          <button type="submit" className="btn btn--primary" disabled={p.busy || problem !== null}>
            {p.busy ? t("machine.creating") : t("machine.create")}
          </button>
        </div>
      </form>
    </dialog>
  )
}
