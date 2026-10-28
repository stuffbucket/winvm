/**
 * Bundles the viewer UI into dist/, which Tauri serves as the app's frontend:
 * index.html (the main window) and terminal.html (the Terminal window).
 * Bun's bundler takes the HTML entry, its stylesheet and script, as maximal's
 * scripts/build-ui.ts does for its Settings window.
 *
 *   bun scripts/build-ui.ts           one build
 *   bun scripts/build-ui.ts --watch   rebuild on change
 */
import { watch } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

const VIEWER = resolve(import.meta.dir, "..")
const UI = resolve(VIEWER, "ui")
const DIST = resolve(VIEWER, "dist")

async function build(): Promise<void> {
  const started = Date.now()
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })
  const result = await Bun.build({
    entrypoints: [resolve(UI, "index.html"), resolve(UI, "terminal.html")],
    outdir: DIST,
    minify: true,
    sourcemap: "none",
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("the viewer UI did not build")
  }
  console.error(`viewer UI built in ${String(Date.now() - started)} ms → ${DIST}`)
}

await build()

if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | null = null
  watch(UI, { recursive: true }, () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      build().catch((error: unknown) => console.error(error))
    }, 80)
  })
  await new Promise(() => undefined)
}
