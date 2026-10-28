import { Icon, type IconName } from "../../components/Icon"
import { t } from "../../i18n"
import type { Controls, Phase } from "../../model"

export type PanelId = "command" | "files" | "saves" | "share"

interface ToolbarProps {
  readonly names: readonly string[]
  readonly name: string | null
  readonly phase: Phase | null
  /** What is happening right now, in a word or two; null when nothing is. */
  readonly activity: string | null
  readonly controls: Controls
  readonly guestReady: boolean
  readonly canSaves: boolean
  readonly sharing: boolean
  readonly actualSize: boolean
  readonly open: PanelId | null
  readonly detailsOpen: boolean
  onSelect(name: string): void
  onStart(): void
  onShutDown(): void
  onRestart(): void
  onPause(): void
  onResume(): void
  onOpen(id: PanelId, button: HTMLElement): void
  onActualSize(): void
  onScreenSharing(): void
  onDetails(): void
}

interface ToolButtonProps {
  readonly icon: IconName
  readonly label: string
  readonly enabled: boolean
  readonly pressed?: boolean
  readonly expanded?: boolean
  onClick(button: HTMLElement): void
}

function ToolButton({ icon, label, enabled, pressed, expanded, onClick }: ToolButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      disabled={!enabled}
      onClick={(e) => onClick(e.currentTarget)}
    >
      <Icon name={icon} />
    </button>
  )
}

/** The title bar: which Windows (when there are several), then power, things to do in Windows, and view. */
export function Toolbar(p: ToolbarProps): JSX.Element {
  const c = p.controls
  const live = p.phase === "running" || p.phase === "starting" || p.phase === "paused"
  const panel = (id: PanelId, icon: IconName, label: string, enabled: boolean, pressed?: boolean): JSX.Element => (
    <ToolButton icon={icon} label={label} enabled={enabled} pressed={pressed} expanded={p.open === id} onClick={(b) => p.onOpen(id, b)} />
  )
  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="toolbar__lead" data-tauri-drag-region>
        {p.names.length > 1 && (
          <select className="toolbar__picker" aria-label={t("action.instance")} value={p.name ?? ""} onChange={(e) => p.onSelect(e.target.value)}>
            {p.names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
        {p.activity !== null && (
          <span className="toolbar__activity" data-tauri-drag-region role="status">
            {p.activity}
          </span>
        )}
      </div>

      <div className="toolbar__group">
        {live ? (
          <ToolButton icon="power" label={t("action.shutDown")} enabled={c.shutDown} onClick={p.onShutDown} />
        ) : (
          <ToolButton icon="play" label={t("action.start")} enabled={c.start} onClick={p.onStart} />
        )}
        <ToolButton icon="restart" label={t("action.restart")} enabled={c.restart} onClick={p.onRestart} />
        {p.phase === "paused" ? (
          <ToolButton icon="play" label={t("action.resume")} enabled={c.resume} onClick={p.onResume} />
        ) : (
          <ToolButton icon="pause" label={t("action.pause")} enabled={c.pause} onClick={p.onPause} />
        )}
      </div>

      <span className="toolbar__divider" aria-hidden="true" />

      <div className="toolbar__group">
        {panel("command", "terminal", t("action.command"), p.guestReady)}
        {panel("files", "folder", t("action.files"), p.guestReady)}
        {panel("saves", "history", t("action.saves"), p.canSaves)}
        {panel("share", "agent", t("action.share"), p.guestReady || p.sharing, p.sharing)}
      </div>

      <span className="toolbar__divider" aria-hidden="true" />

      <div className="toolbar__group">
        <ToolButton icon="fit" label={t("action.actualSize")} enabled={c.screen} pressed={p.actualSize} onClick={p.onActualSize} />
        <ToolButton icon="screenSharing" label={t("action.screenSharing")} enabled={c.screen} onClick={p.onScreenSharing} />
        <ToolButton icon="panel" label={t("action.details")} enabled pressed={p.detailsOpen} onClick={p.onDetails} />
      </div>
    </header>
  )
}
