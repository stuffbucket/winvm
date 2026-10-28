import { useCallback, useEffect, useState } from "react"

import { outputText, winvm } from "../../backend"
import { Button } from "../../components/Button"
import { Icon } from "../../components/Icon"
import { t } from "../../i18n"
import type { ClaudeClient, ClaudeClientId, Share } from "../../model"
import { parseClaudeChange, parseClaudeStatus } from "../../model"

interface SharePanelProps {
  readonly instance: string
  /** Windows is up, so the HTTP endpoint can start. */
  readonly guestReady: boolean
  readonly share: Share | null
  readonly starting: boolean
  readonly error: string | null
  onStart(): void
  onStop(): void
}

type Busy = { readonly id: ClaudeClientId; readonly verb: "install" | "uninstall" }

/** What to tell the person after a change, by client. */
const AFTER: Record<ClaudeClientId, string> = {
  "claude-code": "claude.newSession",
  "claude-desktop": "claude.restartDesktop",
}

/** A long value on one line: when it doesn't fit, the middle gives way and both ends stay. */
function OneLine({ value }: { readonly value: string }): JSX.Element {
  const keep = value.length > 16 ? 8 : 0
  return (
    <code className="mono oneline" title={value}>
      <span className="oneline__head">{keep === 0 ? value : value.slice(0, -keep)}</span>
      {keep > 0 && <span className="oneline__tail">{value.slice(-keep)}</span>}
    </code>
  )
}

function CopyRow({ label, copyLabel, value }: { readonly label: string; readonly copyLabel: string; readonly value: string }): JSX.Element {
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
  const tip = copied ? t("share.copied") : copyLabel
  return (
    <div className="kv__row kv__row--center">
      <dt>{label}</dt>
      <dd className="copyable">
        <OneLine value={value} />
        <button type="button" className="btn btn--ghost btn--icon" aria-label={tip} title={tip} onClick={copy}>
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </dd>
    </div>
  )
}

interface ClientRowProps {
  readonly client: ClaudeClient
  readonly busy: Busy | null
  readonly confirming: boolean
  onAdd(): void
  onRemove(): void
  onConfirm(): void
  onCancel(): void
}

/** One Claude app: Add, or a quiet Added and Remove; Claude Desktop's Add asks first. */
function ClientRow({ client: c, busy, confirming, onAdd, onRemove, onConfirm, onCancel }: ClientRowProps): JSX.Element {
  const disabled = busy !== null
  const vars = { client: c.name }
  let end: JSX.Element
  if (!c.available) end = <span className="client__state">{t("claude.notInstalled")}</span>
  else if (busy?.id === c.id) end = <span className="client__state">{t(busy.verb === "install" ? "claude.adding" : "claude.removing")}</span>
  else if (!c.added)
    end = (
      <Button size="sm" aria-label={t("claude.addTo", vars)} disabled={disabled || confirming} onClick={onAdd}>
        {t("claude.add")}
      </Button>
    )
  else
    end = (
      <>
        {c.current ? (
          <span className="client__state client__state--done">
            <Icon name="check" />
            {t("claude.added")}
          </span>
        ) : (
          <Button size="sm" title={t("claude.updateTip", vars)} disabled={disabled} onClick={onAdd}>
            {t("claude.update")}
          </Button>
        )}
        <Button size="sm" variant="ghost" aria-label={t("claude.removeFrom", vars)} disabled={disabled} onClick={onRemove}>
          {t("claude.remove")}
        </Button>
      </>
    )
  return (
    <li className="client">
      <div className="client__row">
        <span className="client__name">{c.name}</span>
        <span className="client__end">{end}</span>
      </div>
      {confirming && (
        <div className="client__confirm">
          <p className="action__hint">{t("claude.confirmDesktop")}</p>
          <div className="action__row client__confirm-actions">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {t("confirm.cancel")}
            </Button>
            <Button size="sm" variant="primary" aria-label={t("claude.addTo", vars)} onClick={onConfirm}>
              {t("claude.add")}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

/**
 * Use this Windows from Claude: add its MCP server (`winvm mcp`) to Claude Code
 * and Claude Desktop. Under "Other agents", the HTTP endpoint (`winvm cua serve`)
 * for an agent loop of one's own.
 */
export function SharePanel({ instance, guestReady, share, starting, error, onStart, onStop }: SharePanelProps): JSX.Element {
  const [clients, setClients] = useState<readonly ClaudeClient[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [confirming, setConfirming] = useState<ClaudeClientId | null>(null)
  const [after, setAfter] = useState<ClaudeClientId | null>(null)
  const [otherOpen, setOtherOpen] = useState(share !== null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const out = await winvm("mcp", "status", "-i", instance, "--json")
      const got = parseClaudeStatus(out.stdout)
      setClients(got?.clients ?? [])
      setProblem(got === null ? `${t("claude.statusError")} ${outputText(out)}`.trim() : null)
    } catch (e: unknown) {
      setClients([])
      setProblem(`${t("claude.statusError")} ${String(e)}`)
    }
  }, [instance])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const change = async (id: ClaudeClientId, verb: "install" | "uninstall"): Promise<void> => {
    setConfirming(null)
    setAfter(null)
    setProblem(null)
    setBusy({ id, verb })
    try {
      const out = await winvm("mcp", verb, id, "-i", instance, "--json")
      const got = parseClaudeChange(out.stdout)
      if (got === null) setProblem(outputText(out))
      else if (!got.ok) setProblem(got.error)
      else if (got.changed) setAfter(id)
    } catch (e: unknown) {
      setProblem(String(e))
    } finally {
      setBusy(null)
    }
    await refresh()
  }

  return (
    <div className="action">
      <section className="action__section">
        <p className="action__text">{t("claude.body")}</p>
        {clients === null ? (
          <p className="action__hint">{t("state.loading")}</p>
        ) : (
          clients.length > 0 && (
            <ul className="clients">
              {clients.map((c) => (
                <ClientRow
                  key={c.id}
                  client={c}
                  busy={busy}
                  confirming={confirming === c.id}
                  onAdd={() => {
                    if (c.id === "claude-desktop" && !c.added) setConfirming(c.id)
                    else void change(c.id, "install")
                  }}
                  onRemove={() => void change(c.id, "uninstall")}
                  onConfirm={() => void change(c.id, "install")}
                  onCancel={() => setConfirming(null)}
                />
              ))}
            </ul>
          )
        )}
        {after !== null && (
          <p className="action__hint" role="status">
            {t(AFTER[after])}
          </p>
        )}
        {problem !== null && <p className="action__error">{problem}</p>}
      </section>

      <details className="disclosure" open={otherOpen} onToggle={(e) => setOtherOpen(e.currentTarget.open)}>
        <summary className="disclosure__summary">{t("share.other")}</summary>
        <div className="disclosure__body">
          <p className="action__hint">{t("share.body")}</p>
          {share === null ? (
            <div className="action__row">
              <Button size="sm" disabled={starting || !guestReady} onClick={onStart}>
                {starting ? t("share.starting") : t("share.start")}
              </Button>
              {!guestReady && <span className="action__hint">{t("share.needsRunning")}</span>}
            </div>
          ) : (
            <>
              <dl className="kv">
                <CopyRow label={t("share.address")} copyLabel={t("share.copyAddress")} value={share.url} />
                <CopyRow label={t("share.token")} copyLabel={t("share.copyToken")} value={share.token} />
              </dl>
              <p className="action__hint">{t("share.hint")}</p>
              <div className="action__row">
                <Button size="sm" onClick={onStop}>
                  {t("share.stop")}
                </Button>
              </div>
            </>
          )}
          {error !== null && <pre className="output">{error}</pre>}
        </div>
      </details>
    </div>
  )
}
