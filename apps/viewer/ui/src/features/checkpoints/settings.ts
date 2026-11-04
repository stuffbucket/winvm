/**
 * The checkpoints view's settings, kept in `$XDG_CONFIG_HOME/winvm/settings.json`
 * under "checkpoints" (the app's Rust side reads and writes the file:
 * src-tauri/src/checkpoints.rs).
 *
 * Besides the zoom and the filter: where cards were moved to (`layouts`, by
 * machine) and each machine's sections with who is in them (`sections`,
 * see sections.ts), written whole through `winvm settings --section`, the
 * file's one writer. Unknown keys are kept.
 */
import { z } from "zod"

import { readSettings, writeSettings } from "../../backend"
import { type Member, normalizeSections, type Section, soundMembers } from "./sections"

/** How far a card has been moved from where winvm put it, in world units. */
const Move = z.object({ x: z.number().finite(), y: z.number().finite() })

/** A machine's sections and which checkpoints are in them (each with its place relative to the section). */
export interface SectionSet {
  readonly list: readonly Section[]
  readonly members: Readonly<Record<string, Member>>
}

/** No more than this many sections per machine are read: the file is a person's, but not to be trusted to be small. */
const MOST_SECTIONS = 500

/** Whatever is stored for a machine's sections, made sound: sections on the grid that don't touch, members of sections that are there. Empty: null. */
function soundSet(raw: unknown): SectionSet | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as { readonly list?: unknown; readonly members?: unknown }
  const list = normalizeSections(Array.isArray(r.list) ? (r.list as unknown[]).slice(0, MOST_SECTIONS) : [])
  const members = soundMembers(r.members, list)
  return list.length === 0 ? null : { list, members }
}

const Settings = z
  .object({
    /** Show autosaves and the stow along with the checkpoints people took. */
    showAutomatic: z.boolean().catch(true).default(true),
    /** The zoom the view was left at, to open at again; null: fit the newest. */
    zoom: z.number().positive().nullable().catch(null).default(null),
    /** Cards the person has moved, by machine and then checkpoint name. A machine or card that isn't there is where winvm put it. */
    layouts: z.record(z.string(), z.record(z.string(), Move)).catch({}).default({}),
    /** Sections, by machine: named containers a person draws round checkpoints. A machine with none has no entry, and with none at all there is no key. */
    sections: z
      .record(z.string(), z.unknown())
      .optional()
      .catch(undefined)
      .transform((all) => {
        const sound = Object.fromEntries(
          Object.entries(all ?? {}).flatMap(([machine, raw]) => {
            const set = soundSet(raw)
            return set === null ? [] : [[machine, set] as const]
          }),
        )
        return Object.keys(sound).length === 0 ? undefined : sound
      }),
  })
  // Keys this version doesn't know are kept when the section is written back (a newer or older app's).
  .passthrough()

export interface CheckpointSettings {
  readonly showAutomatic: boolean
  readonly zoom: number | null
  readonly layouts: Record<string, Record<string, { x: number; y: number }>>
  /** Absent when no machine has a section. */
  readonly sections?: Record<string, SectionSet> | undefined
}

export const DEFAULT_SETTINGS: CheckpointSettings = { showAutomatic: true, zoom: null, layouts: {} }

export const SECTION = "checkpoints"

/** Whatever is in the file, made sound: unknown or broken values fall back to the defaults. */
export function parseSettings(raw: unknown): CheckpointSettings {
  const r = Settings.safeParse(raw ?? {})
  return r.success ? (r.data as CheckpointSettings) : DEFAULT_SETTINGS
}

export const loadSettings = async (): Promise<CheckpointSettings> => parseSettings(await readSettings(SECTION))

export const saveSettings = (s: CheckpointSettings): Promise<void> => writeSettings(SECTION, s)
