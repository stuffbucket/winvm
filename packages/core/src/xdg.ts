import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

type Env = Readonly<Record<string, string | undefined>>

function base(env: Env, variable: string, fallback: readonly string[]): string {
  const set = env[variable]
  if (set !== undefined && set !== "" && isAbsolute(set)) return resolve(set, "winvm")
  const h = env["HOME"]
  return resolve(h !== undefined && h !== "" ? h : homedir(), ...fallback, "winvm")
}

export const configDir = (env: Env = process.env): string => base(env, "XDG_CONFIG_HOME", [".config"])

export const dataDir = (env: Env = process.env): string => base(env, "XDG_DATA_HOME", [".local", "share"])
