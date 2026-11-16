import { z } from "zod"

import { readSettings, writeSettings } from "../../backend"

const Settings = z.object({
  showAutomatic: z.boolean().catch(true).default(true),
  zoom: z.number().positive().nullable().catch(null).default(null),
})

export type CheckpointSettings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: CheckpointSettings = { showAutomatic: true, zoom: null }

const SECTION = "checkpoints"

export function parseSettings(raw: unknown): CheckpointSettings {
  const r = Settings.safeParse(raw ?? {})
  return r.success ? r.data : DEFAULT_SETTINGS
}

export const loadSettings = async (): Promise<CheckpointSettings> => parseSettings(await readSettings(SECTION))

export const saveSettings = (s: CheckpointSettings): Promise<void> => writeSettings(SECTION, s)
