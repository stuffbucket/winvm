/**
 * The user's own files, where the XDG Base Directory spec puts them — kept
 * apart from the machine state under WINVM_HOME (paths.ts), which is tens of
 * GB and safe to throw away. What lives here is small, typed by a person, and
 * not to be lost with a VM:
 *
 *   configDir()   $XDG_CONFIG_HOME/winvm (~/.config/winvm)
 *     settings.json         the viewer's and the CLI's preferences
 *   dataDir()     $XDG_DATA_HOME/winvm (~/.local/share/winvm)
 *     notes/<instance>/<save>.json   a person's notes on a save (notes.ts)
 *
 * Per the spec, a variable that is unset, empty, or not an absolute path is
 * ignored and the default used.
 */
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

function base(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  const v = env[variable]
  if (v !== undefined && v !== "" && isAbsolute(v)) return resolve(v, "winvm")
  const h = env["HOME"]
  return resolve(h !== undefined && h !== "" ? h : homedir(), fallback, "winvm")
}

/** $XDG_CONFIG_HOME/winvm, default ~/.config/winvm */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return base(env, "XDG_CONFIG_HOME", ".config")
}

/** $XDG_DATA_HOME/winvm, default ~/.local/share/winvm */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return base(env, "XDG_DATA_HOME", ".local/share")
}
