import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const MANIFEST = resolve(ROOT, "native", "keeper", "Cargo.toml")
const BUILT = resolve(
  ROOT,
  "native",
  "keeper",
  "target",
  "release",
  "winvm-keeper",
)
const out = resolve(
  import.meta.dir,
  "..",
  "src-tauri",
  "binaries",
  "winvm-keeper-aarch64-apple-darwin",
)

const r = spawnSync(
  "cargo",
  ["build", "--release", "--locked", "--manifest-path", MANIFEST],
  {
    stdio: "inherit",
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "15.0" },
  },
)
if (r.status !== 0) process.exit(r.status ?? 1)
mkdirSync(resolve(out, ".."), { recursive: true })
copyFileSync(BUILT, out)
chmodSync(out, 0o755)
console.log(out)
