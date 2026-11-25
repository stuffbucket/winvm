import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const PKG = resolve(import.meta.dir, "..")
const VIEWER = resolve(PKG, "../../apps/viewer")
const DIST = join(VIEWER, "dist")
const FAKES = join(VIEWER, "tests", "render")
const OUT = join(PKG, ".ui")

const built = Bun.spawnSync(["bun", join(VIEWER, "scripts", "build-ui.ts")], {
  cwd: VIEWER,
  stdout: "inherit",
  stderr: "inherit",
})
if (built.exitCode !== 0) process.exit(built.exitCode)

rmSync(OUT, { recursive: true, force: true })
cpSync(DIST, OUT, { recursive: true })
for (const fake of ["fake-tauri.js", "fake-help.js"])
  cpSync(join(FAKES, fake), join(OUT, fake))

const PAGES: readonly (readonly [string, string, readonly string[]])[] = [
  ["index.html", "index.html", ["fake-tauri.js"]],
  ["index.html", "help.html", ["fake-tauri.js", "fake-help.js"]],
  ["files.html", "files.html", ["fake-tauri.js", "fake-help.js"]],
  ["terminal.html", "terminal.html", ["fake-tauri.js", "fake-help.js"]],
]

for (const [source, target, fakes] of PAGES) {
  const html = readFileSync(join(DIST, source), "utf8")
  const tags = fakes.map((fake) => `<script src="./${fake}"></script>`).join("")
  const at = html.indexOf("<script")
  if (at === -1) throw new Error(`${source} has no <script> to precede`)
  writeFileSync(
    join(OUT, target),
    `${html.slice(0, at)}${tags}${html.slice(at)}`,
  )
}
console.error(`storybook: staged the viewer UI with its render fakes in ${OUT}`)
