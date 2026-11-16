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

export function quiet(cmd: string, args: readonly string[]): number {
  return spawnSync(cmd, [...args], { stdio: "ignore" }).status ?? 1
}

export function have(cmd: string): boolean {
  return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0
}

export function du(path: string): string {
  if (!existsSync(path)) return "-"
  return capture("du", ["-sh", path]).split(/\s+/)[0] ?? "-"
}

export function download(url: string, dest: string, sha256?: string): void {
  if (existsSync(dest)) {
    if (sha256 === undefined || sha256Of(dest) === sha256) return
    console.warn(`warning: ${basename(dest)} does not match its pin; re-fetching`)
    rmSync(dest, { force: true })
  }
  mkdirSync(resolve(dest, ".."), { recursive: true })
  console.log(`fetching ${basename(dest)}`)
  if (run("curl", ["-fL", "--progress-bar", "-o", dest, url]) !== 0) {
    rmSync(dest, { force: true })
    throw new Error(`download failed: ${url}`)
  }
  if (sha256 === undefined) return
  const got = sha256Of(dest)
  if (got === sha256) return
  rmSync(dest, { force: true })
  throw new Error(
    `${basename(dest)} does not match its pinned digest.\n` +
      `  expected ${sha256}\n  got      ${got}\n` +
      `  Upstream has probably published a new build. Review it, then update ` +
      `TOOLS_SHA256 in host.ts to the new digest.`,
  )
}
