import { controls, isLivePhase, type Phase } from "../../model"

/** Same enablement as the toolbar, with modal/background safety for native commands. */
export function nativeMenuState(p: { phase: Phase | null; busy: boolean; hostReady: boolean; instance: boolean; forwardInput: boolean; resizable: boolean; modal: boolean }): Record<string, boolean> {
  const c = controls(p.phase ?? "missing", p.busy || p.phase === null || !p.hostReady)
  const available = !p.modal
  const has = available && p.instance && p.phase !== null && p.phase !== "missing"
  return {
    "settings": available,
    "vm-new": available && !p.busy,
    "vm-choose": available && !p.busy,
    "vm-delete": has && !p.busy,
    "vm-start": available && c.start,
    "vm-stop": available && c.shutDown,
    "vm-reboot": available && c.restart,
    "vm-pause": available && c.pause,
    "vm-resume": available && c.resume,
    "vm-sleep": available && c.sleep,
    "vm-lock": available && c.lock,
    "vm-kill": available && isLivePhase(p.phase) && !p.busy,
    "vm-save": available && !p.busy && (p.phase === "running" || p.phase === "paused"),
    "vm-files": available && c.terminal,
    "vm-files-menu": available && c.terminal,
    "vm-shells": available && c.terminal,
    "vm-share": has,
    "view-actual-size": available && c.screen && !p.resizable,
    "view-screen-sharing": available && c.screen,
    "view-details": available,
    "view-pause-overlay": available,
    "capture-keyboard": available && c.screen && p.forwardInput,
    "release-keyboard": true,
    "send-windows-key": available && c.screen && p.forwardInput,
    "send-ctrl-alt-delete": available && c.screen && p.forwardInput,
  }
}
