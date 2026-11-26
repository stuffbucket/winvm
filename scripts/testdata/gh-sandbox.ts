import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const FAKE = resolve(import.meta.dir, "fake-gh.sh")
const dirs: string[] = []

export interface GhSandbox {
  readonly dir: string
  readonly env: Record<string, string>
}

export function ghSandbox(
  prefix: string,
  subdirs: readonly string[] = [],
): GhSandbox {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  dirs.push(dir)
  for (const sub of ["bin", ...subdirs]) mkdirSync(join(dir, sub))
  copyFileSync(FAKE, join(dir, "bin", "gh"))
  chmodSync(join(dir, "bin", "gh"), 0o755)
  return {
    dir,
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      FAKE_GH_DIR: dir,
      GITHUB_REPOSITORY: "stuffbucket/winvm",
      GH_TOKEN: "x",
    },
  }
}

export function removeGhSandboxes(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export function runBash(
  args: readonly string[],
  env: Record<string, string>,
): { code: number; out: string } {
  const p = Bun.spawnSync(["bash", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}
