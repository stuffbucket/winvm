/**
 * Renders a suspended machine's screen in WebKit (the engine Tauri uses on
 * macOS) against the fake app (tests/render/fake-tauri.js), in light and dark:
 *
 *   a. empty note, with a screenshot behind it
 *   b. empty note, no screenshot (the drawn wallpaper)
 *   c. a long note, which has grown until the heading reached the top
 *
 * and measures what a picture cannot show: the Start button and the facts must
 * not move as the note grows (nothing below the note moves), the heading rises
 * with it, and at the top it stops (and the note scrolls inside).
 *
 *   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install webkit
 *   bun scripts/build-ui.ts
 *   PLAYWRIGHT_DIR=/tmp/pw node scripts/render-overview.mjs [out-dir]
 */
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-overview-render")
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
const LINE = "Licence key is in the drawer. Office is not installed yet; ask before adding it. The display looks soft at the default size."
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failed = true
}

async function open(scheme, query, size = { width: 1280, height: 820 }) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2, colorScheme: scheme })
  page.on("pageerror", (e) => console.error(`[${scheme}] page error: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[${scheme}] console: ${m.text()}`)
  })
  await page.addInitScript({ path: FAKE })
  await page.goto(`http://127.0.0.1:${String(port)}/index.html?state=stowed${query}`)
  await page.waitForSelector(".notes__field")
  await wait(900)
  return page
}

const box = async (page, selector) => (await page.locator(selector).first().boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }

for (const scheme of ["dark", "light"]) {
  const a = await open(scheme, "")
  await a.screenshot({ path: join(OUT, `${scheme}-a-empty-with-picture.png`) })
  await a.close()

  const b = await open(scheme, "&pictures=none")
  await b.screenshot({ path: join(OUT, `${scheme}-b-empty-no-picture.png`) })
  await b.close()

  // c. Type until the heading reaches the top; watch what moves.
  const c = await open(scheme, "")
  const field = c.locator(".notes__field")
  const start0 = await box(c, ".overview .btn--primary")
  const facts0 = await box(c, ".facts")
  const title0 = await box(c, ".overview__title")
  const display = await box(c, ".display")
  await field.click()
  let last = title0
  let stoppedAt = null
  for (let i = 1; i <= 40; i += 1) {
    await field.pressSequentially(`${LINE}\n`, { delay: 0 })
    const title = await box(c, ".overview__title")
    if (i === 3) await c.screenshot({ path: join(OUT, `${scheme}-c-note-growing.png`) })
    if (stoppedAt === null && Math.abs(title.y - last.y) < 0.5 && i > 1) stoppedAt = i
    last = title
  }
  await wait(300)
  const start1 = await box(c, ".overview .btn--primary")
  const facts1 = await box(c, ".facts")
  const title1 = await box(c, ".overview__title")
  const notes1 = await box(c, ".notes")
  const top = display.y + (await c.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".overview__content")).paddingTop)))
  check(start0.y === start1.y && start0.x === start1.x, `${scheme}: the Start button did not move (${String(start0.y)} -> ${String(start1.y)})`)
  check(facts0.y === facts1.y, `${scheme}: the facts did not move (${String(facts0.y)} -> ${String(facts1.y)})`)
  check(title1.y < title0.y - 20,`${scheme}: the heading rose (${title0.y.toFixed(1)} -> ${title1.y.toFixed(1)})`)
  check(Math.abs(title1.y - top) <= 1, `${scheme}: it stopped at the top of the display plus the column's top padding (${title1.y.toFixed(1)} vs ${top.toFixed(1)})`)
  check(stoppedAt !== null, `${scheme}: it stopped rising after ${String(stoppedAt)} lines`)
  const scroll = await field.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
  check(scroll.scrollHeight > scroll.clientHeight + 20, `${scheme}: the note scrolls inside (${String(scroll.scrollHeight)} > ${String(scroll.clientHeight)})`)
  check(notes1.y + notes1.height <= start1.y, `${scheme}: the note ends above the controls`)
  await c.screenshot({ path: join(OUT, `${scheme}-c-note-at-top.png`) })

  // The note saves when the field is left.
  await c.keyboard.press("Escape")
  await wait(300)
  const writes = await c.evaluate(() => window.__noteWrites?.length ?? 0)
  check(writes >= 1, `${scheme}: Escape saved the note (${String(writes)} writes)`)
  await c.close()

  // A short window: the controls and the heading both fit by scrolling the column.
  const d = await open(scheme, "", { width: 900, height: 560 })
  await d.screenshot({ path: join(OUT, `${scheme}-d-short-window.png`) })
  await d.close()
}

await browser.close()
server.close()
console.log(`screenshots in ${OUT}`)
process.exit(failed ? 1 : 0)
