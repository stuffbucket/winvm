/**
 * Renders the Checkpoints view in WebKit (the engine Tauri uses on macOS)
 * against a fake app (tests/render/fake-tauri.js) and writes screenshots: the
 * way in, the canvas at its opening view and several zooms, the control bar
 * (search folded and open, the zoom figure showing and away), the Automatic
 * filter's and the timeline's highlights, a card dragged and the layout reset,
 * the timeline, a selected checkpoint, search, the confirmations, New
 * Checkpoint, many checkpoints, in light and dark; and the zoom control (its
 * own pill in the lower left) at rest, eased in by the pointer and by a zoom,
 * at 720x520, 1000x800 and 1440x900, CHECKING that it never overlaps the bar. It
 * also renders the details panel (title and note edited in place, a long note, one
 * that can't load) and the search (folded, open, with words, no match, at 720 and
 * 1000 wide), CHECKING what the design says; `RENDER_ONLY=panel` runs just those.
 * Test DOMs compute no layout; this is how layout and feel get looked at.
 *
 * Playwright isn't one of the workspace's dependencies (it would pull a
 * browser into every install). Install it anywhere and point at it:
 *
 *   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install webkit
 *   bun scripts/build-ui.ts
 *   PLAYWRIGHT_DIR=/tmp/pw node scripts/render-checkpoints.mjs [out-dir]
 */
import { createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-checkpoints-render")
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
// CHECKPOINT_PICTURES=<dir of PNGs>: real screenshots for the "real" run (e.g. copied from a scratch machine's saves).
const PICTURES = process.env.CHECKPOINT_PICTURES
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
  const root = url.startsWith("/pictures/") && PICTURES !== undefined ? resolve(PICTURES) : DIST
  const path = join(root, url.replace(/^\/pictures/, ""))
  if (!path.startsWith(root) || !existsSync(path)) {
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

async function open(scheme, query = "") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme })
  page.on("pageerror", (e) => console.error(`[${scheme}] page error: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[${scheme}] console: ${m.text()}`)
  })
  await page.addInitScript({ path: FAKE })
  await page.goto(`http://127.0.0.1:${String(port)}/index.html${query}`)
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

async function enter(page) {
  await page.evaluate(() => window.__fakeMenu("checkpoints"))
  await page.waitForSelector(".checkpoints")
}

// RENDER_ONLY=panel: just the details panel and the search (the sections at the end), light and dark.
const only = process.env.RENDER_ONLY
for (const scheme of only === undefined ? ["dark", "light"] : []) {
  const page = await open(scheme)
  await shot(page, `${scheme}-00-window`)
  await enter(page)
  await wait(180)
  await shot(page, `${scheme}-01-entering`)
  await wait(1300)
  await shot(page, `${scheme}-02-overview`)

  // The bar at rest: the zoom's figure has folded away; search is a magnifier.
  await wait(2000)
  await shot(page, `${scheme}-02a-bar-at-rest`)

  // The Automatic filter, under the pointer, picks out the automatic checkpoints.
  await page.getByRole("button", { name: "Automatic checkpoints" }).hover()
  await wait(350)
  await shot(page, `${scheme}-02b-automatic-hint`)

  // A day on the timeline, under the pointer, picks out that day's.
  const rail = await page.locator(".timeline__track").boundingBox()
  if (rail !== null) {
    await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height * 0.9)
    await wait(350)
    await shot(page, `${scheme}-02c-timeline-hint`)
  }

  // Drag a card somewhere else (the layout is kept), then reset the layout.
  const card = await page.locator('.checkpoint[data-name="clean-desktop"] .checkpoint__hit').boundingBox()
  if (card !== null) {
    const x = card.x + card.width / 2
    const y = card.y + card.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 150, y - 120, { steps: 6 })
    await page.mouse.move(x + 300, y - 240, { steps: 6 })
    await shot(page, `${scheme}-02d-dragging`)
    await page.mouse.up()
    await wait(300)
    await shot(page, `${scheme}-02e-moved`)
    await page.getByRole("button", { name: "Reset layout" }).click()
    await wait(300)
  }

  // Zoomed all the way out: every checkpoint, the timeline beside them.
  await page.keyboard.press("Meta+0")
  await wait(1100)
  await shot(page, `${scheme}-03-all`)

  // Zoomed in with the keys, around the middle.
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Meta+=")
  await wait(700)
  await shot(page, `${scheme}-04-zoomed-in`)

  // The timeline: a month back.
  const track = await page.locator(".timeline__track").boundingBox()
  if (track !== null) {
    await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.22)
    await page.mouse.down()
    await page.mouse.up()
    await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.25)
  }
  await wait(1100)
  await shot(page, `${scheme}-05-timeline`)

  // A checkpoint, selected: up close, with its notes.
  await page.keyboard.press("Meta+0")
  await wait(1000)
  await page.locator('.checkpoint[data-name="office-installed"] .checkpoint__hit').click()
  await wait(1200)
  await shot(page, `${scheme}-06-selected`)

  // Quick Look (Space): the screenshot, big.
  await page.keyboard.press(" ")
  await wait(400)
  await shot(page, `${scheme}-06b-quick-look`)
  await page.keyboard.press(" ")
  await wait(200)

  // Go Back's confirmation.
  await page.getByRole("button", { name: "Go Back to This" }).click()
  await wait(300)
  await shot(page, `${scheme}-07-go-back`)
  await page.getByRole("button", { name: "Cancel" }).click()

  // An incompatible one, and Delete's confirmation: back out to see them all, then pick it.
  await page.keyboard.press("Escape")
  await page.keyboard.press("Meta+0")
  await wait(1000)
  await page.locator('.checkpoint[data-name="old-display"] .checkpoint__hit').click()
  await wait(1100)
  await shot(page, `${scheme}-08-incompatible`)
  await page.getByRole("button", { name: "Delete…" }).click()
  await wait(300)
  await shot(page, `${scheme}-09-delete`)
  await page.getByRole("button", { name: "Cancel" }).click()

  // Search.
  await page.keyboard.press("Escape")
  await wait(200)
  await page.keyboard.press("Meta+f")
  await page.keyboard.type("office")
  await wait(400)
  await shot(page, `${scheme}-10-search`)
  await page.keyboard.press("Enter")
  await wait(1200)
  await shot(page, `${scheme}-11-search-picked`)
  await page.keyboard.press("Escape")
  await wait(900)

  // New Checkpoint: named, taken, flying in from Now.
  await page.getByRole("button", { name: "New Checkpoint" }).click()
  await page.keyboard.type("Before the new installer")
  await shot(page, `${scheme}-12-new`)
  await page.keyboard.press("Enter")
  await wait(500)
  await shot(page, `${scheme}-13-taking`)
  // The fake takes 1.2 s; the card then flies out of Now for 0.9 s.
  await page.waitForSelector('.checkpoint[data-arriving="true"]', { timeout: 5000 })
  await wait(120)
  await shot(page, `${scheme}-14-arriving`)
  await wait(330)
  await shot(page, `${scheme}-14b-arriving`)
  await wait(1400)
  await shot(page, `${scheme}-15-arrived`)

  // Out: Escape flies back into the live screen.
  await page.keyboard.press("Escape")
  await wait(100)
  await page.keyboard.press("Escape")
  await wait(260)
  await shot(page, `${scheme}-16-leaving`)
  await wait(900)
  await shot(page, `${scheme}-17-left`)
  await page.close()
}

// The zoom control: its own pill in the lower left, out of sight at rest, in by the pointer or a zoom.
let collided = false
for (const scheme of only === undefined ? ["dark", "light"] : []) {
  for (const [w, h] of [
    [720, 520],
    [1000, 800],
    [1440, 900],
  ]) {
    const page = await open(scheme)
    await page.setViewportSize({ width: w, height: h })
    await enter(page)
    await wait(3600)
    const name = `${scheme}-zoom-${String(w)}x${String(h)}`
    const zoom = page.locator(".checkpoints__zoom")
    const opacity = async () => Number(await zoom.evaluate((el) => getComputedStyle(el).opacity))
    await page.mouse.move(w / 2, h / 3)
    await wait(400)
    await shot(page, `${name}-1-rest`)
    if ((await opacity()) !== 0) console.error(`${name}: the zoom control is not hidden at rest`)
    // The pointer comes near the lower left.
    await page.mouse.move(70, h - 50, { steps: 5 })
    await wait(400)
    await shot(page, `${name}-2-pointer`)
    if ((await opacity()) !== 1) console.error(`${name}: the zoom control did not ease in under the pointer`)
    const z = await zoom.boundingBox()
    const b = await page.locator(".spatial-canvas__controls").boundingBox()
    const open_ = await page.locator(".checkpoints__search").first().boundingBox()
    if (z !== null && b !== null && z.x < b.x + b.width && z.x + z.width > b.x && z.y < b.y + b.height && z.y + z.height > b.y) {
      collided = true
      console.error(`${name}: the zoom control overlaps the control bar`)
    }
    void open_
    // Away again: it eases out after a moment.
    await page.mouse.move(w / 2, h / 3, { steps: 5 })
    await wait(2300)
    if ((await opacity()) !== 0) console.error(`${name}: the zoom control did not ease out after the pointer left`)
    // A zoom (the keys) shows it with its figure; the pointer is elsewhere.
    await page.keyboard.press("Meta+=")
    await wait(450)
    await shot(page, `${name}-3-zooming`)
    await wait(2300)
    // Keyboard: Tab to it.
    await page.locator(".checkpoints__zoom button").first().focus()
    await wait(300)
    await shot(page, `${name}-4-focus`)
    await page.close()
  }
}
if (collided) process.exitCode = 1

// Many checkpoints: a year of autosaves stays smooth (only what is in view is drawn).
if (only === undefined) {
  const page = await open("dark", "?many=400")
  await enter(page)
  await wait(1400)
  const started = Date.now()
  await page.keyboard.press("Meta+0")
  // The fake draws each picture on the page's own thread: let them all arrive before timing anything.
  await wait(9000)
  await shot(page, "dark-20-many")
  const cards = await page.locator(".checkpoint").count()
  const frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0
        const t0 = performance.now()
        const tick = () => {
          n += 1
          if (performance.now() - t0 < 1000) requestAnimationFrame(tick)
          else resolve(n)
        }
        requestAnimationFrame(tick)
        const el = document.querySelector(".spatial-canvas__viewport")
        let i = 0
        const pan = setInterval(() => {
          el?.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true, cancelable: true }))
          if ((i += 1) > 50) clearInterval(pan)
        }, 16)
      }),
  )
  await shot(page, "dark-21-many-panned")
  console.log(`many: ${String(cards)} cards drawn of ${String(await page.evaluate(() => window.__fakeCount?.() ?? 414))}; ${String(frames)} frames in a second of panning; fit took ${String(Date.now() - started)} ms`)
  await page.close()
}

// The details panel (title and note edited where they stand, the reason short) and the search (one control that grows
// to the left), CHECKING what the design says, light and dark.
let broke = false
const check = (ok, what) => {
  if (!ok) {
    broke = true
    console.error(`CHECK FAILED: ${what}`)
  }
}
for (const scheme of ["dark", "light"]) {
  const page = await open(scheme)
  await enter(page)
  await wait(1600)
  await page.keyboard.press("Meta+0")
  await wait(900)
  await page.locator('.checkpoint[data-name="office-installed"] .checkpoint__hit').click()
  await wait(1200)
  const panel = page.locator(".checkpoint-details")
  const title = panel.locator("header .checkpoint-details__title-field")
  await shot(page, `${scheme}-40-details`)
  check((await panel.getByText("Office installed").count()) === 1, "the checkpoint's name appears once in its panel")
  check((await panel.getByText("Name", { exact: true }).count()) === 0, "no separate Name field")

  // The title: edited where it stands.
  await title.hover()
  await wait(250)
  await shot(page, `${scheme}-41-title-hover`)
  await title.click()
  await wait(200)
  await shot(page, `${scheme}-42-title-editing`)
  await page.keyboard.type(" with a very long ending ".repeat(6))
  await wait(150)
  await shot(page, `${scheme}-43-title-invalid`)
  check((await panel.getByRole("alert").count()) === 1, "a title that is too long says why, inline")
  await page.keyboard.press("Escape")
  await wait(200)
  check((await title.textContent()) === "Office installed", "Esc puts the title back")
  check((await page.locator(".checkpoint-details").count()) === 1, "Esc in the title does not close the panel")
  await page.keyboard.press("F2")
  await wait(150)
  await page.keyboard.type("Office and Teams")
  await page.keyboard.press("Enter")
  await wait(300)
  check((await title.textContent()) === "Office and Teams", "Return keeps the title")

  // The note: text at rest, an editing surface when focused, growing then scrolling.
  const note = panel.locator("textarea")
  await note.click()
  await note.fill(Array.from({ length: 30 }, (_, i) => `Line ${String(i + 1)} of a long note`).join("\n"))
  await wait(900)
  await shot(page, `${scheme}-44-long-note`)
  const noteBox = await note.boundingBox()
  const panelBox = await panel.boundingBox()
  check(noteBox !== null && panelBox !== null && noteBox.height < panelBox.height * 0.6, "a long note stops growing and scrolls")
  await page.keyboard.press("Escape")
  await wait(300)
  check((await note.inputValue()).startsWith("Signed in as"), "Esc puts the note back")
  await page.keyboard.press("Escape")
  await wait(900)

  // One that can't load: a few words, the whole reason on hover.
  await page.keyboard.press("Meta+0")
  await wait(900)
  await page.locator('.checkpoint[data-name="before-qemu-upgrade"] .checkpoint__hit').click()
  await wait(1200)
  await shot(page, `${scheme}-45-details-cant-load`)
  const why = panel.locator(".checkpoint-details__reason")
  check((await why.innerText()) ==="Different QEMU version", "the reason is a few words")
  check(((await why.getAttribute("title")) ?? "").includes("can't load here"), "the whole reason is its tooltip")
  await page.keyboard.press("Escape")
  await wait(900)

  // Search: the bar grows to the left, its right end stays put.
  const bar = page.locator(".spatial-canvas__controls")
  const rightEnd = async () => {
    const b = await bar.boundingBox()
    return b === null ? 0 : b.x + b.width
  }
  const before = await rightEnd()
  await shot(page, `${scheme}-50-search-closed`)
  await page.getByRole("button", { name: "Search checkpoints" }).click()
  await wait(500)
  await shot(page, `${scheme}-51-search-open`)
  check(Math.abs((await rightEnd()) - before) < 1.5, `the bar's right end stays put when search opens (${String(before)} to ${String(await rightEnd())})`)
  await page.keyboard.type("office")
  await wait(400)
  await shot(page, `${scheme}-52-search-text`)
  check((await page.locator(".checkpoints__search [role=status]").textContent()) === "2 checkpoints match", "the count is said, quietly")
  await page.keyboard.type(" zzz")
  await wait(300)
  await shot(page, `${scheme}-53-search-none`)
  check((await page.locator(".checkpoints__search [role=status]").textContent()) === "No checkpoints match", "no match is said")
  await page.getByRole("button", { name: "Clear search" }).click()
  await wait(200)
  check((await page.locator(".checkpoints__search input").inputValue()) === "", "the clear button empties the field")
  await page.keyboard.press("Escape")
  await wait(500)
  check((await rightEnd()) === before, "and folds back where it was")
  await shot(page, `${scheme}-54-search-folded`)
  await page.close()

  // The bar at 720 and 1000: folded, open, with words.
  for (const [w, h] of [
    [720, 520],
    [1000, 800],
  ]) {
    const small = await open(scheme)
    await small.setViewportSize({ width: w, height: h })
    await enter(small)
    await wait(3600)
    const name = `${scheme}-60-bar-${String(w)}`
    const b0 = await small.locator(".spatial-canvas__controls").boundingBox()
    await shot(small, `${name}-closed`)
    await small.keyboard.press("Meta+f")
    await wait(450)
    await shot(small, `${name}-open`)
    await small.keyboard.type("office")
    await wait(300)
    await shot(small, `${name}-text`)
    const b1 = await small.locator(".spatial-canvas__controls").boundingBox()
    check(b0 !== null && b1 !== null && b1.x >= 0 && b1.x + b1.width <= w, `${name}: the bar stays inside the window`)
    const field = await small.locator(".checkpoints__search-box").boundingBox()
    check(field !== null && field.x >= 0 && field.width >= 200, `${name}: the field has room (${String(field?.width)} px)`)
    await small.keyboard.press("Escape")
    await wait(500)
    const b2 = await small.locator(".spatial-canvas__controls").boundingBox()
    check(b0 !== null && b2 !== null && Math.abs(b0.x - b2.x) < 1.5 && Math.abs(b0.width - b2.width) < 1.5, `${name}: the bar is back as it was`)
    await shot(small, `${name}-folded`)
    await small.close()
  }
}
if (broke) process.exitCode = 1

// Real screenshots, when given: what the cards look like with Windows in them.
if (PICTURES !== undefined) {
  const files = readdirSync(PICTURES).filter((f) => f.endsWith(".png"))
  for (const scheme of ["dark", "light"]) {
    const page = await open(scheme, `?real=${files.map(encodeURIComponent).join(",")}`)
    await enter(page)
    await wait(1600)
    await shot(page, `${scheme}-30-real`)
    await page.locator('.checkpoint[data-name="clean-desktop"] .checkpoint__hit').click()
    await wait(1300)
    await shot(page, `${scheme}-31-real-selected`)
    await page.close()
  }
}

await browser.close()
server.close()
for (const s of shots) console.log(s)
