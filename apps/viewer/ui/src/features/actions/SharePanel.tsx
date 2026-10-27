import { useState } from "react"

import { Button } from "../../components/Button"
import { t } from "../../i18n"
import type { Share } from "../../model"

interface SharePanelProps {
  readonly share: Share | null
  readonly starting: boolean
  readonly error: string | null
  onStart(): void
  onStop(): void
}

function Copyable({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }
  return (
    <div className="kv__row">
      <dt>{label}</dt>
      <dd className="copyable">
        <code className="mono copyable__value">{value}</code>
        <Button size="sm" variant="ghost" onClick={copy}>
          {copied ? t("share.copied") : t("share.copy")}
        </Button>
      </dd>
    </div>
  )
}

/** Lets an agent see the screen and use the mouse and keyboard, through Claude's computer-use tools. */
export function SharePanel({ share, starting, error, onStart, onStop }: SharePanelProps): JSX.Element {
  return (
    <div className="action">
      <p className="action__text">{t("share.body")}</p>
      {share === null ? (
        <div className="action__row">
          <Button variant="primary" disabled={starting} onClick={onStart}>
            {starting ? t("share.starting") : t("share.start")}
          </Button>
        </div>
      ) : (
        <>
          <dl className="kv">
            <Copyable label={t("share.address")} value={share.url} />
            <Copyable label={t("share.token")} value={share.token} />
          </dl>
          <p className="action__hint">{t("share.hint")}</p>
          <div className="action__row">
            <Button onClick={onStop}>{t("share.stop")}</Button>
          </div>
        </>
      )}
      {error !== null && <pre className="output">{error}</pre>}
    </div>
  )
}
