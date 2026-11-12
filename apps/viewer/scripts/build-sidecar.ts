import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

import { sourceBuildIdentity } from "../../../packages/core/src/identity"

const ROOT = resolve(import.meta.dir, "..", "..", "..")
const out = resolve(import.meta.dir, "..", "src-tauri", "binaries", "winvm-aarch64-apple-darwin")
mkdirSync(resolve(out, ".."), { recursive: true })
// Computed before compilation and embedded, so the executable reports the
// identity of the sources it was built from without reading any file at run time.
const identity = sourceBuildIdentity(ROOT)
const r = spawnSync(
  "bun",
  [
    "build",
    "--compile",
    "--target=bun-darwin-arm64",
    `--define=WINVM_BUILD_ID=${JSON.stringify(identity)}`,
    resolve(ROOT, "apps", "cli", "src", "winvm.ts"),
    "--outfile",
    out,
  ],
  { stdio: "inherit" },
)
if (r.status !== 0) process.exit(r.status ?? 1)
console.log(out)
console.log(identity)
