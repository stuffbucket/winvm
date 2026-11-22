import { z } from "zod"

import type { Output } from "../../backend"

export const WEBSITE = "https://stuffbucket.github.io/winvm/"
export const SOURCE = "https://github.com/stuffbucket/winvm"
export const CONTRIBUTORS = [
  { name: "stuffbucket", url: "https://github.com/stuffbucket" },
] as const

const DEVELOPMENT = "0.0.0"
const BUILD_DIGITS = 12

export const isDevelopment = (version: string): boolean =>
  version === "" || version === DEVELOPMENT

export interface AboutDetails {
  readonly runtime: string | null
  readonly cli: string | null
  readonly machines: string | null
  readonly build: string | null
}

export const UNKNOWN: AboutDetails = {
  runtime: null,
  cli: null,
  machines: null,
  build: null,
}

const Version = z.object({ build: z.string(), runtime: z.string() })
const Ls = z.object({ instances: z.array(z.unknown()) })

function json(out: Output): unknown {
  if (out.code !== 0) return null
  try {
    return JSON.parse(out.stdout)
  } catch {
    return null
  }
}

export const shortBuild = (build: string): string =>
  build.replace(/^sha256:/, "").slice(0, BUILD_DIGITS)

export function versionDetails(
  out: Output,
): Pick<AboutDetails, "runtime" | "build"> {
  const v = Version.safeParse(json(out)).data
  if (v === undefined) return { runtime: null, build: null }
  return {
    runtime: v.runtime === "" ? null : v.runtime,
    build: v.build === "" ? null : shortBuild(v.build),
  }
}

export function machineCount(out: Output): string | null {
  const ls = Ls.safeParse(json(out)).data
  return ls === undefined ? null : String(ls.instances.length)
}
