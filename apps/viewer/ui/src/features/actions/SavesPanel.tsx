import { type FormEvent, useEffect, useState } from "react"

import { outputText, winvm } from "../../backend"
import { Button } from "../../components/Button"
import { t } from "../../i18n"
import type { SaveEntry } from "../../model"
import { formatSize, parseSaves } from "../../model"

interface SavesPanelProps {
  readonly instance: string
  readonly canSave: boolean
  readonly busy: boolean
  onSave(name: string): void
  onRestore(name: string): void
}

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

/** Save this moment (optionally named), and go back to any earlier one. */
export function SavesPanel({ instance, canSave, busy, onSave, onRestore }: SavesPanelProps): JSX.Element {
  const [name, setName] = useState("")
  const [saves, setSaves] = useState<SaveEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (busy) return
    winvm("saves", "-i", instance, "--json")
      .then((out) => {
        const list = parseSaves(out.stdout)
        setSaves(list === null ? [] : [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
        setError(list === null ? outputText(out) : null)
      })
      .catch((e: unknown) => setError(String(e)))
  }, [instance, busy])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    onSave(name.trim())
    setName("")
  }

  return (
    <div className="action">
      <form className="action__section" onSubmit={submit}>
        <label className="action__label" htmlFor="save-name">
          {t("saves.title")}
        </label>
        <div className="action__row">
          <input
            id="save-name"
            className="input"
            value={name}
            placeholder={t("saves.namePlaceholder")}
            autoComplete="off"
            spellCheck={false}
            disabled={!canSave || busy}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!canSave || busy}>
            {t("saves.save")}
          </Button>
        </div>
        {!canSave && <p className="action__hint">{t("saves.needsRunning")}</p>}
      </form>
      <section className="action__section">
        <h2 className="action__label">{t("saves.listTitle")}</h2>
        {error !== null && <p className="action__error">{error}</p>}
        {saves === null ? (
          <p className="action__hint">{t("state.loading")}</p>
        ) : saves.length === 0 ? (
          <p className="action__hint">{t("saves.none")}</p>
        ) : (
          <ul className="saves">
            {saves.map((s) => (
              <li className="save" key={s.name}>
                <span className="save__text">
                  <span className="save__name">{s.name}</span>
                  <span className="save__meta">
                    {when(s.createdAt)} · {formatSize(s.bytes)}
                    {s.note === undefined ? "" : ` · ${s.note}`}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || s.compatible === false}
                  title={s.compatible === false ? t("saves.incompatible") : undefined}
                  onClick={() => onRestore(s.name)}
                >
                  {t("saves.restore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
