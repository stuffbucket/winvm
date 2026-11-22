import { z } from "zod"

import { isLivePhase, type Phase, TITLE_MAX } from "../../model"

export const MACHINE_NAME_MAX = 64

const NAME = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${String(MACHINE_NAME_MAX - 1)}}$`,
)

export type NameProblem = "empty" | "invalid" | "taken"

export function nameProblem(
  name: string,
  existing: readonly string[],
): NameProblem | null {
  const n = name.trim()
  if (n === "") return "empty"
  if (!NAME.test(n)) return "invalid"
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return "taken"
  return null
}

export const stateKey = (p: Phase): string => `machine.state.${p}`

export type TitleProblem = "long" | "control"

export function titleProblem(title: string): TitleProblem | null {
  const typed = title.trim()
  if (Array.from(typed).length > TITLE_MAX) return "long"
  if (
    /[\p{Cc}\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u.test(
      typed,
    )
  )
    return "control"
  return null
}

export function titleEdit(
  typed: string,
  shown: string,
  hasTitle: boolean,
): "set" | "clear" | "none" {
  const next = typed.trim()
  if (next === "") return hasTitle ? "clear" : "none"
  return next === shown ? "none" : "set"
}

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
    case "stopped":
    case "missing":
      return "off"
  }
}

export const isLive = (p: Phase | null | undefined): boolean => isLivePhase(p)

export const createArgs = (name: string, image: string | null): string[] => [
  "create",
  "-i",
  name.trim(),
  ...(image === null ? [] : ["--image", image]),
]

export const destroyArgs = (name: string, keepSaves: boolean): string[] => [
  "destroy",
  "-i",
  name,
  ...(keepSaves ? ["--keep-saves"] : []),
]

const Ls = z.object({ images: z.array(z.object({ name: z.string() })) })

export function parseImages(stdout: string): string[] {
  try {
    return (
      Ls.safeParse(JSON.parse(stdout)).data?.images.map((i) => i.name) ?? []
    )
  } catch {
    return []
  }
}

export function nextAfterDelete(
  names: readonly string[],
  gone: string,
): string | null {
  const i = names.indexOf(gone)
  const rest = names.filter((n) => n !== gone)
  if (rest.length === 0) return null
  return rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? null
}
