import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react"

import { t } from "../../i18n"
import {
  createNoteSaver,
  type NoteSaver,
  readMachineNote,
  writeMachineNote,
} from "./machineNote"

const MAX_CHARS = 20_000

interface MachineNotesProps {
  readonly instance: string | null
  readonly heading: ReactNode
}

export function MachineNotes({
  instance,
  heading,
}: MachineNotesProps): JSX.Element {
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
      (ok) => {
        if (live) setFailed(!ok)
      },
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
      void mine.flush()
    }
  }, [instance])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== "Escape") return
    e.stopPropagation()
    void saver.current?.flush()
    e.currentTarget.blur()
  }

  return (
    <div className="overview__upper">
      {heading}
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
