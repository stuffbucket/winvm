import { t } from "../../i18n"

export interface Deleting {
  readonly name: string
  /** What the person calls it: its title, else its name. */
  readonly title: string
  /** Running (or starting, or paused): it is turned off first. */
  readonly live: boolean
}

/** What Delete "<name>"… says goes, the Keep checkpoints box, and that a running machine is turned off first. */
export function DeleteMachineBody({ deleting, keepSaves, busy, onKeepSaves }: { readonly deleting: Deleting; readonly keepSaves: boolean; readonly busy: boolean; onKeepSaves(keep: boolean): void }): JSX.Element {
  return (
    <>
      <p>{t("machine.deleteBody", { title: deleting.title })}</p>
      {deleting.live && <p>{t("machine.deleteRunning")}</p>}
      <label className="check-field">
        <input type="checkbox" name="keep-saves" checked={keepSaves} disabled={busy} onChange={(e) => onKeepSaves(e.target.checked)} />
        <span>{t("machine.keepSaves")}</span>
      </label>
    </>
  )
}
