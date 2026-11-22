import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const keeper = process.env.WINVM_KEEPER
if (process.env.WINVM_TEST_KEEPER === undefined && keeper !== undefined)
  process.env.WINVM_TEST_KEEPER = keeper

const bin = resolve(
  tmpdir(),
  `winvm-test-bin-${createHash("sha256")
    .update(import.meta.dir)
    .digest("hex")
    .slice(0, 8)}`,
)
mkdirSync(bin, { recursive: true })
function fake(name: string, script: string): string {
  const path = resolve(bin, name)
  const scratch = `${path}.${String(process.pid)}`
  writeFileSync(
    scratch,
    `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dir, "fakes", script)}" "$@"\n`,
  )
  chmodSync(scratch, 0o755)
  renameSync(scratch, path)
  return path
}
process.env.WINVM_KEEPER = fake("winvm-keeper", "keeper.ts")
process.env.WINVM_FAKE_KEEPER = process.env.WINVM_KEEPER
fake("launchctl", "launchctl.ts")
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
process.env.XDG_DATA_HOME = resolve(bin, "data")
