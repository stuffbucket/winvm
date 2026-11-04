import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { SpatialCanvasSidePanel } from "@winvm/canvas"

import { Button } from "../../components/Button"
import { Icon } from "../../components/Icon"
import { t } from "../../i18n"
import { formatSize, type SaveNotes } from "../../model"
import { titleEdit } from "../machines/machines"
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

/** The longest title a checkpoint takes. */
export const CHECKPOINT_TITLE_MAX = 120

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/

/** Why a typed title can't be kept: too long, or not one line of plain text. Empty is fine (it clears the title). */
export function checkpointTitleProblem(title: string): "long" | "control" | null {
  const typed = title.trim()
  if ([...typed].length > CHECKPOINT_TITLE_MAX) return "long"
  if (CONTROL.test(typed)) return "control"
  return null
}

const problemText = (typed: string): string | null => {
  switch (checkpointTitleProblem(typed)) {
    case "long":
      return t("machine.title.long", { max: CHECKPOINT_TITLE_MAX })
    case "control":
      return t("machine.title.control")
    default:
      return null
  }
}

/** The short label for why a checkpoint can't load here: `checkpoints.incompatible.qemu` → `checkpoints.incompatibleShort.qemu`. */
export const shortReason = (reasonKey: string): string => reasonKey.replace("checkpoints.incompatible.", "checkpoints.incompatibleShort.")

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
 * The checkpoint's title, editable where it stands (the machine's name is, in
 * its heading). At rest it is a button that reads as text, a quiet fill on
 * hover; a click, Return or F2 turns it into a field of the same size and
 * face, selected. Return or leaving the field keeps what was typed, Escape
 * puts the title back; one that can't be kept says why under it and stays.
 */
function InlineTitle({ shown, hasTitle, name, onCommit }: { readonly shown: string; readonly hasTitle: boolean; readonly name: string; onCommit(title: string): void }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shown)
  const [message, setMessage] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const giveFocusBack = useRef(false)
  const ended = useRef(false)
  const endedAt = useRef(0)
  const ids = useId()

  useEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    } else if (giveFocusBack.current) {
      giveFocusBack.current = false
      button.current?.focus()
    }
  }, [editing])

  // F2 anywhere in the view (not typing) starts it, as it does on a tab's name.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "F2" || e.defaultPrevented || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.target instanceof Element && e.target.closest("dialog") !== null) return
      e.preventDefault()
      button.current?.focus()
      button.current?.click()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const start = (): void => {
    ended.current = false
    setDraft(shown)
    setMessage(null)
    setEditing(true)
  }
  const end = (focus: boolean): void => {
    ended.current = true
    endedAt.current = Date.now()
    giveFocusBack.current = focus
    setMessage(null)
    setEditing(false)
  }
  const commit = (typed: string, focus: boolean): void => {
    if (ended.current) return
    const problem = problemText(typed)
    if (problem !== null) {
      // Return says why and stays; leaving the field is a change of mind.
      if (focus) setMessage(problem)
      else end(false)
      return
    }
    const what = titleEdit(typed, shown, hasTitle)
    if (what !== "none") onCommit(what === "clear" ? "" : typed.trim())
    end(focus)
  }
  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.stopPropagation()
      commit(e.currentTarget.value, true)
    } else if (e.key === "Escape") {
      // Esc puts the title back; it is not also Esc to close the panel.
      e.stopPropagation()
      end(true)
    }
  }

  const hintId = `${ids}-hint`
  const messageId = `${ids}-message`
  const emptyHint = editing && draft.trim() === "" && message === null && hasTitle ? t("checkpoints.title.empty", { name }) : null
  return (
    <div className="checkpoint-details__title">
      {editing ? (
        <input
          ref={input}
          className="checkpoint-details__title-field checkpoint-details__title-field--editing"
          type="text"
          value={draft}
          aria-label={t("checkpoints.note.title")}
          aria-invalid={message !== null}
          aria-describedby={message === null ? undefined : messageId}
          placeholder={name}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setDraft(e.target.value)
            setMessage(problemText(e.target.value))
          }}
          onKeyDown={onFieldKeyDown}
          onBlur={(e) => commit(e.currentTarget.value, false)}
        />
      ) : (
        <button
          ref={button}
          type="button"
          className="checkpoint-details__title-field"
          title={t("checkpoints.title.tip")}
          aria-describedby={hintId}
          onClick={(e) => {
            // The Return that kept the title can land on the button the focus has just gone back to,
            // and WebKit clicks it; a click from the keyboard that soon is that.
            if (e.detail === 0 && Date.now() - endedAt.current < 400) return
            start()
          }}
          onKeyDown={(e) => {
            if (e.key === "F2") {
              e.preventDefault()
              e.stopPropagation()
              start()
            }
          }}
        >
          {shown}
        </button>
      )}
      <span id={hintId} hidden>
        {t("checkpoints.title.hint")}
      </span>
      {(message !== null || emptyHint !== null) && (
        <p className="checkpoint-details__problem" id={messageId} role={message === null ? "status" : "alert"} data-tone={message === null ? "quiet" : "error"}>
          {message ?? emptyHint}
        </p>
      )}
    </div>
  )
}

/**
 * The selected checkpoint, up close: its title (edited where it stands), a
 * larger screenshot, its note (written as it is typed), what it is, and the
 * two things to do with it.
 */
export function CheckpointDetails({ c, now, busy, saving, onClose, onLook, onNote, onGoBack, onDelete }: DetailsProps): JSX.Element {
  const [draft, setDraft] = useState(() => draftOf(c.notes))
  const written = useRef(draftOf(c.notes))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ draft, onNote })
  latest.current = { draft, onNote }
  const noteField = useRef<HTMLTextAreaElement>(null)
  // What a field held when it took focus: Esc puts it back.
  const startedWith = useRef("")
  const reasonId = useId()

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
  /** A change that is final (a title kept): written now, not after a pause. */
  const keep = (patch: Partial<NoteDraft>): void => {
    const d = { ...latest.current.draft, ...patch }
    latest.current.draft = d
    setDraft(d)
    flush()
  }

  // The note grows with what is in it, up to the CSS's max-height, then scrolls.
  useLayoutEffect(() => {
    const el = noteField.current
    if (el === null) return
    el.style.height = "auto"
    if (el.scrollHeight > 0) el.style.height = `${String(el.scrollHeight)}px`
  }, [draft.text, c.name])

  /** Esc in a note field: put back what it held when it was focused, keep that, and leave the field. */
  const escapeTo = (field: "text" | "tags") => (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Escape") {
      e.stopPropagation()
      keep({ [field]: startedWith.current })
      e.currentTarget.blur()
    } else if (e.key === "Enter" && field === "tags") {
      e.stopPropagation()
      flush()
      e.currentTarget.blur()
    } else if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      flush()
    }
  }

  const reason = incompatibleReason(c)
  const blocked = deleteBlocked(c)
  const name = shownName(c)
  // The title typed here, else the one the save came with, else its name.
  const shown = draft.title.trim() !== "" ? draft.title.trim() : (c.title ?? c.name)
  return (
    <SpatialCanvasSidePanel
      className="checkpoint-details"
      label={t("checkpoints.details", { name })}
      title={name}
      closeLabel={t("checkpoints.closeDetails")}
      onClose={onClose}
      header={<InlineTitle shown={shown} hasTitle={draft.title.trim() !== ""} name={c.name} onCommit={(title) => keep({ title })} />}
      footer={
        <footer className="checkpoint-details__actions">
          <Button size="sm" variant="ghost" className="checkpoint-details__delete" disabled={busy || blocked !== null} title={blocked === null ? undefined : t(blocked)} onClick={onDelete}>
            <Icon name="trash" />
            {t("checkpoints.delete")}
          </Button>
          <span className="checkpoint-details__saved" role="status" data-failed={saving === "failed"}>
            {saving === "saving" ? t("checkpoints.note.saving") : saving === "saved" ? t("checkpoints.note.saved") : saving === "failed" ? t("checkpoints.note.failed") : ""}
          </span>
          <Button size="sm" variant="primary" disabled={busy || reason !== null} title={reason === null ? t("checkpoints.goBackTip") : t(reason)} onClick={onGoBack}>
            <Icon name="history" />
            {t("checkpoints.goBack")}
          </Button>
        </footer>
      }
    >
      <button type="button" className="checkpoint-details__picture" title={t("checkpoints.lookTip")} onClick={onLook}>
        <Picture c={c} sharp wanted />
      </button>
      <textarea
        ref={noteField}
        className="checkpoint-details__text"
        value={draft.text}
        aria-label={t("checkpoints.note.text")}
        placeholder={t("checkpoints.note.textPlaceholder")}
        rows={2}
        onFocus={() => {
          startedWith.current = latest.current.draft.text
        }}
        onChange={(e) => edit({ text: e.target.value })}
        onBlur={flush}
        onKeyDown={escapeTo("text")}
      />
      {c.note !== undefined && c.note !== "" && <p className="checkpoint-details__manifest-note">{t("checkpoints.note.taken", { note: c.note })}</p>}
      <dl className="checkpoint-details__props">
        <div className="checkpoint-details__prop">
          <dt>{t("checkpoints.note.tags")}</dt>
          <dd>
            <input
              className="checkpoint-details__value-field"
              value={draft.tags}
              aria-label={t("checkpoints.note.tags")}
              title={t("checkpoints.note.tagsTip")}
              placeholder={t("checkpoints.note.tagsPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              onFocus={() => {
                startedWith.current = latest.current.draft.tags
              }}
              onChange={(e) => edit({ tags: e.target.value })}
              onBlur={flush}
              onKeyDown={escapeTo("tags")}
            />
          </dd>
        </div>
        <div className="checkpoint-details__prop">
          <dt>{t("checkpoints.fact.taken")}</dt>
          <dd>{takenAt(c, now)}</dd>
        </div>
        <div className="checkpoint-details__prop">
          <dt>{t("checkpoints.fact.kind")}</dt>
          <dd>{kindLabel(c.kind)}</dd>
        </div>
        <div className="checkpoint-details__prop">
          <dt>{t("checkpoints.fact.size")}</dt>
          <dd>{formatSize(c.bytes)}</dd>
        </div>
        <div className="checkpoint-details__prop">
          <dt>{t("checkpoints.fact.loads")}</dt>
          <dd>
            {reason !== null ? (
              // A few words; the whole reason is the tooltip and the accessible description.
              <span className="checkpoint-details__reason" title={t(reason)} aria-describedby={reasonId}>
                <Icon name="warning" />
                {t(shortReason(reason))}
                <span id={reasonId} hidden>
                  {t(reason)}
                </span>
              </span>
            ) : c.compatible === null ? (
              t("checkpoints.loads.unknown")
            ) : (
              t("checkpoints.loads.yes")
            )}
          </dd>
        </div>
        <div className="checkpoint-details__prop">
          <dt>{t("checkpoints.fact.name")}</dt>
          <dd className="mono">{c.name}</dd>
        </div>
      </dl>
    </SpatialCanvasSidePanel>
  )
}
