import { CanvasGlyph, CanvasIconButton, GLYPHS } from "@winvm/canvas"
import { type JSX, useEffect, useRef } from "react"

import { t } from "../../i18n"
import { Picture, takenAt } from "./CheckpointCard"
import { type Checkpoint, shownName } from "./checkpoints"

interface CheckpointLookProps {
  readonly c: Checkpoint
  readonly now: number
  readonly opener: HTMLElement | null
  onClose: () => void
}

export function CheckpointLook({
  c,
  now,
  opener,
  onClose,
}: CheckpointLookProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement | null>(null)
  const close = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const el = dialog.current
    if (el === null) return undefined
    if (!el.open) el.showModal()
    close.current?.focus()
    return () => {
      if (el.open) el.close()
      opener?.focus()
    }
  }, [opener])

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the close button's click bubbles here and Escape reaches this dialog as its cancel event, so every way out is already keyboard-operable
    <dialog
      ref={dialog}
      className="checkpoints__look"
      aria-label={t("checkpoints.look", { name: shownName(c) })}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={onClose}
    >
      <CanvasIconButton
        ref={close}
        className="checkpoints__look-close"
        label={t("checkpoints.lookClose")}
      >
        <CanvasGlyph>{GLYPHS.close}</CanvasGlyph>
      </CanvasIconButton>
      <Picture c={c} sharp wanted />
      <p>
        <strong>{shownName(c)}</strong> {takenAt(c, now)}
      </p>
    </dialog>
  )
}
