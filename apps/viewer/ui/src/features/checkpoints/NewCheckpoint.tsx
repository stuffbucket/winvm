import { type JSX, useEffect, useState } from "react"

import { Button } from "../../components/Button"
import { focusOnMount } from "../../components/focusOnMount"
import { t } from "../../i18n"
import { absoluteTime } from "./CheckpointCard"
import type { CheckpointFormat } from "./checkpoints"

function useMinute(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = (): void => {
      timer = setTimeout(
        () => {
          setNow(Date.now())
          next()
        },
        60_000 - (Date.now() % 60_000) + 20,
      )
    }
    next()
    return () => {
      clearTimeout(timer)
    }
  }, [active])
  return now
}

export interface NewCheckpointFormProps {
  readonly live: boolean
  readonly busy: boolean
  readonly onCancel: () => void
  readonly onSubmit: (
    title: string,
    unnamed: string,
    format: CheckpointFormat,
  ) => void
}

export function NewCheckpointForm({
  live,
  busy,
  onCancel,
  onSubmit,
}: NewCheckpointFormProps): JSX.Element {
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
      <label
        className="checkpoint-details__label"
        htmlFor="checkpoint-new-title"
      >
        {t("checkpoints.newName")}
      </label>
      <input
        id="checkpoint-new-title"
        className="input"
        ref={focusOnMount}
        value={title}
        placeholder={unnamed}
        autoComplete="off"
        maxLength={120}
        onChange={(e) => {
          setTitle(e.target.value)
        }}
      />
      <label
        className="checkpoints__compression"
        title={t("checkpoints.compressionHint")}
      >
        <input
          type="checkbox"
          checked={compressed}
          disabled={busy}
          aria-describedby="checkpoint-compression-hint"
          onChange={(e) => {
            setCompressed(e.target.checked)
          }}
        />
        {t("checkpoints.compression")}
        <span id="checkpoint-compression-hint" hidden>
          {t("checkpoints.compressionHint")}
        </span>
      </label>
      <div className="checkpoints__new-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("confirm.cancel")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!live || busy}
        >
          {t("checkpoints.take")}
        </Button>
      </div>
    </form>
  )
}
