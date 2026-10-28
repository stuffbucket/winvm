/**
 * The shared Mac folder (`winvm share`): the commands the panel runs and the
 * words it shows. Pure, so the rules are tested without the app.
 */
import type { Output } from "../../backend"
import { outputText } from "../../backend"
import type { SharedFolderStatus } from "../../model"

export const statusArgs = (instance: string): string[] => ["share", "-i", instance, "status", "--json"]

/** Shares `path` as drive `letter`; without `readonly`, Windows can change it. */
export const setArgs = (instance: string, path: string, letter: string, readonly: boolean): string[] => [
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

export const clearArgs = (instance: string): string[] => ["share", "-i", instance, "clear", "--json"]

/** The one-time setup in Windows; it restarts Windows (twice) as it goes. */
export const installArgs = (instance: string): string[] => ["share", "-i", instance, "install", "--restart", "--json"]

/** What a failed `winvm` said: its `::error::` lines without the marker, else everything it printed. */
export function cliError(out: Output): string {
  const marked = `${out.stderr}\n${out.stdout}`
    .split("\n")
    .map((l) => /^\s*::error::\s*(.*)$/.exec(l)?.[1]?.trim())
    .filter((l): l is string => l !== undefined && l !== "")
  return marked.length > 0 ? marked.join("\n") : outputText(out)
}

/** A Mac path as Finder people read it: the home folder as `~`. */
export function homePath(path: string, home: string | null): string {
  if (home === null || home === "" || home === "/") return path
  const h = home.endsWith("/") ? home.slice(0, -1) : home
  if (path === h) return "~"
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

/** How many characters at the end of a shown path stay whole when it doesn't fit: its last part, within reason. */
export function tailToKeep(shown: string): number {
  const slash = shown.lastIndexOf("/")
  const last = slash < 0 ? shown.length : shown.length - slash
  return Math.min(Math.max(last, 8), 16, shown.length)
}

/** Windows' setup is wanted: a folder is shared and Windows says it lacks the driver. */
export const needsSetup = (s: SharedFolderStatus | null): boolean => s !== null && s.available && s.folder !== null && s.guest.installed === false

/** The section's one-word state beside its title, as an i18n key and values; null when there's nothing to say. */
export function sectionHint(s: SharedFolderStatus | null): { key: string; values?: Record<string, string> } | null {
  if (s === null || !s.available) return null
  if (s.folder === null) return { key: "folder.hintOff" }
  return { key: "folder.hintOn", values: { letter: s.letter } }
}
