/**
 * Renders the main window's screen while the guest takes input and while it
 * does not (paused, asleep, starting), in WebKit against the fake app
 * (tests/render/fake-tauri.js with ?screen=1), in light and dark, and CHECKS
 * what a picture cannot show: over an inert frame the cursor is the Mac's
 * arrow whatever noVNC set on the canvas (the fake sets `none`, the guest's
 * hidden cursor), and a pointer over it reaches the frame, not the canvas.
 *
 * The fake has no VNC server: the screen is a connection to nothing, a
 * desktop is painted into the canvas by hand, and the "lost the screen" note
 * is hidden. The Screen component, its classes and CSS are the real ones.
 *
 *   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install webkit
 *   bun scripts/build-ui.ts
 *   PLAYWRIGHT_DIR=/tmp/pw node scripts/render-screen-input.mjs [out-dir]
 */
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-screen-input-render")
const FAKE = resolve(VIEWER, "tests", "render", "fake-tauri.js")

const dir = process.env.PLAYWRIGHT_DIR
if (dir === undefined) {
  console.error("set PLAYWRIGHT_DIR to a folder with playwright installed (see the comment at the top)")
  process.exit(2)
}
const { webkit } = createRequire(join(resolve(dir), "package.json"))("playwright")
if (!existsSync(join(DIST, "index.html"))) {
  console.error("no dist/index.html: run `bun scripts/build-ui.ts` first")
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" }
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
  const path = join(DIST, url)
  if (!path.startsWith(DIST) || !existsSync(path)) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" })
  createReadStream(path).pipe(res)
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

const browser = await webkit.launch()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failed = true
}

async function open(scheme, state, agent = "ok") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme })
  // The screen's connection is to nothing: WebKit refuses the socket, and that is expected.
  page.on("pageerror", (e) => !e.message.includes("WebSocket") && console.error(`[${scheme}] page error: ${e.message}`))
  await page.addInitScript({ path: FAKE })
  // "starting" is a running machine whose agent is silent.
  await page.goto(`http://127.0.0.1:${String(port)}/index.html?state=${state === "starting" ? "running" : state}&agent=${state === "starting" ? "silent" : agent}&screen=1`)
  await page.waitForSelector(".screen__canvas", { timeout: 8000 })
  await wait(600)
  // A desktop in the canvas, with the cursor noVNC would set for a guest that hides its own.
  await page.evaluate(() => {
    const target = document.querySelector(".screen__canvas")
    const canvas = document.createElement("canvas")
    canvas.width = 1920
    canvas.height = 1200
    canvas.style.cssText = "width:100%;height:100%;cursor:none"
    window.__paintDesktop(canvas.getContext("2d"), 1920, 1200, "Work PC")
    target.replaceChildren(canvas)
    document.querySelector(".screen__message")?.remove()
  })
  await wait(300)
  return page
}

for (const scheme of ["light", "dark"]) {
  for (const state of ["paused", "asleep", "starting"]) {
    const page = await open(scheme, state)
    const seen = await page.evaluate(() => {
      const canvas = document.querySelector(".screen__canvas canvas")
      const r = canvas.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        inert: document.querySelector(".screen").classList.contains("screen--inert"),
        cursor: getComputedStyle(canvas).cursor,
        pointerEvents: getComputedStyle(document.querySelector(".screen__canvas")).pointerEvents,
        hit: hit === null ? null : hit.className,
        capture: document.querySelector("button[aria-label^='Capture Keyboard']")?.disabled ?? null,
        captureTitle: document.querySelector("button[aria-label^='Capture Keyboard']")?.title ?? null,
        overlay: document.querySelector(".screen__held--on") !== null,
      }
    })
    check(seen.inert, `${scheme} ${state}: the frame is inert`)
    check(seen.cursor === "default", `${scheme} ${state}: the cursor over the frame is the Mac's arrow (got ${seen.cursor})`)
    check(seen.pointerEvents === "none", `${scheme} ${state}: the canvas takes no pointer events`)
    check(typeof seen.hit === "string" && seen.hit.includes("screen") && !seen.hit.includes("screen__canvas"), `${scheme} ${state}: a pointer in the middle lands on the frame, not the canvas (${String(seen.hit)})`)
    check(seen.capture === true && seen.captureTitle !== null && seen.captureTitle.includes("Windows"), `${scheme} ${state}: Capture Keyboard is off and says why (${String(seen.captureTitle)})`)
    if (state === "paused") check(seen.overlay, `${scheme} ${state}: the pause overlay shows`)
    await page.screenshot({ path: join(OUT, `${scheme}-${state}.png`) })
    await page.close()
  }
}

// The same frame with the guest taking input: the canvas's own cursor, pointer events on.
for (const scheme of ["light", "dark"]) {
  const page = await open(scheme, "running")
  await page.evaluate(() => document.querySelector(".screen").classList.remove("screen--inert"))
  const seen = await page.evaluate(() => ({
    cursor: getComputedStyle(document.querySelector(".screen__canvas canvas")).cursor,
    pointerEvents: getComputedStyle(document.querySelector(".screen__canvas")).pointerEvents,
    capture: document.querySelector("button[aria-label^='Capture Keyboard']")?.disabled ?? null,
  }))
  check(seen.cursor === "none", `${scheme} running: the guest's own cursor is left alone (got ${seen.cursor})`)
  check(seen.pointerEvents !== "none", `${scheme} running: the canvas takes pointer events`)
  check(seen.capture === false, `${scheme} running: Capture Keyboard is on`)
  await page.screenshot({ path: join(OUT, `${scheme}-running.png`) })
  await page.close()
}

await browser.close()
server.close()
console.log(`pictures in ${OUT}`)
process.exit(failed ? 1 : 0)
