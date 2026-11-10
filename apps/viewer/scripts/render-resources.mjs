/**
 * Renders the details panel's Resources in WebKit (the engine Tauri uses on
 * macOS) against the fake app (tests/render/fake-tauri.js), in light and dark:
 *
 *   a. CPU with Windows' line and the Mac's dashed line, and the disk bar with
 *      the changes' strip, at rest and with each meter pointed at / focused
 *   b. a very small overlay (0.05 GB of 63 GB: still a few px) and a large one
 *   c. no overlay (nothing to show on the Mac), and no agent (the Mac's CPU
 *      is the headline, said so)
 *   d. a machine that isn't running (no meters)
 *
 * and checks what a picture can't: the legend is hidden at rest and shown on
 * hover and on keyboard focus, Escape hides it, each meter has its full name,
 * a tiny overlay is at least 3 px, the legend stays inside the panel.
 *
 *   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install webkit
 *   bun scripts/build-ui.ts
 *   PLAYWRIGHT_DIR=/tmp/pw node scripts/render-resources.mjs [out-dir]
 */
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-resources-render")
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

// The meters are read every 2.5 s: read every 12 ms so 40 readings (the lines' length) are in within a second.
const FAST = () => {
  const real = window.setTimeout.bind(window)
  window.setTimeout = (fn, ms, ...rest) => real(fn, ms === 2500 ? 12 : ms, ...rest)
}

async function open(scheme, query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme })
  page.on("pageerror", (e) => console.error(`[${scheme}] page error: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[${scheme}] console: ${m.text()}`)
  })
  await page.addInitScript({ path: FAKE })
  await page.addInitScript(FAST)
  await page.goto(`http://127.0.0.1:${String(port)}/index.html?${query}`)
  await page.waitForSelector(".display, .overview__title")
  await page.getByRole("button", { name: "Details" }).first().click()
  await page.waitForSelector(".panel")
  await wait(1200)
  return page
}

const box = async (page, selector) => (await page.locator(selector).first().boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
const shot = async (page, scheme, name) => {
  const p = await box(page, ".panel")
  const r = await box(page, ".resources")
  await page.screenshot({ path: join(OUT, `${scheme}-${name}.png`), clip: { x: p.x, y: Math.max(0, r.y - 60), width: p.width, height: Math.min(r.height + 160, 820 - Math.max(0, r.y - 60)) } })
}
const visible = (page, selector) => page.locator(selector).first().isVisible()

for (const scheme of ["dark", "light"]) {
  // a. The usual: 3.2 GB of changes.
  const a = await open(scheme, "overlay=3.2")
  await shot(a, scheme, "a1-rest")
  const meters = a.locator(".resource--legend")
  check((await meters.count()) === 2, `${scheme}: CPU and Disk each have a legend`)
  check(!(await visible(a, ".resource__legend")), `${scheme}: the legend is hidden at rest`)
  const names = await meters.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))
  console.log(`    names: ${JSON.stringify(names)}`)
  check(/^CPU\. Windows: \d+%\. On this Mac: \d+%\.$/.test(names[0] ?? ""), `${scheme}: CPU's name says both values`)
  check(names[1] === "Disk. Windows: 12 GB of 63 GB. Changes on this Mac: 3.2 GB.", `${scheme}: Disk's name says both values`)
  check((await a.locator(".sparkline__line--other").count()) === 1, `${scheme}: CPU draws the Mac's second line`)
  check((await a.locator(".resource__note").count()) === 0, `${scheme}: no notes under the meters`)
  const panel = await box(a, ".panel")
  for (const [i, what] of ["cpu", "disk"].entries()) {
    await a.mouse.move(5, 5)
    await meters.nth(i).hover()
    await wait(200)
    check(await meters.nth(i).locator(".resource__legend").isVisible(), `${scheme}: pointing at ${what} shows its legend`)
    const lg = await box(a, `.resource--legend:nth-child(${i === 0 ? 1 : 3}) .resource__legend`)
    check(lg.x >= panel.x && lg.x + lg.width <= panel.x + panel.width + 0.5, `${scheme}: the ${what} legend stays inside the panel`)
    await shot(a, scheme, `a${String(i + 2)}-hover-${what}`)
    await a.keyboard.press("Escape")
    await wait(100)
    check(!(await meters.nth(i).locator(".resource__legend").isVisible()), `${scheme}: Escape hides the ${what} legend`)
  }
  await a.mouse.move(5, 5)
  await meters.nth(0).focus()
  await a.keyboard.press("Tab")
  await a.keyboard.press("Shift+Tab")
  await wait(200)
  check(await meters.nth(0).locator(".resource__legend").isVisible(), `${scheme}: keyboard focus shows the legend`)
  await shot(a, scheme, "a4-focus-cpu")
  const width = async (sel) => (await box(a, sel)).width
  check((await width(".resource__overlay")) > 0, `${scheme}: the strip shows`)
  await a.close()

  // b. A very small overlay and a large one.
  const b = await open(scheme, "overlay=0.05")
  const tiny = await width0(b)
  check(tiny >= 3, `${scheme}: 0.05 GB of 63 GB is still ${tiny.toFixed(1)} px wide`)
  await shot(b, scheme, "b1-tiny")
  await b.close()
  const big = await open(scheme, "overlay=40")
  await big.locator(".resource--legend").nth(1).hover()
  await wait(200)
  await shot(big, scheme, "b2-large")
  await big.close()

  // c. No overlay; no agent.
  const c = await open(scheme, "overlay=none")
  check((await c.locator(".resource--legend").count()) === 1, `${scheme}: without the overlay only CPU has a legend`)
  check((await c.locator(".resource__overlay").count()) === 0, `${scheme}: without the overlay there is no strip`)
  await shot(c, scheme, "c1-no-overlay")
  await c.close()
  const d = await open(scheme, "usage=mac")
  check((await d.locator(".sparkline__line--other").count()) === 0, `${scheme}: without Windows' figure there is no second line`)
  check(((await d.locator(".resource__value").first().textContent()) ?? "").endsWith("on the Mac"), `${scheme}: the Mac's CPU says so`)
  await shot(d, scheme, "c2-no-agent")
  await d.close()

  // d. Not running.
  const e = await open(scheme, "state=stowed")
  check((await e.locator(".resource, .sparkline").count()) === 0, `${scheme}: a suspended machine has no meters`)
  await e.close()
}

async function width0(page) {
  return (await box(page, ".resource__overlay")).width
}

await browser.close()
server.close()
console.log(`pictures in ${OUT}`)
process.exit(failed ? 1 : 0)
