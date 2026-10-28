/**
 * The person's own settings for the app, kept by winvm in
 * `$XDG_CONFIG_HOME/winvm/settings.json` (`winvm settings`), so they follow
 * the person rather than a machine. Read once when the window opens; written
 * when changed.
 */
import { z } from "zod"

import type { Output } from "../../backend"

export interface ViewerSettings {
  /** Dim a paused or asleep machine's screen and mark it with a glyph. Off for clean screenshots. */
  readonly pauseOverlay: boolean
}

export const DEFAULT_SETTINGS: ViewerSettings = { pauseOverlay: true }

const Stored = z.object({ "viewer.pauseOverlay": z.boolean().optional() }).passthrough()

/** `winvm settings --json`; anything missing or unreadable is the default. */
export function parseSettings(stdout: string): ViewerSettings {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return DEFAULT_SETTINGS
  }
  const s = Stored.safeParse(raw).data
  return { pauseOverlay: s?.["viewer.pauseOverlay"] ?? DEFAULT_SETTINGS.pauseOverlay }
}

/** The `winvm settings` assignment that stores the overlay setting. */
export const pauseOverlayArgs = (on: boolean): string[] => ["settings", `viewer.pauseOverlay=${String(on)}`]

type Run = (...args: string[]) => Promise<Output>

/** The settings as stored; the defaults when winvm can't say. */
export async function loadSettings(run: Run): Promise<ViewerSettings> {
  try {
    const out = await run("settings", "--json")
    return out.code === 0 ? parseSettings(out.stdout) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Stores the overlay setting; resolves with why it couldn't, or null. */
export async function savePauseOverlay(run: Run, on: boolean): Promise<string | null> {
  try {
    const out = await run(...pauseOverlayArgs(on))
    return out.code === 0 ? null : out.stderr.trim() || `winvm settings exited ${String(out.code)}`
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
