import type { Output } from "../../backend"
import { outputText } from "../../backend"
import type { SharedFolderStatus } from "../../model"

export const statusArgs = (instance: string): string[] => [
  "share",
  "-i",
  instance,
  "status",
  "--json",
]

export const setArgs = (
  instance: string,
  path: string,
  letter: string,
  readonly: boolean,
): string[] => [
  "share",
  "-i",
  instance,
  "set",
  path,
  "--letter",
  letter,
  ...(readonly ? ["--readonly"] : []),
  "--json",
]

export const clearArgs = (instance: string): string[] => [
  "share",
  "-i",
  instance,
  "clear",
  "--json",
]

export const installArgs = (instance: string): string[] => [
  "share",
  "-i",
  instance,
  "install",
  "--restart",
  "--json",
]

const marked = (out: Output, mark: string): readonly string[] =>
  `${out.stderr}\n${out.stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(mark))
    .map((l) => l.slice(mark.length).trim())
    .filter((l) => l !== "")

export function cliError(out: Output): string {
  const errors = marked(out, "::error::")
  return errors.length > 0 ? errors.join("\n") : outputText(out)
}

export const cliWarning = (out: Output): string =>
  marked(out, "::warning::").join("\n")

export function homePath(path: string, home: string | null): string {
  if (home === null || home === "" || home === "/") return path
  const h = home.endsWith("/") ? home.slice(0, -1) : home
  if (path === h) return "~"
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

export function tailToKeep(shown: string): number {
  const slash = shown.lastIndexOf("/")
  const last = slash < 0 ? shown.length : shown.length - slash
  return Math.min(Math.max(last, 8), 16, shown.length)
}

export const needsSetup = (s: SharedFolderStatus | null): boolean =>
  s?.available === true && s.folder !== null && s.guest.installed === false

export function sectionHint(
  s: SharedFolderStatus | null,
): { key: string; values?: Record<string, string> } | null {
  if (s === null || !s.available) return null
  if (s.folder === null) return { key: "folder.hintOff" }
  return { key: "folder.hintOn", values: { letter: s.letter } }
}
