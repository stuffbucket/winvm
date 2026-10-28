/**
 * The Pause button's menu (Option-click or right-click): whether a held
 * machine's screen is dimmed, then Sleep and Lock. Pure: the rows, which the
 * app hands to a native menu.
 */
import type { Action } from "../../backend"
import type { Controls } from "../../model"

export interface PauseMenuOptions {
  readonly t: (key: string) => string
  readonly overlay: boolean
  readonly controls: Pick<Controls, "sleep" | "lock">
  setOverlay(on: boolean): void
  sleep(): void
  lock(): void
}

export function pauseMenu(o: PauseMenuOptions): Action[] {
  return [
    { kind: "action", label: o.t("menu.pauseOverlay"), checked: o.overlay, run: () => o.setOverlay(!o.overlay) },
    { kind: "separator" },
    { kind: "action", label: o.t("action.sleep"), enabled: o.controls.sleep, run: () => o.sleep() },
    { kind: "action", label: o.t("action.lock"), enabled: o.controls.lock, run: () => o.lock() },
  ]
}
