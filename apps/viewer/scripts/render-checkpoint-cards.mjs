/**
 * Renders the Checkpoints cards in WebKit against the fake app
 * (tests/render/fake-tauri.js): the caption plate at the opening view and
 * zoomed in (kinds, notes, "Can't load here", no picture), a day's date
 * following its cards when one is dragged away and when all are dragged
 * apart, and the New Checkpoint dialog with its live placeholder; light and
 * dark. Look at the PNGs: test DOMs compute no layout.
 *
 *   bun scripts/build-ui.ts
 *   PLAYWRIGHT_DIR=/tmp/pw node scripts/render-checkpoint-cards.mjs [out-dir]
 */
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-checkpoint-cards")
const FAKE = resolve(VIEWER, "tests", "render", "fake-tauri.js")

const dir = process.env.PLAYWRIGHT_DIR
if (dir === undefined) {
  console.error("set PLAYWRIGHT_DIR to a folder with playwright installed (see render-checkpoints.mjs)")
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
const shots = []
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (ok, what) => {
  if (!ok) failed = true
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
}

async function open(scheme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme })
  page.on("pageerror", (e) => console.error(`[${scheme}] page error: ${e.message}`))
  await page.addInitScript({ path: FAKE })
  await page.goto(`http://127.0.0.1:${String(port)}/index.html`)
  await page.waitForSelector(".display")
  await page.evaluate(() => window.__fakeScreen())
  await wait(300)
  return page
}

async function shot(page, name) {
  const file = join(OUT, `${name}.png`)
  await page.screenshot({ path: file })
  shots.push(file)
}

/** A day's date label and the bounds of its cards on screen. */
const dayLabel = (page, text) => page.locator(".checkpoints__day", { hasText: text }).first().boundingBox()
const cardBox = (page, name) => page.locator(`.checkpoint[data-name="${name}"] .checkpoint__hit`).boundingBox()

async function drag(page, name, dx, dy) {
  const b = await cardBox(page, name)
  const x = b.x + b.width / 2
  const y = b.y + b.height / 4
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 })
  await page.mouse.move(x + dx, y + dy, { steps: 5 })
  await page.mouse.up()
  await wait(300)
}

for (const scheme of ["dark", "light"]) {
  const page = await open(scheme)
  await page.evaluate(() => window.__fakeMenu("checkpoints"))
  await page.waitForSelector(".checkpoints")
  await wait(1500)
  await shot(page, `${scheme}-cards-1-default`)

  // Zoomed in: the whole caption plate.
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("Meta+=")
  await wait(900)
  await shot(page, `${scheme}-cards-2-zoomed`)
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowUp")
  await wait(500)
  await shot(page, `${scheme}-cards-3-zoomed-up`)

  // The caption is the card's: the button holds both.
  const plate = await page.locator(".checkpoint__hit .checkpoint__caption").first().boundingBox()
  const hit = await page.locator(".checkpoint__hit", { has: page.locator(".checkpoint__caption") }).first().boundingBox()
  check(plate !== null && hit !== null && plate.y + plate.height <= hit.y + hit.height + 0.5, `${scheme}: the caption is inside the card's button`)

  // A day's date follows its cards.
  await page.keyboard.press("Meta+0")
  await wait(1200)
  for (let i = 0; i < 2; i += 1) await page.keyboard.press("Meta+=")
  await wait(800)
  await shot(page, `${scheme}-cards-4-before-drag`)
  const before = await dayLabel(page, "Yesterday")
  const first = await cardBox(page, "before-qemu-upgrade")
  check(Math.abs((before?.x ?? 0) - (first?.x ?? 1e9)) < 3, `${scheme}: the date starts where its first card starts`)
  await drag(page, "before-qemu-upgrade", 200, 120)
  const after = await dayLabel(page, "Yesterday")
  const rest = await cardBox(page, "auto-2")
  check(after !== null && rest !== null && Math.abs(after.x - rest.x) < 3, `${scheme}: dragging a card out leaves the date with the rest of the day`)
  await shot(page, `${scheme}-cards-5-one-moved`)
  await drag(page, "auto-2", 0, 220)
  await drag(page, "repro-bug-4521", -260, 260)
  await shot(page, `${scheme}-cards-6-all-apart`)
  await page.getByRole("button", { name: "Reset layout" }).click()
  await wait(400)

  // New Checkpoint: the field's placeholder is the name it gets if left empty.
  await page.keyboard.press("Meta+0")
  await wait(900)
  await page.getByRole("button", { name: "New Checkpoint" }).click()
  await wait(300)
  const placeholder = await page.locator("#checkpoint-new-title").getAttribute("placeholder")
  check(/\d{4} at \d{1,2}:\d{2}/.test(placeholder ?? ""), `${scheme}: the placeholder is the date and time (${placeholder ?? ""})`)
  check((await page.locator(".checkpoints__new").innerText()).includes("Leave it empty") === false, `${scheme}: no helper line`)
  await shot(page, `${scheme}-cards-7-new`)
  await page.close()
}

await browser.close()
server.close()
for (const f of shots) console.log(f)
process.exit(failed ? 1 : 0)
