import { useEffect, useRef, useState } from "react"

import { outputText, winvm } from "../../backend"
import { t } from "../../i18n"
import { Hardware } from "../hardware/Hardware"
import { Network } from "../hardware/Network"
import type { MachineInfoView } from "../hardware/useMachineInfo"
import { type Policy, parsePolicy, policyReadArgs, policyWriteArgs } from "./policy"

interface Props {
  readonly instance: string | null
  readonly title: string
  readonly machineInfo: MachineInfoView
  readonly pauseOverlay: boolean
  onPauseOverlay(on: boolean): void
  onClose(): void
}

/** A native modal, not a second settings store. Machine policy uses `winvm config`. */
export function SettingsDialog(p: Props): JSX.Element {
  const dialog = useRef<HTMLDialogElement | null>(null)
  const [stored, setStored] = useState<Policy | null>(null)
  const [draft, setDraft] = useState<Policy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    dialog.current?.showModal()
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    let gone = false
    setStored(null)
    setDraft(null)
    setError(null)
    if (p.instance !== null) {
      void winvm(...policyReadArgs(p.instance)).then((out) => {
        if (gone) return
        const policy = out.code === 0 ? parsePolicy(out.stdout) : null
        setStored(policy)
        setDraft(policy)
        if (policy === null) setError(outputText(out) || t("settings.readFailed"))
      }).catch((e: unknown) => { if (!gone) setError(String(e)) })
    }
    return () => { gone = true }
  }, [p.instance, reload])

  const close = (): void => { if (!saving && !p.machineInfo.working) p.onClose() }
  const set = <K extends keyof Policy>(key: K, value: Policy[K]): void => {
    setDraft((d) => d === null ? d : { ...d, [key]: value })
  }
  const save = async (): Promise<void> => {
    if (p.instance === null || stored === null || draft === null || saving) return
    setSaving(true)
    setError(null)
    try {
      const out = await winvm(...policyWriteArgs(p.instance, stored, draft))
      if (!alive.current) return
      const policy = out.code === 0 ? parsePolicy(out.stdout) : null
      if (policy === null) setError(outputText(out) || t("settings.failed"))
      else { setStored(policy); setDraft(policy) }
    } catch (e: unknown) { if (alive.current) setError(String(e)) }
    finally { if (alive.current) setSaving(false) }
  }
  const toggle = (key: keyof Policy, label: string): JSX.Element => (
    <label className="check-field">
      <input type="checkbox" checked={draft?.[key] === true} disabled={saving} onChange={(e) => set(key, e.target.checked)} />
      <span>{t(label)}</span>
    </label>
  )
  const number = (key: "autosave.idleMinutes" | "autosave.keep" | "stow.idleMinutes", label: string, disabled: boolean): JSX.Element => (
    <label className="settings-dialog__number">
      <span>{t(label)}</span>
      <input className="input" type="number" min="1" step={key === "autosave.keep" ? "1" : "any"} required value={draft?.[key] ?? ""} disabled={saving || disabled} onChange={(e) => set(key, e.target.valueAsNumber)} />
    </label>
  )
  const changed = draft !== null && stored !== null && JSON.stringify(draft) !== JSON.stringify(stored)
  return (
    <dialog ref={dialog} className="confirm-dialog settings-dialog" aria-labelledby="settings-title" onCancel={(e) => { e.preventDefault(); close() }}>
      <form className="confirm-dialog__panel" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <h2 id="settings-title" className="confirm-dialog__title">{t("settings.title")}</h2>
        <div className="confirm-dialog__body settings-dialog__body">
          <section className="settings-dialog__section">
            <h3>{t("settings.viewer")}</h3>
            <label className="check-field"><input type="checkbox" checked={p.pauseOverlay} onChange={(e) => p.onPauseOverlay(e.target.checked)} /><span>{t("menu.pauseOverlay")}</span></label>
          </section>
          {p.instance !== null && <>
            <section className="settings-dialog__section">
              <h3>{t("settings.machine", { title: p.title })}</h3>
              {draft === null ? error === null && <p>{t("state.loading")}</p> : <>
                {toggle("watch.enabled", "settings.watch")}
                <fieldset disabled={!draft["watch.enabled"] || saving}>
                  {toggle("autosave.enabled", "settings.autosave")}
                  {number("autosave.idleMinutes", "settings.autosaveAfter", !draft["autosave.enabled"])}
                  {number("autosave.keep", "settings.keep", !draft["autosave.enabled"])}
                  <p className="action__hint">{t("settings.retentionHint")}</p>
                  {toggle("stow.enabled", "settings.stow")}
                  {number("stow.idleMinutes", "settings.stowAfter", !draft["stow.enabled"])}
                </fieldset>
                <p className="action__hint">{t("settings.idleHint")}</p>
                {toggle("power.keepAwake", "settings.keepAwake")}
                <p className="action__hint">{t("settings.awakeHint")}</p>
                <p className="action__hint">{t("settings.sleepHint")}</p>
              </>}
            </section>
            <details className="settings-dialog__section"><summary>{t("settings.hardware")}</summary><Hardware view={p.machineInfo} /><p className="action__hint">{t("settings.hardwareHint")}</p></details>
            <details className="settings-dialog__section"><summary>{t("settings.network")}</summary><Network view={p.machineInfo} /><p className="action__hint">{t("settings.networkHint")}</p></details>
            <details className="settings-dialog__section"><summary>{t("settings.devices")}</summary><p className="action__hint">{t("settings.devicesHint")}</p></details>
          </>}
          {error !== null && <p className="field__hint field__hint--error" role="alert">{error} <button type="button" className="btn btn--ghost" disabled={saving} onClick={() => setReload((n) => n + 1)}>{t("settings.retry")}</button></p>}
        </div>
        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn--ghost" disabled={saving || p.machineInfo.working} onClick={close}>{t("settings.close")}</button>
          <button type="submit" className="btn btn--primary" disabled={!changed || saving}>{t(saving ? "settings.saving" : "settings.apply")}</button>
        </div>
      </form>
    </dialog>
  )
}
