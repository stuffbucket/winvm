/**
 * The XDG base directories winvm keeps per-user files in, honouring the
 * XDG_* variables (an empty or relative value is ignored, as the spec says):
 *
 *   config   $XDG_CONFIG_HOME/winvm   default ~/.config/winvm        (settings.json)
 *   data     $XDG_DATA_HOME/winvm     default ~/.local/share/winvm
 *
 * Instances, images and saves are not here: they live under WINVM_HOME
 * (paths.ts). This is for what belongs to the user rather than to a machine.
 */
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

type Env = Readonly<Record<string, string | undefined>>

function base(env: Env, variable: string, fallback: readonly string[]): string {
  const set = env[variable]
  if (set !== undefined && set !== "" && isAbsolute(set)) return resolve(set)
  return resolve(env["HOME"] ?? homedir(), ...fallback)
}

/** winvm's config directory: user settings. */
export const configDir = (env: Env = process.env): string => resolve(base(env, "XDG_CONFIG_HOME", [".config"]), "winvm")

/** winvm's data directory: things the user keeps that are not settings. */
export const dataDir = (env: Env = process.env): string => resolve(base(env, "XDG_DATA_HOME", [".local", "share"]), "winvm")
