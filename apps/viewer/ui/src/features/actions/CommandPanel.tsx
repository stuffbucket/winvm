import { type FormEvent, useState } from "react"

import { outputText, winvm } from "../../backend"
import { Button } from "../../components/Button"
import { t } from "../../i18n"

interface Ran {
  readonly line: string
  readonly code: number
  readonly output: string
}

/** Runs a PowerShell command line in Windows and shows what it printed. */
export function CommandPanel({ instance }: { readonly instance: string }): JSX.Element {
  const [line, setLine] = useState("")
  const [running, setRunning] = useState(false)
  const [ran, setRan] = useState<Ran | null>(null)

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const command = line.trim()
    if (command === "" || running) return
    setRunning(true)
    winvm("exec", "-i", instance, "--", "powershell.exe", "-NoProfile", "-Command", command)
      .then((out) => setRan({ line: command, code: out.code, output: outputText(out) }))
      .catch((error: unknown) => setRan({ line: command, code: -1, output: String(error) }))
      .finally(() => setRunning(false))
  }

  return (
    <form className="action" onSubmit={submit}>
      <label className="action__label" htmlFor="command-line">
        {t("command.label")}
      </label>
      <div className="action__row">
        <input
          id="command-line"
          className="input mono"
          value={line}
          placeholder={t("command.placeholder")}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setLine(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={running || line.trim() === ""}>
          {running ? t("command.running") : t("command.run")}
        </Button>
      </div>
      <p className="action__hint">{t("command.hint")}</p>
      {ran !== null && (
        <>
          <pre className="output">{ran.output === "" ? t("command.noOutput") : ran.output}</pre>
          {ran.code !== 0 && <p className="action__hint">{t("command.exit", { code: ran.code })}</p>}
        </>
      )}
    </form>
  )
}
