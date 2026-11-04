/**
 * Renders the Windows machines menu and the machine's name in an overview's
 * heading in WebKit (the engine Tauri uses on macOS) against the fake app
 * (tests/render/fake-tauri.js), in light and dark:
 *
 *   a. the menu open: machines with their states, the commands, Delete
 *   b. the menu with Delete highlighted (the destructive row's own colours)
 *   c. the suspended heading at rest, pointed at, focused, being edited,
 *      refused (too long), and when the rename itself fails
 *   d. the off heading
 *
 * and measures what a picture can't show: turning the name into a field moves
 * nothing (same box, same line), and the field takes its place by keyboard.
 *
 *   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install webkit
 *   bun scripts/build-ui.ts
 *   PLAYWRIGHT_DIR=/tmp/pw node scripts/render-machines.mjs [out-dir]
 */
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-machines-render")
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

async function open(scheme, query, size = { width: 1280, height: 820 }) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2, colorScheme: scheme })
  page.on("pageerror", (e) => console.error(`[${scheme}] page error: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[${scheme}] console: ${m.text()}`)
  })
  await page.addInitScript({ path: FAKE })
  await page.goto(`http://127.0.0.1:${String(port)}/index.html?${query}`)
  await page.waitForSelector(".overview__title")
  await wait(900)
  return page
}

const box = async (page, selector) => (await page.locator(selector).first().boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
const MACHINES = "machines=pi:stopped,scratch:running,old:paused,archive:missing"

for (const scheme of ["dark", "light"]) {
  // a, b. The menu.
  const m = await open(scheme, `state=stowed&${MACHINES}`)
  await m.click(".machine-picker")
  await m.waitForSelector('[role="menu"]')
  await wait(300)
  const menuBox = await box(m, ".menu")
  const clip = { x: Math.max(menuBox.x - 24, 0), y: 0, width: menuBox.width + 48, height: menuBox.y + menuBox.height + 24 }
  await m.screenshot({ path: join(OUT, `${scheme}-a-menu.png`), clip })
  const rows = await m.locator('[role="menuitemradio"]').count()
  check(rows >= 4, `${scheme}: the machines are one list of radios (${String(rows)})`)
  const states = await m.locator(".state__dot").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)))
  check(new Set(states).size === 1, `${scheme}: the state dots line up in one column`)
  const trailing = await m.locator(".menu-item__trailing").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)))
  check(new Set(trailing).size === 1, `${scheme}: the states are right-aligned together`)
  const leading = await m.locator(".menu-item__leading svg").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)))
  check(new Set(leading).size === 1, `${scheme}: checks and command icons share a column`)
  // Keyboard: End goes to the last row, Delete.
  await m.keyboard.press("ArrowUp")
  await wait(150)
  await m.screenshot({ path: join(OUT, `${scheme}-b-menu-delete.png`), clip })
  const lit = await m.locator("[data-highlighted]").first().textContent()
  check((lit ?? "").startsWith("Delete"), `${scheme}: ArrowUp from the top wraps to Delete (${lit ?? ""})`)
  await m.close()

  // c. The suspended heading.
  const c = await open(scheme, "state=stowed&pictures=none")
  const crop = async (name, extra = {}) => {
    const d = await box(c, ".overview__upper")
    const content = await box(c, ".overview__content")
    await c.screenshot({ path: join(OUT, `${scheme}-${name}.png`), clip: { x: content.x - 16, y: d.y - 8, width: Math.min(content.width + 32, 980), height: 150, ...extra } })
  }
  const title0 = await box(c, ".overview__title")
  const name0 = await box(c, ".name-field")
  await crop("c1-rest")
  await c.hover(".name-field")
  await wait(300)
  await crop("c2-hover")
  await c.mouse.move(5, 5)
  // Tab order: the name is a button among the display's controls.
  await c.locator(".name-field").focus()
  const focused = await c.evaluate(() => document.activeElement?.className ?? "")
  check(focused === "name-field name-field--button", `${scheme}: the name takes focus (${focused})`)
  await wait(300)
  await crop("c3-focus")
  await c.keyboard.press("F2")
  await wait(200)
  const field = c.locator("input.name-field")
  check((await field.count()) === 1, `${scheme}: F2 makes it a field`)
  await crop("c4-edit")
  const title1 = await box(c, ".overview__title")
  const name1 = await box(c, ".name-field")
  check(Math.abs(title1.y - title0.y) < 1 && Math.abs(title1.height - title0.height) < 1, `${scheme}: the heading did not move or grow (${title0.height} -> ${title1.height})`)
  check(Math.abs(name1.height - name0.height) < 1.5, `${scheme}: the field is as tall as the name (${name0.height} -> ${name1.height})`)
  await field.fill("x".repeat(90))
  await wait(200)
  await crop("c5-invalid", { height: 190 })
  await field.fill("Build box")
  await c.keyboard.press("Enter")
  await wait(400)
  const after = await c.locator(".name-field").first().textContent()
  check(after?.trim() === "Build box", `${scheme}: Return kept the name (${after ?? ""})`)
  if (after?.trim() !== "Build box") console.log(await c.locator(".overview__heading").innerHTML())
  const writes = await c.evaluate(() => window.__titleWrites ?? [])
  check(writes.length === 1 && writes[0] === "title=Build box", `${scheme}: one winvm config title=Build box (${JSON.stringify(writes)})`)
  const back = await c.evaluate(() => document.activeElement?.className ?? "")
  check(back.includes("name-field--button"), `${scheme}: focus came back to the name`)
  await crop("c6-renamed")
  // Escape cancels.
  await c.keyboard.press("Enter")
  await c.locator("input.name-field").fill("Nope")
  await c.keyboard.press("Escape")
  await wait(200)
  check((await c.locator(".name-field").first().textContent())?.trim() === "Build box", `${scheme}: Escape put the name back`)
  await c.close()

  // The rename fails.
  const f = await open(scheme, "state=stowed&pictures=none&renamefail=1")
  await f.click(".name-field")
  await f.locator("input.name-field").fill("Other")
  await f.keyboard.press("Enter")
  await wait(400)
  const content = await box(f, ".overview__content")
  const up = await box(f, ".overview__upper")
  await f.screenshot({ path: join(OUT, `${scheme}-c7-failed.png`), clip: { x: content.x - 16, y: up.y - 8, width: Math.min(content.width + 32, 980), height: 190 } })
  await f.close()

  // d. Off.
  const d = await open(scheme, "state=stopped")
  await d.screenshot({ path: join(OUT, `${scheme}-d-off.png`) })
  await d.close()
}

await browser.close()
server.close()
console.log(`screenshots in ${OUT}`)
process.exit(failed ? 1 : 0)
