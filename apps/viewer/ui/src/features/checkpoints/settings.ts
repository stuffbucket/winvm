/**
 * The checkpoints view's settings, kept in `$XDG_CONFIG_HOME/winvm/settings.json`
 * under "checkpoints" (the app's Rust side reads and writes the file:
 * src-tauri/src/checkpoints.rs).
 */
import { z } from "zod"

import { readSettings, writeSettings } from "../../backend"

const Settings = z.object({
  /** Show autosaves and the stow along with the checkpoints people took. */
  showAutomatic: z.boolean().catch(true).default(true),
  /** The zoom the view was left at, to open at again; null: fit the newest. */
  zoom: z.number().positive().nullable().catch(null).default(null),
})

export type CheckpointSettings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: CheckpointSettings = { showAutomatic: true, zoom: null }

export const SECTION = "checkpoints"

/** Whatever is in the file, made sound: unknown or broken values fall back to the defaults. */
export function parseSettings(raw: unknown): CheckpointSettings {
  const r = Settings.safeParse(raw ?? {})
  return r.success ? r.data : DEFAULT_SETTINGS
}

export const loadSettings = async (): Promise<CheckpointSettings> => parseSettings(await readSettings(SECTION))

export const saveSettings = (s: CheckpointSettings): Promise<void> => writeSettings(SECTION, s)
