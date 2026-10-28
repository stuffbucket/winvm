import { useEffect, useRef, useState } from "react"

import { SpatialCanvasSidePanel } from "@winvm/canvas"

import { Button } from "../../components/Button"
import { t } from "../../i18n"
import { formatSize, type SaveNotes } from "../../model"
import { type Checkpoint, deleteBlocked, incompatibleReason, shownName } from "./checkpoints"
import { kindLabel, Picture, takenAt } from "./CheckpointCard"

export interface NoteDraft {
  readonly title: string
  readonly text: string
  readonly tags: string
}

export const draftOf = (n: SaveNotes | null): NoteDraft => ({ title: n?.title ?? "", text: n?.text ?? "", tags: (n?.tags ?? []).join(", ") })

/** A draft as `winvm saves note` takes it: tags split at commas. */
export const tagsOf = (s: string): string[] => [...new Set(s.split(",").map((x) => x.trim()).filter((x) => x !== ""))]

const sameDraft = (a: NoteDraft, b: NoteDraft): boolean => a.title.trim() === b.title.trim() && a.text === b.text && tagsOf(a.tags).join(",") === tagsOf(b.tags).join(",")

interface DetailsProps {
  readonly c: Checkpoint
  readonly now: number
  /** Something is running (a save, a load, a start…): the actions wait. */
  readonly busy: boolean
  readonly saving: "idle" | "saving" | "saved" | "failed"
  onClose(): void
  /** Show the screenshot as big as the window allows. */
  onLook(): void
  onNote(draft: NoteDraft): void
  onGoBack(): void
  onDelete(): void
}

/** How long typing has to pause before a note is written. */
const NOTE_DEBOUNCE_MS = 700

/**
 * The selected checkpoint, up close: a larger screenshot, its notes (a
 * title, markdown text and tags, written as they are typed), what it is, and
 * the two things to do with it.
 */
export function CheckpointDetails({ c, now, busy, saving, onClose, onLook, onNote, onGoBack, onDelete }: DetailsProps): JSX.Element {
  const [draft, setDraft] = useState(() => draftOf(c.notes))
  const written = useRef(draftOf(c.notes))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ draft, onNote })
  latest.current = { draft, onNote }

  // Another checkpoint: start from its notes.
  useEffect(() => {
    const d = draftOf(c.notes)
    setDraft(d)
    written.current = d
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.name, c.createdAt])

  const flush = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const d = latest.current.draft
    if (sameDraft(d, written.current)) return
    written.current = d
    latest.current.onNote(d)
  }
  // Leaving the checkpoint (or the view) keeps what was typed.
  useEffect(() => flush, [c.name])

  const edit = (patch: Partial<NoteDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(flush, NOTE_DEBOUNCE_MS)
  }

  const reason = incompatibleReason(c)
  const blocked = deleteBlocked(c)
  const name = shownName(c)
  return (
    <SpatialCanvasSidePanel
      className="checkpoint-details"
      label={t("checkpoints.details", { name })}
      title={name}
      closeLabel={t("checkpoints.closeDetails")}
      onClose={onClose}
      footer={
        <footer className="checkpoint-details__actions">
          <span className="checkpoint-details__saved" role="status">
            {saving === "saving" ? t("checkpoints.note.saving") : saving === "saved" ? t("checkpoints.note.saved") : saving === "failed" ? t("checkpoints.note.failed") : ""}
          </span>
          <Button size="sm" variant="ghost" className="checkpoint-details__delete" disabled={busy || blocked !== null} title={blocked === null ? undefined : t(blocked)} onClick={onDelete}>
            {t("checkpoints.delete")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy || reason !== null} title={reason === null ? t("checkpoints.goBackTip") : t(reason)} onClick={onGoBack}>
            {t("checkpoints.goBack")}
          </Button>
        </footer>
      }
    >
      <button type="button" className="checkpoint-details__picture" title={t("checkpoints.lookTip")} onClick={onLook}>
        <Picture c={c} sharp wanted />
      </button>
      {reason !== null && <p className="checkpoint-details__reason">{t(reason)}</p>}
      <label className="checkpoint-details__label" htmlFor="checkpoint-title">
        {t("checkpoints.note.title")}
      </label>
      <input
        id="checkpoint-title"
        className="input"
        value={draft.title}
        placeholder={c.name}
        autoComplete="off"
        spellCheck={false}
        maxLength={120}
        onChange={(e) => edit({ title: e.target.value })}
        onBlur={flush}
      />
      <label className="checkpoint-details__label" htmlFor="checkpoint-text">
        {t("checkpoints.note.text")}
      </label>
      <textarea
        id="checkpoint-text"
        className="input checkpoint-details__text"
        value={draft.text}
        placeholder={t("checkpoints.note.textPlaceholder")}
        rows={6}
        onChange={(e) => edit({ text: e.target.value })}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            flush()
          }
        }}
      />
      <label className="checkpoint-details__label" htmlFor="checkpoint-tags">
        {t("checkpoints.note.tags")}
      </label>
      <input
        id="checkpoint-tags"
        className="input"
        value={draft.tags}
        placeholder={t("checkpoints.note.tagsPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => edit({ tags: e.target.value })}
        onBlur={flush}
      />
      {c.note !== undefined && c.note !== "" && <p className="checkpoint-details__manifest-note">{t("checkpoints.note.taken", { note: c.note })}</p>}
      <dl className="kv checkpoint-details__facts">
        <div className="kv__row">
          <dt>{t("checkpoints.fact.taken")}</dt>
          <dd>{takenAt(c, now)}</dd>
        </div>
        <div className="kv__row">
          <dt>{t("checkpoints.fact.kind")}</dt>
          <dd>{kindLabel(c.kind)}</dd>
        </div>
        <div className="kv__row">
          <dt>{t("checkpoints.fact.size")}</dt>
          <dd>{formatSize(c.bytes)}</dd>
        </div>
        <div className="kv__row">
          <dt>{t("checkpoints.fact.loads")}</dt>
          <dd>{c.compatible === null ? t("checkpoints.loads.unknown") : c.compatible ? t("checkpoints.loads.yes") : t("checkpoints.loads.no")}</dd>
        </div>
        <div className="kv__row">
          <dt>{t("checkpoints.fact.name")}</dt>
          <dd className="mono">{c.name}</dd>
        </div>
      </dl>
    </SpatialCanvasSidePanel>
  )
}
