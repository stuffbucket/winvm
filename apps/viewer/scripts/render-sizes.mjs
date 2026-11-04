/**
 * Renders the window's main screens in WebKit (the engine Tauri uses on macOS)
 * against the fake app (tests/render/fake-tauri.js) at several window sizes AND
 * device scale factors, in light and dark, so a layout that only suits one
 * window shape, or one display, shows up:
 *
 *   overview-stowed   a suspended machine: heading, note, facts, Start, list
 *   overview-stopped  an off machine
 *   checkpoints       the Checkpoints canvas
 *   menu              the Windows machines menu
 *
 * and measures what a picture can't show: nothing scrolls sideways, the note,
 * the facts, Start and the list share one column that starts at the same left
 * edge, the heading wraps only when its words do not fit the column, and there
 * is air between the toolbar and the heading.
 *
 *   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install webkit
 *   bun scripts/build-ui.ts
 *   PLAYWRIGHT_DIR=/tmp/pw node scripts/render-sizes.mjs [out-dir] [--quick] [--sizes 820x520,1440x900] [--dsf 1,2] [--screens overview-stowed,menu]
 *
 * --quick: only 820x520, 1440x900 and 1920x1080 at 1x and 2x (what to run while editing CSS).
 * PNGs are named <scheme>-<screen>-<width>x<height>@<dsf>x.png.
 */
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const FAKE = resolve(VIEWER, "tests", "render", "fake-tauri.js")

const args = process.argv.slice(2)
const flagValue = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const quick = args.includes("--quick")
const OUT = resolve(args.find((a, i) => !a.startsWith("--") && !["--sizes", "--dsf", "--screens"].includes(args[i - 1] ?? "")) ?? "/tmp/winvm-sizes-render")

const ALL_SIZES = ["640x420", "820x520", "1000x800", "1440x900", "1920x1080"]
const QUICK_SIZES = ["820x520", "1440x900", "1920x1080"]
const sizes = (flagValue("--sizes")?.split(",") ?? (quick ? QUICK_SIZES : ALL_SIZES)).map((s) => {
  const [width, height] = s.split("x").map(Number)
  return { width, height }
})
const factors = (flagValue("--dsf")?.split(",") ?? (quick ? ["1", "2"] : ["1", "1.5", "2"])).map(Number)
const SCREENS = ["overview-stowed", "overview-stopped", "checkpoints", "menu"]
const screens = flagValue("--screens")?.split(",") ?? SCREENS

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
let failed = 0
const check = (ok, what) => {
  if (!ok) {
    console.log(`FAIL ${what}`)
    failed += 1
  }
}

async function open(scheme, size, factor, query) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: factor, colorScheme: scheme })
  page.on("pageerror", (e) => console.error(`[${scheme}] page error: ${e.message}`))
  await page.addInitScript({ path: FAKE })
  await page.goto(`http://127.0.0.1:${String(port)}/index.html?${query}`)
  return page
}

const rect = (page, selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
  }, selector)

/** What the overview must be at any size. `label` names the case in a failure. */
async function checkOverview(page, label, size, { notes }) {
  const toolbar = await rect(page, ".toolbar")
  const title = await rect(page, ".overview__title")
  const column = await rect(page, ".overview__content")
  const shown = (r) => (r !== null && r.width > 0 ? r : null)
  // The list gives way on a short window (the overview's container query), so it is checked only where it shows.
  const list = shown(await rect(page, ".abilities__list"))
  const start = await rect(page, ".overview .btn--primary")
  const note = notes ? await rect(page, ".notes") : null
  const facts = await rect(page, ".facts")
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 0.5 || document.querySelector(".overview")?.scrollWidth > document.querySelector(".overview").clientWidth + 0.5)
  check(!sideways, `${label}: the page scrolls sideways`)
  if (title === null || column === null || toolbar === null) return check(false, `${label}: no heading, column or toolbar`)
  check(title.y - toolbar.bottom >= 24, `${label}: ${String((title.y - toolbar.bottom).toFixed(1))} px between the toolbar and the heading (want 24 or more)`)
  check(title.right <= column.right + 0.5 && title.x >= column.x - 0.5, `${label}: the heading is outside the column`)
  const edges = [title.x, note?.x, facts?.x, start?.x, list?.x].filter((v) => v !== undefined && v !== null)
  check(Math.max(...edges) - Math.min(...edges) < 1.5, `${label}: the blocks do not share a left edge (${edges.map((v) => v.toFixed(1)).join(", ")})`)
  if (note !== null && list !== null) check(Math.abs(note.width - list.width) < 1.5, `${label}: the note is ${note.width.toFixed(0)} px wide and the list ${list.width.toFixed(0)}`)
  // The heading wraps only when its words, set on one line, do not fit the column.
  const oneLine = await page.evaluate(() => {
    const h = document.querySelector(".overview__title")
    const lines = Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight))
    const probe = h.cloneNode(true)
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;width:max-content"
    h.parentElement.appendChild(probe)
    const natural = probe.getBoundingClientRect().width
    probe.remove()
    return { lines, natural }
  })
  if (oneLine.lines > 1) check(oneLine.natural > title.width + 0.5, `${label}: the heading wraps (${String(oneLine.lines)} lines) though it fits on one line at ${oneLine.natural.toFixed(0)} px in a ${title.width.toFixed(0)} px column`)
  // A column that does not use the width the window has, up to a comfortable measure, leaves the right side empty.
  const content = await rect(page, ".overview")
  if (content !== null && size.width >= 820) {
    const empty = content.right - column.right
    const gutter = column.x - content.x
    check(Math.abs(empty - gutter) < 2 || column.width >= 640, `${label}: the column hugs the left (${gutter.toFixed(0)} px left, ${empty.toFixed(0)} px right, ${column.width.toFixed(0)} px wide)`)
  }
}

const shots = []
for (const scheme of ["dark", "light"]) {
  for (const factor of factors) {
    for (const size of sizes) {
      const tag = `${String(size.width)}x${String(size.height)}@${String(factor)}x`
      for (const screen of screens) {
        const label = `${scheme} ${screen} ${tag}`
        let page
        if (screen === "overview-stowed") {
          page = await open(scheme, size, factor, "state=stowed")
          await page.waitForSelector(".notes__field")
          await wait(700)
          await checkOverview(page, label, size, { notes: true })
        } else if (screen === "overview-stopped") {
          page = await open(scheme, size, factor, "state=stopped")
          await page.waitForSelector(".overview__title")
          await wait(500)
          await checkOverview(page, label, size, { notes: false })
        } else if (screen === "checkpoints") {
          page = await open(scheme, size, factor, "")
          await page.waitForSelector(".display")
          await page.evaluate(() => window.__fakeScreen())
          await wait(200)
          await page.evaluate(() => window.__fakeMenu("checkpoints"))
          await page.waitForSelector(".checkpoints")
          await wait(1500)
        } else {
          page = await open(scheme, size, factor, "state=stowed&machines=pi:stopped,scratch:running,old:paused,archive:missing")
          await page.waitForSelector(".machine-picker")
          await wait(500)
          await page.click(".machine-picker")
          await page.waitForSelector('[role="menu"]')
          await wait(300)
          const menu = await rect(page, ".menu")
          check(menu !== null && menu.right <= size.width && menu.bottom <= size.height && menu.x >= 0, `${label}: the menu leaves the window`)
        }
        const file = join(OUT, `${scheme}-${screen}-${tag}.png`)
        await page.screenshot({ path: file })
        shots.push(file)
        await page.close()
      }
    }
  }
}

await browser.close()
server.close()
console.log(`${String(shots.length)} screenshots in ${OUT}; ${failed === 0 ? "all checks pass" : `${String(failed)} checks FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
