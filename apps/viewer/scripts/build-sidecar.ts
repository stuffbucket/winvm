import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const out = resolve(import.meta.dir, "..", "src-tauri", "binaries", "winvm-aarch64-apple-darwin")
mkdirSync(resolve(out, ".."), { recursive: true })
const r = spawnSync(
  "bun",
  ["build", "--compile", "--target=bun-darwin-arm64", resolve(ROOT, "apps", "cli", "src", "winvm.ts"), "--outfile", out],
  { stdio: "inherit" },
)
if (r.status !== 0) process.exit(r.status ?? 1)
console.log(out)
