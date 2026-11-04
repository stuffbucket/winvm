import { type KeyboardEvent, useEffect, useRef, useState } from "react"

import { t } from "../../i18n"
import { createNoteSaver, type NoteSaver, readMachineNote, writeMachineNote } from "./machineNote"

/** Matches packages/core machinenote.ts MAX_NOTE_CHARS: a note is for jotting. */
const MAX_CHARS = 20_000

interface MachineNotesProps {
  /** The machine whose note this is; null while it is not known. */
  readonly instance: string | null
  /** The screen's heading, which the note's growth pushes up the window. */
  readonly title: string
}

/**
 * The heading of a suspended machine's screen and, under it, the person's note
 * about the machine: a text area that saves as they type.
 *
 * LAYOUT (styles.css, "Notes"): this block fills the space above the controls
 * and is bottom-aligned in it. The note grows upward, so the heading rises
 * with it; at the top of the screen it stops growing and scrolls inside. The
 * controls below are never moved: the block, not they, takes up the slack.
 * There is no measuring here. The wrapper's data-value is the text again, drawn
 * invisibly by CSS, which is what gives the area the height of what it holds.
 *
 * Keys: nothing is captured but what the text area is for. Escape saves and
 * leaves the field; blur saves. No shortcut of the app is stopped (the
 * Windows machine is not running here, so there is no keyboard capture either:
 * docs/design/keyboard.md).
 */
export function MachineNotes({ instance, title }: MachineNotesProps): JSX.Element {
  const [text, setText] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const saver = useRef<NoteSaver | null>(null)

  useEffect(() => {
    setText("")
    setLoaded(false)
    setFailed(false)
    if (instance === null) return
    let live = true
    const mine = createNoteSaver(
      (text) => writeMachineNote(instance, text),
      (ok) => live && setFailed(!ok),
    )
    saver.current = mine
    void readMachineNote(instance).then((got) => {
      if (!live) return
      setText(got ?? "")
      setLoaded(true)
    })
    return () => {
      live = false
      saver.current = null
      // Whatever was typed last is saved: the screen is leaving, or another machine is shown.
      void mine.flush()
    }
  }, [instance])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== "Escape") return
    // Esc here is "done writing", not "close something else".
    e.stopPropagation()
    void saver.current?.flush()
    e.currentTarget.blur()
  }

  return (
    <div className="overview__upper">
      <h1 className="overview__title">{title}</h1>
      <div className="notes" data-value={text}>
        <textarea
          className="notes__field"
          value={text}
          rows={1}
          maxLength={MAX_CHARS}
          readOnly={!loaded}
          spellCheck
          placeholder={t("overview.notes.placeholder")}
          aria-label={t("overview.notes.label")}
          aria-invalid={failed || undefined}
          onChange={(e) => {
            setText(e.target.value)
            saver.current?.change(e.target.value)
          }}
          onBlur={() => void saver.current?.flush()}
          onKeyDown={onKeyDown}
        />
      </div>
      {failed && (
        <p className="overview__note notes__failed" role="status">
          {t("overview.notes.failed")}
        </p>
      )}
    </div>
  )
}
