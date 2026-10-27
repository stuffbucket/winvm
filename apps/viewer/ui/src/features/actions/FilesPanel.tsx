import { type FormEvent, useState } from "react"

import { downloadsDir, outputText, pickFiles, winvm } from "../../backend"
import { Button } from "../../components/Button"
import { t } from "../../i18n"

interface FilesPanelProps {
  readonly instance: string
  onCopyIn(paths: readonly string[]): void
}

const baseName = (path: string): string => path.split(/[\\/]/).filter((p) => p !== "").pop() ?? path

/** Copy files into Windows (picked here, or dropped on the window) and out of it into Downloads. */
export function FilesPanel({ instance, onCopyIn }: FilesPanelProps): JSX.Element {
  const [guestPath, setGuestPath] = useState("")
  const [copying, setCopying] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const choose = (): void => {
    pickFiles(t("files.chooseTitle"))
      .then((paths) => {
        if (paths.length > 0) onCopyIn(paths)
      })
      .catch((error: unknown) => setResult({ ok: false, text: String(error) }))
  }

  const copyOut = (e: FormEvent): void => {
    e.preventDefault()
    const from = guestPath.trim()
    if (from === "" || copying) return
    setCopying(true)
    setResult(null)
    downloadsDir()
      .then(async (dir) => {
        const to = `${dir}/${baseName(from)}`
        const out = await winvm("get", "-i", instance, from, to)
        setResult(out.code === 0 ? { ok: true, text: t("files.copiedOut", { path: to }) } : { ok: false, text: outputText(out) })
      })
      .catch((error: unknown) => setResult({ ok: false, text: String(error) }))
      .finally(() => setCopying(false))
  }

  return (
    <div className="action">
      <section className="action__section">
        <h2 className="action__label">{t("files.inTitle")}</h2>
        <div className="action__row">
          <Button variant="primary" onClick={choose}>
            {t("files.choose")}
          </Button>
        </div>
        <p className="action__hint">{t("files.inHint")}</p>
      </section>
      <form className="action__section" onSubmit={copyOut}>
        <label className="action__label" htmlFor="guest-path">
          {t("files.outTitle")}
        </label>
        <div className="action__row">
          <input
            id="guest-path"
            className="input mono"
            value={guestPath}
            placeholder={t("files.outPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setGuestPath(e.target.value)}
          />
          <Button type="submit" disabled={copying || guestPath.trim() === ""}>
            {copying ? t("files.copying") : t("files.copyOut")}
          </Button>
        </div>
        {result !== null && <p className={result.ok ? "action__hint" : "action__error"}>{result.text}</p>}
      </form>
    </div>
  )
}
