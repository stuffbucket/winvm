/**
 * The user's own files, where the XDG Base Directory spec puts them — kept
 * apart from the machine state under WINVM_HOME (paths.ts), which is tens of
 * GB and safe to throw away. What lives here is small, typed by a person, and
 * not to be lost with a VM:
 *
 *   configDir()   $XDG_CONFIG_HOME/winvm (~/.config/winvm)
 *     settings.json         the viewer's and the CLI's preferences (settings.ts)
 *   dataDir()     $XDG_DATA_HOME/winvm (~/.local/share/winvm)
 *     notes/<instance>/<save>.json   a person's notes on a save (notes.ts)
 *
 * Per the spec, a variable that is unset, empty, or not an absolute path is
 * ignored and the default used. An empty HOME falls back to the account's home.
 */
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

type Env = Readonly<Record<string, string | undefined>>

function base(env: Env, variable: string, fallback: readonly string[]): string {
  const set = env[variable]
  if (set !== undefined && set !== "" && isAbsolute(set)) return resolve(set, "winvm")
  const h = env["HOME"]
  return resolve(h !== undefined && h !== "" ? h : homedir(), ...fallback, "winvm")
}

/** winvm's config directory, $XDG_CONFIG_HOME/winvm (default ~/.config/winvm): user settings. */
export const configDir = (env: Env = process.env): string => base(env, "XDG_CONFIG_HOME", [".config"])

/** winvm's data directory, $XDG_DATA_HOME/winvm (default ~/.local/share/winvm): what the user keeps that is not a setting. */
export const dataDir = (env: Env = process.env): string => base(env, "XDG_DATA_HOME", [".local", "share"])
