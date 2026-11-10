import { useEffect, useState } from "react"

import { Button } from "../../components/Button"
import { t } from "../../i18n"
import { absoluteTime } from "./CheckpointCard"
import type { CheckpointFormat } from "./checkpoints"

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
  /**
   * `title` is what was typed (may be empty); `unnamed` is the name shown in
   * the empty field, which an empty title is stored as. `format` is how its
   * memory is written: compressed (zstd) by default, else mapped-ram.
   */
  onSubmit(title: string, unnamed: string, format: CheckpointFormat): void
}

/**
 * The New Checkpoint dialog's form. The name field's placeholder is the name
 * the checkpoint gets if the field is left empty: the date and time, as the
 * cards say them, kept current while the dialog is open.
 */
export function NewCheckpointForm({ live, busy, onCancel, onSubmit }: NewCheckpointFormProps): JSX.Element {
  const [title, setTitle] = useState("")
  const [compressed, setCompressed] = useState(true)
  const unnamed = absoluteTime(useMinute(true))
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(title.trim(), unnamed, compressed ? "zstd" : "mapped")
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
      {/* What it trades is its tooltip and accessible description, not another line in the form. */}
      <label className="checkpoints__compression" title={t("checkpoints.compressionHint")}>
        <input type="checkbox" checked={compressed} disabled={busy} aria-describedby="checkpoint-compression-hint" onChange={(e) => setCompressed(e.target.checked)} />
        {t("checkpoints.compression")}
        <span id="checkpoint-compression-hint" hidden>
          {t("checkpoints.compressionHint")}
        </span>
      </label>
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
