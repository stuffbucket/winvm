import {
  type JSX,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"

import { t } from "../../i18n"
import { TITLE_MAX } from "../../model"
import { titleEdit, titleProblem } from "./machines"

export const TITLE_MARK = "\u0001"

const MIN_FIELD_CH = 4
const REOPEN_GUARD_MS = 400

function problemText(typed: string): string | null {
  switch (titleProblem(typed)) {
    case "long":
      return t("machine.title.long", { max: TITLE_MAX })
    case "control":
      return t("machine.title.control")
    case null:
      return null
  }
}

export interface MachineHeadingProps {
  readonly text: string
  readonly shown: string
  readonly hasTitle: boolean
  readonly onRename?: (title: string) => Promise<string | null>
}

export function MachineHeading({
  text,
  shown,
  hasTitle,
  onRename,
}: MachineHeadingProps): JSX.Element {
  const [before = "", after = ""] = text.split(TITLE_MARK)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(shown)
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
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

  const start = (): void => {
    if (onRename === undefined) return
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
    if (ended.current || saving || onRename === undefined) return
    const problem = problemText(typed)
    if (problem !== null) {
      if (focus) setMessage(problem)
      else end(false)
      return
    }
    const what = titleEdit(typed, shown, hasTitle)
    if (what === "none") {
      end(focus)
      return
    }
    setSaving(true)
    onRename(what === "clear" ? "" : typed.trim())
      .then((why) => {
        setSaving(false)
        if (why === null) end(focus)
        else setMessage(t("machine.renameFailed", { why }))
      })
      .catch((e: unknown) => {
        setSaving(false)
        setMessage(t("machine.renameFailed", { why: String(e) }))
      })
  }
  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation()
    if (e.key === "Enter") commit(e.currentTarget.value, true)
    else if (e.key === "Escape") end(true)
  }

  const hintId = `${ids}-hint`
  const messageId = `${ids}-message`
  return (
    <div className="overview__heading">
      <h1 className="overview__title">
        {before}
        {onRename === undefined ? (
          <span className="name-field name-field--plain">{shown}</span>
        ) : editing ? (
          <input
            ref={input}
            className="name-field name-field--editing"
            type="text"
            value={draft}
            style={{
              width: `${String(Math.max(Array.from(draft).length, MIN_FIELD_CH))}ch`,
            }}
            aria-label={t("machine.renameField")}
            aria-invalid={message !== null}
            aria-describedby={message === null ? undefined : messageId}
            readOnly={saving}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
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
            className="name-field name-field--button"
            title={t("machine.renameTip")}
            aria-describedby={hintId}
            onClick={(e) => {
              if (
                e.detail === 0 &&
                Date.now() - endedAt.current < REOPEN_GUARD_MS
              )
                return
              start()
            }}
            onKeyDown={(e) => {
              if (e.key === "F2") {
                e.preventDefault()
                start()
              }
            }}
          >
            {shown}
          </button>
        )}
        {after}
      </h1>
      {onRename !== undefined && (
        <span id={hintId} hidden>
          {t("machine.renameHint")}
        </span>
      )}
      {message !== null && (
        <p className="overview__problem" id={messageId} role="alert">
          {message}
        </p>
      )}
    </div>
  )
}
