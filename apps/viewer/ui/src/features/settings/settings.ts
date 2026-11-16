import { z } from "zod"

import type { Output } from "../../backend"

export interface ViewerSettings {
  readonly pauseOverlay: boolean
}

export const DEFAULT_SETTINGS: ViewerSettings = { pauseOverlay: true }

const Stored = z
  .object({ "viewer.pauseOverlay": z.boolean().optional() })
  .loose()

export function parseSettings(stdout: string): ViewerSettings {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return DEFAULT_SETTINGS
  }
  const s = Stored.safeParse(raw).data
  return {
    pauseOverlay: s?.["viewer.pauseOverlay"] ?? DEFAULT_SETTINGS.pauseOverlay,
  }
}

export const pauseOverlayArgs = (on: boolean): string[] => [
  "settings",
  `viewer.pauseOverlay=${String(on)}`,
]

type Run = (...args: string[]) => Promise<Output>

export async function loadSettings(run: Run): Promise<ViewerSettings> {
  try {
    const out = await run("settings", "--json")
    return out.code === 0 ? parseSettings(out.stdout) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function savePauseOverlay(
  run: Run,
  on: boolean,
): Promise<string | null> {
  try {
    const out = await run(...pauseOverlayArgs(on))
    return out.code === 0
      ? null
      : out.stderr.trim() || `winvm settings exited ${String(out.code)}`
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
