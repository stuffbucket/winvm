import { Icon, type IconName } from "../../components/Icon"
import { cx } from "../../components/cx"
import { t } from "../../i18n"
import type { Controls, Phase } from "../../model"

interface ToolbarProps {
  readonly names: readonly string[]
  readonly name: string | null
  readonly phase: Phase | null
  readonly busyLabel: string | null
  readonly controls: Controls
  readonly fit: boolean
  readonly panelOpen: boolean
  onSelect(name: string): void
  onStart(): void
  onShutDown(): void
  onRestart(): void
  onPause(): void
  onResume(): void
  onFit(): void
  onScreenSharing(): void
  onPanel(): void
}

interface ToolButtonProps {
  readonly icon: IconName
  readonly label: string
  readonly enabled: boolean
  readonly pressed?: boolean
  onClick(): void
}

function ToolButton({ icon, label, enabled, pressed, onClick }: ToolButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={!enabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  )
}

/** Across the top: which Windows and what it is doing, then power, view, Screen Sharing and the panel. */
export function Toolbar(p: ToolbarProps): JSX.Element {
  const c = p.controls
  const live = p.phase === "running" || p.phase === "starting" || p.phase === "paused"
  const state = p.busyLabel ?? t(`state.${p.phase ?? "loading"}`)
  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="toolbar__instance" data-tauri-drag-region>
        <span className={cx("dot", p.phase !== null && `dot--${p.phase}`)} aria-hidden="true" />
        {p.names.length > 1 ? (
          <select
            className="toolbar__picker"
            aria-label={t("action.instance")}
            value={p.name ?? ""}
            onChange={(e) => p.onSelect(e.target.value)}
          >
            {p.names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        ) : (
          <span className="toolbar__name" data-tauri-drag-region>
            {p.name ?? "winvm"}
          </span>
        )}
        <span className="toolbar__state" data-tauri-drag-region role="status">
          {state}
        </span>
      </div>

      <div className="toolbar__group">
        {live ? (
          <button type="button" className="btn btn--secondary btn--sm" disabled={!c.shutDown} onClick={p.onShutDown}>
            <Icon name="power" />
            {t("action.shutDown")}
          </button>
        ) : (
          <button type="button" className="btn btn--secondary btn--sm" disabled={!c.start} onClick={p.onStart}>
            <Icon name="play" />
            {t("action.start")}
          </button>
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
        <ToolButton icon="fit" label={t("action.fit")} enabled={c.screen} pressed={p.fit} onClick={p.onFit} />
        <ToolButton icon="screenSharing" label={t("action.screenSharing")} enabled={c.screen} onClick={p.onScreenSharing} />
        <ToolButton icon="panel" label={t("action.details")} enabled pressed={p.panelOpen} onClick={p.onPanel} />
      </div>
    </header>
  )
}
