import { useEffect, useState } from "react"

import { Button } from "../../components/Button"
import { t } from "../../i18n"
import { absoluteTime } from "./CheckpointCard"

/** The date and time, to the minute, kept current while `active`: it changes on the minute, not each second. */
export function useMinute(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = (): void => {
      timer = setTimeout(() => {
        setNow(Date.now())
        next()
      }, 60_000 - (Date.now() % 60_000) + 20)
    }
    next()
    return () => clearTimeout(timer)
  }, [active])
  return now
}

export interface NewCheckpointFormProps {
  /** Windows is running, so a checkpoint can be taken. */
  readonly live: boolean
  readonly busy: boolean
  onCancel(): void
  /** `title` is what was typed (may be empty); `unnamed` is the name shown in the empty field, which an empty title is stored as. */
  onSubmit(title: string, unnamed: string): void
}

/**
 * The New Checkpoint dialog's form. The name field's placeholder is the name
 * the checkpoint gets if the field is left empty: the date and time, as the
 * cards say them, kept current while the dialog is open.
 */
export function NewCheckpointForm({ live, busy, onCancel, onSubmit }: NewCheckpointFormProps): JSX.Element {
  const [title, setTitle] = useState("")
  const unnamed = absoluteTime(useMinute(true))
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(title.trim(), unnamed)
      }}
    >
      <label className="checkpoint-details__label" htmlFor="checkpoint-new-title">
        {t("checkpoints.newName")}
      </label>
      <input
        id="checkpoint-new-title"
        className="input"
        autoFocus
        value={title}
        placeholder={unnamed}
        autoComplete="off"
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="checkpoints__new-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("confirm.cancel")}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!live || busy}>
          {t("checkpoints.take")}
        </Button>
      </div>
    </form>
  )
}
