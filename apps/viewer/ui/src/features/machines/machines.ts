/**
 * Windows machines (the CLI's instances): what the picker shows and what the
 * New and Delete flows run. Pure, so the tests cover it.
 */
import { z } from "zod"

import { isLivePhase, type Phase, TITLE_MAX } from "../../model"

/** A new machine's name: the CLI's rule (packages/core/src/args.ts isValidInstanceName). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type NameProblem = "empty" | "invalid" | "taken"

/** Why `name` can't be a new machine's name (an i18n key's last word), or null when it can. */
export function nameProblem(name: string, existing: readonly string[]): NameProblem | null {
  const n = name.trim()
  if (n === "") return "empty"
  if (!NAME.test(n)) return "invalid"
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return "taken"
  return null
}

/** The picker's word for a machine's state: Running, Starting, Paused, Asleep, Stopped, Saved (a stowed machine), Not set up. */
export const stateKey = (p: Phase): string => `machine.state.${p}`

export type TitleProblem = "long" | "control"

/**
 * Why `title` can't be a machine's title (an i18n key's last word), or null when
 * it can: core's checkTitle (packages/core/src/config.ts), which `winvm config`
 * enforces too. Empty is no problem here; it clears the title.
 */
export function titleProblem(title: string): TitleProblem | null {
  const typed = title.trim()
  if ([...typed].length > TITLE_MAX) return "long"
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(typed)) return "control"
  return null
}

/** What committing a typed title does: set it, clear it (back to the machine's name), or nothing. */
export function titleEdit(typed: string, shown: string, hasTitle: boolean): "set" | "clear" | "none" {
  const next = typed.trim()
  if (next === "") return hasTitle ? "clear" : "none"
  return next === shown ? "none" : "set"
}

/** A state's dot differs in shape as well as colour: filled (on), half (idle), ring with a centre (saved), empty ring (off). */
export type StateShape = "on" | "idle" | "saved" | "off"

export function stateShape(p: Phase): StateShape {
  switch (p) {
    case "running":
    case "starting":
      return "on"
    case "paused":
    case "asleep":
      return "idle"
    case "stowed":
      return "saved"
    default:
      return "off"
  }
}

/** Live machines must be off before they can go. */
export const isLive = (p: Phase | null | undefined): boolean => isLivePhase(p)

/** `winvm create`: a new machine from an image, not started. */
export const createArgs = (name: string, image: string | null): string[] => ["create", "-i", name.trim(), ...(image === null ? [] : ["--image", image])]

/** `winvm destroy`: the machine's disk, and its saves unless kept. */
export const destroyArgs = (name: string, keepSaves: boolean): string[] => ["destroy", "-i", name, ...(keepSaves ? ["--keep-saves"] : [])]

const Ls = z.object({ images: z.array(z.object({ name: z.string() })) })

/** The images a machine can be made from, from `winvm ls --json`. */
export function parseImages(stdout: string): string[] {
  try {
    return Ls.safeParse(JSON.parse(stdout)).data?.images.map((i) => i.name) ?? []
  } catch {
    return []
  }
}

/** Which machine to show after one is deleted: the next in the list, else the one before, else none. */
export function nextAfterDelete(names: readonly string[], gone: string): string | null {
  const i = names.indexOf(gone)
  const rest = names.filter((n) => n !== gone)
  if (rest.length === 0) return null
  return rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? null
}
