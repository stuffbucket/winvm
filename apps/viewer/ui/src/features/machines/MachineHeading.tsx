import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react"

import { t } from "../../i18n"
import { TITLE_MAX } from "../../model"
import { titleEdit, titleProblem } from "./machines"

/** Where the machine's name goes in a heading's text: `t(key, { title: TITLE_MARK })`, then handed to MachineHeading. */
export const TITLE_MARK = "\u0001"

/** The reason a typed title can't be kept, in words; null when it can. */
function problemText(typed: string): string | null {
  switch (titleProblem(typed)) {
    case "long":
      return t("machine.title.long", { max: TITLE_MAX })
    case "control":
      return t("machine.title.control")
    default:
      return null
  }
}

export interface MachineHeadingProps {
  /** The heading's words with TITLE_MARK where the machine's name goes: "Windows machine \u0001 is off". */
  readonly text: string
  /** What the person calls this machine: its title, else its name. */
  readonly shown: string
  /** It has a title of its own; emptying the field then clears it (back to the name). */
  readonly hasTitle: boolean
  /** Sets the title (empty clears it); resolves with why it couldn't, or null. Absent: the name is plain text. */
  onRename?(title: string): Promise<string | null>
}

/**
 * An overview's heading with the machine's name in it, editable where it
 * stands (as a tab's name is in VS Code). At rest the name is a button that
 * reads as text, with a quiet background on hover and a text cursor. A
 * click, Return or F2 turns it into a text field of the same size and face,
 * selected; Return or leaving the field keeps what was typed, Escape puts the
 * name back. A name that can't be kept (what `winvm config title=` refuses) says
 * why in a line under the heading and stays in the field; no dialog.
 */
export function MachineHeading({ text, shown, hasTitle, onRename }: MachineHeadingProps): JSX.Element {
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
      // Enter says why and stays; leaving the field is a change of mind.
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
    // Keys typed here are for the field: none reaches the window's own shortcuts.
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
            // The mono face is one width a character, so the field is as wide as what it holds.
            style={{ width: `${String(Math.max([...draft].length, 4))}ch` }}
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
            onBlur={(e) => commit(e.currentTarget.value, false)}
          />
        ) : (
          <button
            ref={button}
            type="button"
            className="name-field name-field--button"
            title={t("machine.renameTip")}
            aria-describedby={hintId}
            onClick={(e) => {
              // The Return that kept the name can land on the button the focus has just gone back to,
              // and WebKit clicks it; a click from the keyboard (no pointer) that soon is that.
              if (e.detail === 0 && Date.now() - endedAt.current < 400) return
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
