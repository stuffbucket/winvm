import { CanvasGlyph, CanvasIconButton, GLYPHS } from "@winvm/canvas"
import {
  type JSX,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import { Button } from "../../components/Button"
import { Icon } from "../../components/Icon"
import { t } from "../../i18n"
import { formatSize, type SaveNotes } from "../../model"
import { motion, ms } from "../../styles/theme"
import { titleEdit } from "../machines/machines"
import { KindChip, Picture, takenAt } from "./CheckpointCard"
import {
  type Checkpoint,
  canProtect,
  deleteBlocked,
  formatLabelKey,
  incompatibleReason,
  shownName,
} from "./checkpoints"

export interface NoteDraft {
  readonly title: string
  readonly text: string
  readonly tags: string
}

export const draftOf = (n: SaveNotes | null): NoteDraft => ({
  title: n?.title ?? "",
  text: n?.text ?? "",
  tags: (n?.tags ?? []).join(", "),
})

export const tagsOf = (s: string): string[] => [
  ...new Set(
    s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== ""),
  ),
]

const sameDraft = (a: NoteDraft, b: NoteDraft): boolean =>
  a.title.trim() === b.title.trim() &&
  a.text === b.text &&
  tagsOf(a.tags).join(",") === tagsOf(b.tags).join(",")

export const CHECKPOINT_TITLE_MAX = 120

const CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a title is refused when it holds these control and direction characters, so the pattern has to name them
  /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/

function checkpointTitleProblem(title: string): "long" | "control" | null {
  const typed = title.trim()
  if (Array.from(typed).length > CHECKPOINT_TITLE_MAX) return "long"
  if (CONTROL.test(typed)) return "control"
  return null
}

const problemText = (typed: string): string | null => {
  switch (checkpointTitleProblem(typed)) {
    case "long":
      return t("machine.title.long", { max: CHECKPOINT_TITLE_MAX })
    case "control":
      return t("machine.title.control")
    case null:
      return null
  }
}

export const shortReason = (reasonKey: string): string =>
  reasonKey.replace(
    "checkpoints.incompatible.",
    "checkpoints.incompatibleShort.",
  )

interface DetailsProps {
  readonly c: Checkpoint
  readonly now: number
  readonly busy: boolean
  readonly saving: "idle" | "saving" | "saved" | "failed"
  readonly state?: "open" | "closed"
  readonly panelRef?: Ref<HTMLElement>
  onClose: () => void
  onLook: (opener: HTMLElement) => void
  onNote: (name: string, draft: NoteDraft) => void
  onGoBack: () => void
  onReveal: () => void
  onDelete: () => void
  onProtect: (protect: boolean) => void
}

const NOTE_DEBOUNCE_MS = 700

function InlineTitle({
  shown,
  hasTitle,
  name,
  onCommit,
}: {
  readonly shown: string
  readonly hasTitle: boolean
  readonly name: string
  onCommit: (title: string) => void
}): JSX.Element {
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

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (
        e.key !== "F2" ||
        e.defaultPrevented ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return
      if (e.target instanceof Element && e.target.closest("dialog") !== null)
        return
      e.preventDefault()
      button.current?.focus()
      button.current?.click()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
    }
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
      e.stopPropagation()
      end(true)
    }
  }

  const hintId = `${ids}-hint`
  const messageId = `${ids}-message`
  const emptyHint =
    editing && draft.trim() === "" && message === null && hasTitle
      ? t("checkpoints.title.empty", { name })
      : null
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
          onBlur={(e) => {
            commit(e.currentTarget.value, false)
          }}
        />
      ) : (
        <button
          ref={button}
          type="button"
          className="checkpoint-details__title-field"
          title={t("checkpoints.title.tip")}
          aria-describedby={hintId}
          onClick={(e) => {
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
        <p
          className="checkpoint-details__problem"
          id={messageId}
          role={message === null ? "status" : "alert"}
          data-tone={message === null ? "quiet" : "error"}
        >
          {message ?? emptyHint}
        </p>
      )}
    </div>
  )
}

export const PANEL_EXIT_MS = ms(motion.duration.lg)
const panelExitMs = (): number =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : PANEL_EXIT_MS

export function CheckpointDetails({
  c,
  now,
  busy,
  saving,
  state = "open",
  panelRef,
  onClose,
  onLook,
  onNote,
  onGoBack,
  onReveal,
  onDelete,
  onProtect,
}: DetailsProps): JSX.Element {
  const [draft, setDraft] = useState(() => draftOf(c.notes))
  const written = useRef(draftOf(c.notes))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ draft, onNote })
  latest.current = { draft, onNote }
  const noteField = useRef<HTMLTextAreaElement>(null)
  const startedWith = useRef("")
  const reasonId = useId()
  const protectHintId = useId()
  const protectHint =
    c.protected === true
      ? "checkpoints.protectHint"
      : canProtect(c)
        ? "checkpoints.unprotectedHint"
        : "checkpoints.protectStow"

  const draftFor = useRef<{ name: string; createdAt: string } | null>(null)
  useEffect(() => {
    const shown = draftFor.current
    if (shown?.name === c.name && shown.createdAt === c.createdAt) return
    draftFor.current = { name: c.name, createdAt: c.createdAt }
    const d = draftOf(c.notes)
    setDraft(d)
    written.current = d
  }, [c.name, c.createdAt, c.notes])

  const flushTo = useCallback((checkpoint: string): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const d = latest.current.draft
    if (sameDraft(d, written.current)) return
    written.current = d
    latest.current.onNote(checkpoint, d)
  }, [])
  const flush = (): void => {
    flushTo(c.name)
  }
  useEffect(() => {
    const typedFor = c.name
    return () => {
      flushTo(typedFor)
    }
  }, [c.name, flushTo])

  const edit = (patch: Partial<NoteDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(flush, NOTE_DEBOUNCE_MS)
  }
  const keep = (patch: Partial<NoteDraft>): void => {
    const d = { ...latest.current.draft, ...patch }
    latest.current.draft = d
    setDraft(d)
    flush()
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the note field is measured again whenever its text or its checkpoint changes, though the effect reads only the element
  useLayoutEffect(() => {
    const el = noteField.current
    if (el === null) return
    el.style.height = "auto"
    if (el.scrollHeight > 0) el.style.height = `${String(el.scrollHeight)}px`
  }, [draft.text, c.name])

  const escapeTo =
    (field: "text" | "tags") =>
    (e: KeyboardEvent<HTMLElement>): void => {
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
  const shown =
    draft.title.trim() !== "" ? draft.title.trim() : (c.title ?? c.name)
  return (
    <aside
      ref={panelRef}
      className="checkpoint-details"
      aria-label={t("checkpoints.details", { name })}
      tabIndex={-1}
      data-state={state}
    >
      <CanvasIconButton
        className="checkpoint-details__close"
        label={t("checkpoints.closeDetails")}
        onClick={onClose}
      >
        <CanvasGlyph>{GLYPHS.close}</CanvasGlyph>
      </CanvasIconButton>
      <div className="checkpoint-details__scroll">
        <div className="checkpoint-details__figure">
          <button
            type="button"
            className="checkpoint-details__picture"
            title={t("checkpoints.lookTip")}
            onClick={(e) => {
              onLook(e.currentTarget)
            }}
          >
            <Picture c={c} sharp wanted />
          </button>
          {reason !== null && (
            <p className="checkpoint-details__banner" title={t(reason)}>
              <Icon name="warning" />
              <span>
                {t("checkpoints.cantLoadWhy", { why: t(shortReason(reason)) })}
              </span>
              <span id={reasonId} hidden>
                {t(reason)}
              </span>
            </p>
          )}
        </div>
        <div className="checkpoint-details__plate">
          <InlineTitle
            shown={shown}
            hasTitle={draft.title.trim() !== ""}
            name={c.name}
            onCommit={(title) => {
              keep({ title })
            }}
          />
          <p className="checkpoint-details__when">{takenAt(c, now)}</p>
          <div className="checkpoint-details__facts">
            <KindChip kind={c.kind} className="checkpoint-details__kind" />
            <span
              className="checkpoint-details__size"
              title={t("checkpoints.sizeTip")}
            >
              {formatSize(c.bytes)}
            </span>
          </div>
          <hr className="checkpoint-details__break" />
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
            onChange={(e) => {
              edit({ text: e.target.value })
            }}
            onBlur={flush}
            onKeyDown={escapeTo("text")}
          />
          {c.note !== undefined && c.note !== "" && (
            <p className="checkpoint-details__manifest-note">
              {t("checkpoints.note.taken", { note: c.note })}
            </p>
          )}
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
                  onChange={(e) => {
                    edit({ tags: e.target.value })
                  }}
                  onBlur={flush}
                  onKeyDown={escapeTo("tags")}
                />
              </dd>
            </div>
            <div className="checkpoint-details__prop">
              <dt>{t("checkpoints.fact.format")}</dt>
              <dd>{t(formatLabelKey(c.format))}</dd>
            </div>
          </dl>
          <span
            className="checkpoint-details__protection"
            title={t(protectHint)}
          >
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || (!canProtect(c) && c.protected !== true)}
              aria-pressed={c.protected === true}
              aria-describedby={protectHintId}
              onClick={() => {
                onProtect(c.protected !== true)
              }}
            >
              <Icon name="lock" />
              {t(
                c.protected === true
                  ? "checkpoints.unprotect"
                  : "checkpoints.protect",
              )}
            </Button>
            <span id={protectHintId} hidden>
              {t(protectHint)}
            </span>
          </span>
        </div>
      </div>
      <footer className="checkpoint-details__actions">
        <Button
          size="sm"
          variant="ghost"
          className="checkpoint-details__delete"
          disabled={busy || blocked !== null}
          title={blocked === null ? undefined : t(blocked)}
          onClick={onDelete}
        >
          <Icon name="trash" />
          {t("checkpoints.delete")}
        </Button>
        <span
          className="checkpoint-details__saved"
          role="status"
          data-failed={saving === "failed"}
        >
          {saving === "saving"
            ? t("checkpoints.note.saving")
            : saving === "saved"
              ? t("checkpoints.note.saved")
              : saving === "failed"
                ? t("checkpoints.note.failed")
                : ""}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="btn--icon checkpoint-details__reveal"
          aria-label={t("checkpoints.showInFinder")}
          title={t("checkpoints.showInFinder")}
          onClick={onReveal}
        >
          <Icon name="folder" />
        </Button>
        <span title={reason === null ? undefined : t(reason)}>
          <Button
            size="sm"
            variant="primary"
            className="btn--icon checkpoint-details__restore"
            disabled={busy || reason !== null}
            aria-label={t("checkpoints.restore")}
            title={reason === null ? t("checkpoints.restore") : t(reason)}
            aria-describedby={reason === null ? undefined : reasonId}
            onClick={onGoBack}
          >
            <Icon name="rewind" />
          </Button>
        </span>
      </footer>
    </aside>
  )
}

const cardButtonOf = (name: string): HTMLElement | null => {
  for (const card of document.querySelectorAll<HTMLElement>(
    ".checkpoint[data-name]",
  )) {
    if (card.dataset.name === name)
      return card.querySelector<HTMLElement>(".checkpoint__hit")
  }
  return null
}

export interface LayerProps
  extends Omit<
    DetailsProps,
    | "c"
    | "state"
    | "panelRef"
    | "onNote"
    | "onGoBack"
    | "onReveal"
    | "onDelete"
    | "onProtect"
  > {
  readonly c: Checkpoint | undefined
  onNote: (name: string, draft: NoteDraft) => void
  onGoBack: (name: string) => void
  onReveal: (name: string) => void
  onDelete: (name: string) => void
  onProtect: (name: string, protect: boolean) => void
}

export function CheckpointDetailsLayer({
  c,
  onNote,
  onGoBack,
  onReveal,
  onDelete,
  onProtect,
  ...rest
}: LayerProps): JSX.Element | null {
  const open = c !== undefined
  const kept = useRef<Checkpoint | undefined>(c)
  if (c !== undefined) kept.current = c
  const [shown, setShown] = useState(false)
  const [lingering, setLingering] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const was = useRef(false)
  const exit = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const el = panel.current
    if (open) {
      if (exit.current !== null) clearTimeout(exit.current)
      exit.current = null
      setLingering(false)
      if (el !== null) {
        el.inert = false
        if (!was.current) {
          void el.offsetWidth
          setShown(true)
          el.focus({ preventScroll: true })
        } else setShown(true)
      }
      was.current = true
    } else if (was.current) {
      was.current = false
      const focus = document.activeElement
      if (
        el !== null &&
        (focus === null || focus === document.body || el.contains(focus)) &&
        kept.current !== undefined
      )
        cardButtonOf(kept.current.name)?.focus({ preventScroll: true })
      if (el !== null) el.inert = true
      setShown(false)
      setLingering(true)
      exit.current = setTimeout(() => {
        exit.current = null
        setLingering(false)
      }, panelExitMs())
    }
  }, [open])
  useEffect(
    () => () => {
      if (exit.current !== null) clearTimeout(exit.current)
    },
    [],
  )

  const shownCheckpoint = c ?? kept.current
  if (shownCheckpoint === undefined || (!open && !lingering && !was.current))
    return null
  return (
    <CheckpointDetails
      {...rest}
      c={shownCheckpoint}
      state={open && shown ? "open" : "closed"}
      panelRef={panel}
      onNote={onNote}
      onGoBack={() => {
        onGoBack(shownCheckpoint.name)
      }}
      onReveal={() => {
        onReveal(shownCheckpoint.name)
      }}
      onDelete={() => {
        onDelete(shownCheckpoint.name)
      }}
      onProtect={(protect) => {
        onProtect(shownCheckpoint.name, protect)
      }}
    />
  )
}
