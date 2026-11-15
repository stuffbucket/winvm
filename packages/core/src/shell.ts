import { type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { basename, resolve } from "node:path"

export const sha256Of = (path: string): string => capture("shasum", ["-a", "256", path]).split(/\s+/)[0] ?? ""

export function run(cmd: string, args: readonly string[]): number {
  return spawnSync(cmd, [...args], { stdio: "inherit" }).status ?? 1
}

export type TextResult = Omit<SpawnSyncReturns<string>, "stdout" | "stderr"> & { readonly stdout: string; readonly stderr: string }

export function spawnText(cmd: string, args: readonly string[], o: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}): TextResult {
  const r = spawnSync(cmd, [...args], { ...o, encoding: "utf8" })
  const streams: { readonly stdout: string | null; readonly stderr: string | null } = r
  return { ...r, stdout: streams.stdout ?? "", stderr: streams.stderr ?? "" }
}

export function capture(cmd: string, args: readonly string[]): string {
  return spawnText(cmd, args).stdout.trim()
}

/** Like `run`, but silent — for probes whose failure is expected and handled by the caller. */
export function quiet(cmd: string, args: readonly string[]): number {
  return spawnSync(cmd, [...args], { stdio: "ignore" }).status ?? 1
}

export function have(cmd: string): boolean {
  return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0
}

/**
 * Human-readable size, for `winvm ls`. Overlays and base images differ by orders
 * of magnitude.
 *
 * `-s` is load-bearing now that directories are measured too: plain `du -h`
 * prints a line per subdirectory and the first one is NOT the total, so a state
 * directory holding a 14 GB image reported 128 MB.
 */
export function du(path: string): string {
  if (!existsSync(path)) return "-"
  return capture("du", ["-sh", path]).split(/\s+/)[0] ?? "-"
}

export function download(url: string, dest: string, sha256?: string): void {
  if (existsSync(dest)) {
    if (sha256 === undefined || sha256Of(dest) === sha256) return
    // A cached file that no longer matches is not silently re-used.
    console.warn(`warning: ${basename(dest)} does not match its pin; re-fetching`)
    rmSync(dest, { force: true })
  }
  mkdirSync(resolve(dest, ".."), { recursive: true })
  console.log(`fetching ${basename(dest)}`)
  if (run("curl", ["-fL", "--progress-bar", "-o", dest, url]) !== 0) {
    // A truncated file that looks present is worse than one that is absent:
    // the next run would skip the download and fail somewhere unrelated.
    rmSync(dest, { force: true })
    throw new Error(`download failed: ${url}`)
  }
  if (sha256 === undefined) return
  const got = sha256Of(dest)
  if (got === sha256) return
  // The pin's job is to DETECT drift, not to prevent it. Upstream publishing a
  // new build is expected and legitimate; adopting it silently is not.
  rmSync(dest, { force: true })
  throw new Error(
    `${basename(dest)} does not match its pinned digest.\n` +
      `  expected ${sha256}\n  got      ${got}\n` +
      `  Upstream has probably published a new build. Review it, then update ` +
      `TOOLS_SHA256 in host.ts to the new digest.`,
  )
}
