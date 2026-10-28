import { Icon, type IconName } from "../../components/Icon"
import { t } from "../../i18n"
import { type Controls, isFrozen, isLivePhase, type Phase } from "../../model"
import { MachinePicker, type MachinePickerProps } from "../machines/MachinePicker"

export type PanelId = "files" | "share"

interface ToolbarProps {
  /** The Windows machine picker, at the left. */
  readonly picker: MachinePickerProps
  readonly phase: Phase | null
  /** What is happening right now, in a word or two; null when nothing is. */
  readonly activity: string | null
  readonly controls: Controls
  readonly guestReady: boolean
  /** Why the terminal can't open (an i18n key), or null when it can. */
  readonly terminalBlocked: string | null
  /** Whether Checkpoints can open: there is a machine (its checkpoints show even while it is off). */
  readonly canCheckpoints: boolean
  readonly checkpointsOpen: boolean
  /** Whether "Use with Claude" can open: there is an instance to add (its HTTP endpoint also needs Windows up). */
  readonly canShare: boolean
  readonly sharing: boolean
  readonly actualSize: boolean
  /** Whether "Actual size" means anything: not when the guest's screen follows the window (virtio-gpu). */
  readonly canActualSize: boolean
  readonly open: PanelId | null
  readonly detailsOpen: boolean
  readonly keyboardCaptured: boolean
  onStart(): void
  onShutDown(): void
  onRestart(): void
  onPause(): void
  /** Resume a paused machine, or wake one asleep. */
  onResume(): void
  /** Option-click or right-click on Pause / Resume: Show Pause Overlay, Sleep, Lock. */
  onPauseMenu(): void
  onOpen(id: PanelId, button: HTMLElement): void
  onTerminal(): void
  onTerminalMenu(): void
  onFilesMenu(): void
  onCheckpoints(): void
  onCheckpointsMenu(): void
  onActualSize(): void
  onScreenSharing(): void
  onDetails(): void
  onKeyboardCapture(): void
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

/**
 * >_ opens a PowerShell 7 tab in the Terminal window; Option-click or
 * right-click offers the other shells and places in a native menu. Disabled,
 * its tooltip says why.
 */
function TerminalButton({ blocked, onOpen, onMenu }: { readonly blocked: string | null; onOpen(): void; onMenu(): void }): JSX.Element {
  const label = t("action.terminal")
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      aria-label={label}
      aria-haspopup="menu"
      title={blocked === null ? t("terminal.tip") : t(blocked)}
      disabled={blocked !== null}
      onClick={(e) => (e.altKey ? onMenu() : onOpen())}
      onContextMenu={(e) => {
        e.preventDefault()
        if (blocked === null) onMenu()
      }}
    >
      <Icon name="terminal" />
    </button>
  )
}

/**
 * Pause, or Resume (Wake when asleep) while held. Option-click or right-click
 * offers Show Pause Overlay, Sleep and Lock in a native menu. Pause and Resume
 * are different buttons to React (their parent keys them), so the one focused
 * when Pause is clicked never turns into Resume under a key press.
 */
function PauseButton({ phase, c, onPause, onResume, onMenu }: { readonly phase: Phase | null; readonly c: Controls; onPause(): void; onResume(): void; onMenu(): void }): JSX.Element {
  const frozen = isFrozen(phase)
  const label = t(phase === "asleep" ? "action.wake" : frozen ? "action.resume" : "action.pause")
  const enabled = frozen ? c.resume : c.pause
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      aria-label={label}
      aria-haspopup="menu"
      title={t("power.tip", { action: label })}
      disabled={!enabled}
      onClick={(e) => (e.altKey ? onMenu() : frozen ? onResume() : onPause())}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu()
      }}
    >
      <Icon name={frozen ? "play" : "pause"} />
    </button>
  )
}

/** The folder opens the Files window; Option-click or right-click offers a menu of places, as >_ does. */
function FilesButton({ enabled, onOpen, onMenu }: { readonly enabled: boolean; onOpen(): void; onMenu(): void }): JSX.Element {
  const label = t("action.files")
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      aria-label={label}
      aria-haspopup="menu"
      title={t("files.tip")}
      disabled={!enabled}
      onClick={(e) => (e.altKey ? onMenu() : onOpen())}
      onContextMenu={(e) => {
        e.preventDefault()
        if (enabled) onMenu()
      }}
    >
      <Icon name="folder" />
    </button>
  )
}

/**
 * The clock opens Checkpoints, the full-window view of every checkpoint
 * (⌘⇧T, File → Checkpoints…, too); Option-click or right-click offers a
 * native menu with Take a Checkpoint Now, as >_ and the folder do.
 */
function CheckpointsButton({ enabled, open, onOpen, onMenu }: { readonly enabled: boolean; readonly open: boolean; onOpen(): void; onMenu(): void }): JSX.Element {
  const label = t("action.checkpoints")
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      aria-label={label}
      aria-haspopup="menu"
      aria-pressed={open}
      title={t("checkpoints.tip")}
      disabled={!enabled}
      onClick={(e) => (e.altKey ? onMenu() : onOpen())}
      onContextMenu={(e) => {
        e.preventDefault()
        if (enabled) onMenu()
      }}
    >
      <Icon name="history" />
    </button>
  )
}

/**
 * The title bar: which Windows machine (a menu of them all), what is
 * happening, then power, things to do in Windows, and view.
 */
export function Toolbar(p: ToolbarProps): JSX.Element {
  const c = p.controls
  const live = isLivePhase(p.phase)
  const panel = (id: PanelId, icon: IconName, label: string, enabled: boolean, pressed?: boolean): JSX.Element => (
    <ToolButton icon={icon} label={label} enabled={enabled} pressed={pressed} expanded={p.open === id} onClick={(b) => p.onOpen(id, b)} />
  )
  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="toolbar__lead" data-tauri-drag-region>
        <MachinePicker {...p.picker} />
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
        <PauseButton key={isFrozen(p.phase) ? "resume" : "pause"} phase={p.phase} c={c} onPause={p.onPause} onResume={p.onResume} onMenu={p.onPauseMenu} />
      </div>

      <span className="toolbar__divider" aria-hidden="true" />

      <div className="toolbar__group">
        <TerminalButton blocked={p.terminalBlocked} onOpen={p.onTerminal} onMenu={p.onTerminalMenu} />
        <FilesButton enabled={p.guestReady} onOpen={() => p.onOpen("files", document.body)} onMenu={p.onFilesMenu} />
        <CheckpointsButton enabled={p.canCheckpoints} open={p.checkpointsOpen} onOpen={p.onCheckpoints} onMenu={p.onCheckpointsMenu} />
        {panel("share", "agent", t("action.share"), p.canShare || p.sharing, p.sharing)}
      </div>

      <span className="toolbar__divider" aria-hidden="true" />

      <div className="toolbar__group">
        <ToolButton
          icon="keyboard"
          label={t(p.keyboardCaptured ? "input.release" : "input.capture")}
          enabled={c.screen && !isFrozen(p.phase)}
          pressed={p.keyboardCaptured}
          onClick={p.onKeyboardCapture}
        />
        {p.keyboardCaptured && <span className="toolbar__capture-status">{t("input.captured")}</span>}
        <ToolButton
          icon="fit"
          label={t("action.actualSize")}
          enabled={c.screen && p.canActualSize}
          pressed={p.actualSize && p.canActualSize}
          onClick={p.onActualSize}
        />
        <ToolButton icon="screenSharing" label={t("action.screenSharing")} enabled={c.screen} onClick={p.onScreenSharing} />
        <ToolButton icon="panel" label={t("action.details")} enabled pressed={p.detailsOpen} onClick={p.onDetails} />
      </div>
    </header>
  )
}
