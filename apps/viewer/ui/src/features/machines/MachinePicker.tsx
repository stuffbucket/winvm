import { Icon } from "../../components/Icon"
import { InlineRename } from "../../components/InlineRename"
import { MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSeparator } from "../../components/Menu"
import { t } from "../../i18n"
import { type Phase, shownTitle, TITLE_MAX } from "../../model"
import { stateKey } from "./machines"

export interface MachinePickerProps {
  readonly names: readonly string[]
  /** This machine; null before any is known. */
  readonly name: string | null
  /** Each machine's title; null or absent: its name. */
  readonly titles: Readonly<Record<string, string | null>>
  /** Each machine's state as last read; this one's is `phase`. */
  readonly phases: Readonly<Record<string, Phase>>
  readonly phase: Phase | null
  /** The title is being edited, in place of the picker. */
  readonly renaming: boolean
  onRenamed(next: string | null): void
  onSelect(name: string): void
  onNew(): void
  onRename(): void
  onDelete(): void
}

/**
 * Which Windows machine this window shows, and the others: one trigger (a
 * computer, the machine's name or title, a chevron) opening the Windows
 * machines menu, each with its state and a check on this one, then New
 * Machine…, Rename… and Delete…. It opens with one machine too, so New
 * Machine… is always there.
 */
export function MachinePicker(p: MachinePickerProps): JSX.Element {
  const title = p.name === null ? null : shownTitle(p.name, p.titles[p.name])
  if (p.renaming && title !== null) {
    return <InlineRename className="toolbar__rename" value={title} label={t("rename.windowLabel")} maxLength={TITLE_MAX} onDone={p.onRenamed} />
  }
  const state = (n: string): string | null => {
    const s = n === p.name ? p.phase : p.phases[n]
    return s === null || s === undefined ? null : t(stateKey(s))
  }
  const trigger = (
    <button type="button" className="machine-picker" title={t("machine.label")} aria-label={t("machine.trigger", { title: title ?? t("machine.none") })}>
      <Icon name="monitor" />
      <span className="machine-picker__name">{title ?? t("machine.none")}</span>
      <span className="machine-picker__chevron">
        <Icon name="chevronDown" />
      </span>
    </button>
  )
  return (
    <MenuRoot trigger={trigger} label={t("machine.menu")}>
      <MenuGroup label={t("machine.menu")}>
        <MenuRadioGroup value={p.name ?? ""} onValueChange={(v: unknown) => p.onSelect(String(v))}>
          {p.names.map((n) => (
            <MenuRadioItem key={n} value={n} closeOnClick trailing={state(n) ?? undefined}>
              {shownTitle(n, p.titles[n])}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onClick={p.onNew}>{t("machine.new")}</MenuItem>
      {title !== null && <MenuItem onClick={p.onRename}>{t("machine.rename")}</MenuItem>}
      {title !== null && (
        <MenuItem tone="danger" onClick={p.onDelete}>
          {t("machine.delete", { title })}
        </MenuItem>
      )}
    </MenuRoot>
  )
}
