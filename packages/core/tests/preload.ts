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
function install(name: string, body: string): string {
  const path = resolve(bin, name)
  const scratch = `${path}.${String(process.pid)}`
  writeFileSync(scratch, `#!/bin/sh\n${body}\n`)
  chmodSync(scratch, 0o755)
  renameSync(scratch, path)
  return path
}
const fake = (name: string, script: string): string =>
  install(
    name,
    `exec "${process.execPath}" "${resolve(import.meta.dir, "fakes", script)}" "$@"`,
  )
process.env.WINVM_KEEPER = fake("winvm-keeper", "keeper.ts")
process.env.WINVM_FAKE_KEEPER = process.env.WINVM_KEEPER
fake("launchctl", "launchctl.ts")
install("ioreg", `echo '"HIDIdleTime" = 3600000000000'`)
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
process.env.XDG_DATA_HOME = resolve(bin, "data")
