import { z } from "zod"

import { readSettings, writeSettings } from "../../backend"
import {
  type Member,
  normalizeSections,
  type Section,
  soundMembers,
} from "./sections"

const Move = z.object({ x: z.number(), y: z.number() })

export interface SectionSet {
  readonly list: readonly Section[]
  readonly members: Readonly<Record<string, Member>>
}

const MOST_SECTIONS = 500

function soundSet(raw: unknown): SectionSet | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as { readonly list?: unknown; readonly members?: unknown }
  const list = normalizeSections(
    Array.isArray(r.list) ? (r.list as unknown[]).slice(0, MOST_SECTIONS) : [],
  )
  const members = soundMembers(r.members, list)
  return list.length === 0 ? null : { list, members }
}

const Settings = z
  .object({
    showAutomatic: z.boolean().catch(true).default(true),
    zoom: z.number().positive().nullable().catch(null).default(null),
    layouts: z
      .record(z.string(), z.record(z.string(), Move))
      .catch({})
      .default({}),
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
  .loose()

export interface CheckpointSettings {
  readonly showAutomatic: boolean
  readonly zoom: number | null
  readonly layouts: Record<string, Record<string, { x: number; y: number }>>
  readonly sections?: Record<string, SectionSet> | undefined
}

export const DEFAULT_SETTINGS: CheckpointSettings = {
  showAutomatic: true,
  zoom: null,
  layouts: {},
}

const SECTION = "checkpoints"

export function parseSettings(raw: unknown): CheckpointSettings {
  const r = Settings.safeParse(raw ?? {})
  return r.success ? r.data : DEFAULT_SETTINGS
}

export const loadSettings = async (): Promise<CheckpointSettings> =>
  parseSettings(await readSettings(SECTION))

export const saveSettings = (s: CheckpointSettings): Promise<void> =>
  writeSettings(SECTION, s)
