import type { JSX } from "react"
import { Icon } from "../../components/Icon"
import { InlineRename } from "../../components/InlineRename"
import {
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
} from "../../components/Menu"
import { t } from "../../i18n"
import { type Phase, shownTitle, TITLE_MAX } from "../../model"
import { stateKey, stateShape } from "./machines"

export interface MachinePickerProps {
  readonly names: readonly string[]
  readonly name: string | null
  readonly titles: Readonly<Record<string, string | null>>
  readonly phases: Readonly<Record<string, Phase>>
  readonly phase: Phase | null
  readonly renaming: boolean
  onRenamed: (next: string | null) => void
  onSelect(name: string): void
  onNew: () => void
  onRename: () => void
  onDelete: () => void
}

function State({
  phase,
}: {
  readonly phase: Phase | null | undefined
}): JSX.Element | undefined {
  if (phase === null || phase === undefined) return undefined
  return (
    <span className="state">
      <span
        className={`state__dot state__dot--${stateShape(phase)}`}
        aria-hidden="true"
      />
      {t(stateKey(phase))}
    </span>
  )
}

export function MachinePicker(p: MachinePickerProps): JSX.Element {
  const title = p.name === null ? null : shownTitle(p.name, p.titles[p.name])
  if (p.renaming && title !== null) {
    return (
      <InlineRename
        className="toolbar__rename"
        value={title}
        label={t("rename.windowLabel")}
        maxLength={TITLE_MAX}
        onDone={p.onRenamed}
      />
    )
  }
  const trigger = (
    <button
      type="button"
      className="machine-picker"
      title={t("machine.label")}
      aria-label={t("machine.trigger", { title: title ?? t("machine.none") })}
    >
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
        <MenuRadioGroup
          value={p.name ?? ""}
          onValueChange={(v: unknown) => {
            p.onSelect(String(v))
          }}
        >
          {p.names.map((n) => (
            <MenuRadioItem
              key={n}
              value={n}
              closeOnClick
              label={shownTitle(n, p.titles[n])}
              trailing={<State phase={n === p.name ? p.phase : p.phases[n]} />}
            >
              {shownTitle(n, p.titles[n])}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup name={t("machine.commands")}>
        <MenuItem leading={<Icon name="plus" />} onClick={p.onNew}>
          {t("machine.new")}
        </MenuItem>
        {title !== null && (
          <MenuItem leading={<Icon name="pencil" />} onClick={p.onRename}>
            {t("machine.rename")}
          </MenuItem>
        )}
      </MenuGroup>
      {title !== null && (
        <>
          <MenuSeparator />
          <MenuGroup name={t("machine.removal")}>
            <MenuItem
              tone="danger"
              leading={<Icon name="trash" />}
              onClick={p.onDelete}
            >
              {t("machine.delete", { title })}
            </MenuItem>
          </MenuGroup>
        </>
      )}
    </MenuRoot>
  )
}
