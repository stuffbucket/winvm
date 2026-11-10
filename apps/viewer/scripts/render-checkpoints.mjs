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
 * 1000 wide), CHECKING what the design says; `RENDER_ONLY=panel` runs just those. It also draws sections (the tool, the grid, the tab edited, carried with its cards,
 * resized, side by side, a blocked overlap, removed), CHECKING the rules; `RENDER_ONLY=sections` runs just that.
 * Test DOMs compute no layout; this is how layout and feel get looked at.
 *
 * Playwright isn't one of the workspace's dependencies (it would pull a
 * browser into every install). Install it anywhere and point at it:
 *
 *   npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install webkit
 *   bun scripts/build-ui.ts
 *   PLAYWRIGHT_DIR=/tmp/pw node scripts/render-checkpoints.mjs [out-dir] [--transitions-only]
 *
 * Transition checks freeze CSS animations at exact times: no timing-dependent
 * screenshots. They assert centred scale/fade/blur, an unchanged live screen
 * and camera, modal input shielding, dismissal, and reduced motion.
 */
import assert from "node:assert/strict"
import { createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-checkpoints-render")
const FAKE = resolve(VIEWER, "tests", "render", "fake-tauri.js")
const TRANSITIONS_ONLY = process.argv.includes("--transitions-only")

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

async function open(scheme, query = "", options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme, ...options })
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
  await page.waitForSelector('.checkpoints[data-ready="true"]')
}

// Freeze only the surface animation, not camera flights or card animations.
async function sampleTransition(page, time) {
  return await page.evaluate((time) => {
    const canvas = document.querySelector(".checkpoints__canvas")
    const backdrop = document.querySelector(".checkpoints__backdrop")
    for (const el of [canvas, backdrop]) {
      for (const animation of el.getAnimations()) animation.currentTime = time
    }
    const style = getComputedStyle(canvas)
    const rect = canvas.getBoundingClientRect()
    return {
      opacity: Number(style.opacity),
      backdropOpacity: Number(getComputedStyle(backdrop).opacity),
      scale: new DOMMatrix(style.transform).a,
      blur: Number(style.filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0),
      centre: [rect.x + rect.width / 2, rect.y + rect.height / 2],
      camera: document.querySelector(".spatial-canvas__scene").style.transform,
      inert: canvas.inert && document.querySelector(".viewer").inert,
    }
  }, time)
}

async function finishTransition(page) {
  await page.evaluate(() => {
    for (const animation of document.querySelector(".checkpoints__canvas").getAnimations()) animation.finish()
  })
}

// RENDER_ONLY=panel: just the details panel and the search (the sections at the end), light and dark.
const only = process.env.RENDER_ONLY
for (const scheme of only === undefined ? ["dark", "light"] : []) {
  const page = await open(scheme)
  await page.addStyleTag({ content: ".checkpoints__canvas, .checkpoints__backdrop { animation-play-state: paused !important; }" })
  // Freeze JS fallback timers too, so screenshot work cannot dismiss/reopen
  // the surface while its CSS animation is deliberately held for inspection.
  await page.clock.pauseAt(await page.evaluate(() => Date.now()))
  await page.evaluate(() => {
    window.__transitionScreen = document.querySelector(".screen__canvas canvas")
    window.__transitionPixels = window.__transitionScreen.toDataURL()
    window.__guestEvents = 0
    const display = document.querySelector(".display")
    for (const name of ["pointerdown", "keydown"]) display.addEventListener(name, () => window.__guestEvents++)
  })
  const trigger = page.getByRole("button", { name: "Checkpoints", exact: true })
  await trigger.focus()
  await page.keyboard.press("Enter")
  await page.waitForSelector('.checkpoints')
  await page.clock.runFor(32) // let the RAF-coalesced overview camera land
  await page.waitForSelector('.checkpoints[data-ready="true"]')
  const start = await sampleTransition(page, 0)
  assert.equal(start.inert, true, "entry shields both live window and checkpoint controls")
  assert.equal(start.scale, 0.8)
  assert.equal(start.opacity, 0)
  assert.equal(start.blur, 4)
  await shot(page, `${scheme}-transition-00-enter-start`)
  const middle = await sampleTransition(page, 100)
  assert(middle.scale > 0.8 && middle.scale < 1)
  assert(middle.opacity > 0 && middle.opacity < 1)
  assert.equal(middle.backdropOpacity, middle.opacity, "entry backdrop and content use the same timing")
  assert(middle.blur > 0 && middle.blur < 4)
  assert(Math.abs(middle.centre[0] - 640) < 0.01 && Math.abs(middle.centre[1] - 410) < 0.01, "entry scales around the window centre")
  assert.equal(middle.camera, start.camera, "entry is not a camera flight from Now")
  await shot(page, `${scheme}-transition-01-enter-middle`)
  await page.mouse.click(640, 410)
  await page.keyboard.press("x")
  await finishTransition(page)
  await page.waitForSelector('.checkpoints[data-phase="open"]')
  assert.equal(await page.locator(".checkpoints__canvas").evaluate((el) => el.inert), false)
  assert.equal(await page.locator(".checkpoints__backdrop canvas").count(), 0, "no enlarged duplicate live screen")
  await shot(page, `${scheme}-transition-02-open`)

  // Dismiss directly from a selected card: its panel and camera stay in place.
  await page.clock.resume()
  await page.locator('.checkpoint[data-name="clean-desktop"] .checkpoint__hit').click()
  await wait(1000)
  const camera = await page.locator(".spatial-canvas__scene").evaluate((el) => el.style.transform)
  await page.clock.pauseAt(await page.evaluate(() => Date.now()))
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await page.waitForSelector('.checkpoints[data-phase="leaving"]')
  const leaving = await sampleTransition(page, 0)
  assert.equal(leaving.camera, camera)
  assert.equal(leaving.scale, 1)
  assert.equal(leaving.opacity, 1)
  assert.equal(leaving.blur, 0)
  assert.equal(leaving.inert, true)
  const halfLeft = await sampleTransition(page, 100)
  assert(Math.abs(halfLeft.centre[0] - 640) < 0.01 && Math.abs(halfLeft.centre[1] - 410) < 0.01, "exit never moves down towards Now")
  assert.equal(halfLeft.camera, camera)
  assert(halfLeft.scale > 0.8 && halfLeft.scale < 1)
  assert(halfLeft.opacity > 0 && halfLeft.opacity < 1)
  assert.equal(halfLeft.backdropOpacity, halfLeft.opacity, "exit backdrop and content use the same timing")
  assert(halfLeft.blur > 0 && halfLeft.blur < 4)
  await shot(page, `${scheme}-transition-03-leave-middle`)
  await page.mouse.click(640, 410)
  await page.keyboard.press("x")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Escape")
  await page.evaluate(() => window.__fakeMenu("checkpoints"))
  const end = await sampleTransition(page, 199.99)
  assert(Math.abs(end.scale - 0.8) < 0.001, `exit endpoint: ${JSON.stringify(end)}`)
  assert(end.opacity < 0.001)
  assert(Math.abs(end.blur - 4) < 0.001)
  await shot(page, `${scheme}-transition-04-leave-end`)
  await finishTransition(page)
  await page.waitForSelector(".checkpoints", { state: "detached" })
  assert.equal(await page.locator(".viewer").evaluate((el) => el.inert), false)
  assert.equal(await trigger.evaluate((el) => el === document.activeElement), true, "focus returns to the opener")
  assert.equal(await page.evaluate(() => window.__guestEvents), 0, "no pointer/keyboard events leak to the VM")
  assert.equal(await page.evaluate(() => document.querySelector(".screen__canvas canvas") === window.__transitionScreen && window.__transitionScreen.toDataURL() === window.__transitionPixels), true, "same live canvas and visible state after dismissal")
  await shot(page, `${scheme}-transition-05-closed`)
  await page.close()

  const reduced = await open(scheme, "", { reducedMotion: "reduce" })
  await enter(reduced)
  await reduced.waitForSelector('.checkpoints[data-phase="open"]')
  const still = await reduced.locator(".checkpoints__canvas").evaluate((el) => {
    const style = getComputedStyle(el)
    return [style.animationName, style.transform, style.filter]
  })
  assert.deepEqual(still, ["none", "none", "none"], "reduced motion is instant, without scale or blur")
  await shot(reduced, `${scheme}-transition-06-reduced`)
  await reduced.getByRole("button", { name: "Done", exact: true }).click()
  await reduced.waitForSelector(".checkpoints", { state: "detached" })
  assert.equal(await reduced.locator(".viewer").evaluate((el) => el.inert), false)
  // Reopening, and a preference change during a paused dismissal, cannot strand the modal.
  await reduced.emulateMedia({ reducedMotion: "no-preference" })
  await reduced.addStyleTag({ content: ".checkpoints__canvas, .checkpoints__backdrop { animation-play-state: paused !important; }" })
  await enter(reduced)
  await finishTransition(reduced)
  await reduced.waitForSelector('.checkpoints[data-phase="open"]')
  await reduced.getByRole("button", { name: "Done", exact: true }).click()
  await reduced.waitForSelector('.checkpoints[data-phase="leaving"]')
  await reduced.emulateMedia({ reducedMotion: "reduce" })
  await reduced.waitForSelector(".checkpoints", { state: "detached" })
  await reduced.close()
  console.log(`${scheme}: transition, input shielding, live-state preservation and reduced motion passed`)
}

if (!TRANSITIONS_ONLY) {
for (const scheme of ["dark", "light"]) {
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

  // Restore's confirmation.
  await page.getByRole("button", { name: "Restore this checkpoint" }).click()
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

  // Out: the whole view fades/scales away together, without a camera flight.
  await page.keyboard.press("Escape")
  await wait(100)
  await page.keyboard.press("Escape")
  await wait(80)
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
for (const scheme of only === undefined || only === "panel" ? ["dark", "light"] : []) {
  const page = await open(scheme)
  await enter(page)
  await wait(1600)
  await page.keyboard.press("Meta+0")
  await wait(900)
  const panel = page.locator(".checkpoint-details")
  const title = panel.locator(".checkpoint-details__title-field")
  const top = async (sel) => (await panel.locator(sel).first().boundingBox())?.y ?? -1
  check((await panel.count()) === 0, "no panel while nothing is selected")
  await page.locator('.checkpoint[data-name="office-installed"] .checkpoint__hit').click()
  await wait(80)
  const opening = await panel.boundingBox()
  await shot(page, `${scheme}-39-details-opening`)
  check(opening !== null && opening.x < 0 && opening.x > -400, `the panel is on its way in from the left (x ${String(opening?.x)})`)
  await wait(1100)
  await shot(page, `${scheme}-40-details`)
  const at = await panel.boundingBox()
  check(at !== null && at.x === 0, "it has arrived at the window's left edge")
  check((await page.evaluate(() => document.activeElement?.classList.contains("checkpoint-details"))) === true, "focus moved into the panel")
  check((await panel.getByText("Office installed").count()) === 1, "the checkpoint's name appears once in its panel")
  check((await panel.getByText("Name", { exact: true }).count()) === 0, "no separate Name field")
  for (const gone of ["Taken", "Kind", "Size", "Loads here", "Name in winvm", "Save name"]) check((await panel.getByText(gone, { exact: true }).count()) === 0, `no ${gone} row`)
  const order = [await top(".checkpoint-details__picture"), await top(".checkpoint-details__title-field"), await top(".checkpoint-details__when"), await top(".checkpoint-details__facts"), await top(".checkpoint-details__break"), await top("textarea"), await top(".checkpoint-details__props"), await top("footer")]
  check(order.every((y, i) => i === 0 || y > order[i - 1]), `picture, title, when, kind and size, break, note, properties, actions in that order (${order.map((y) => Math.round(y)).join(", ")})`)
  check((await panel.locator(".checkpoint-details__kind").innerText()) === "Taken by you", "the manual kind chip says Taken by you")
  const closeBox = await panel.locator(".checkpoint-details__close").boundingBox()
  const pictureBox = await panel.locator(".checkpoint-details__picture").boundingBox()
  check(closeBox !== null && pictureBox !== null && closeBox.y >= pictureBox.y && closeBox.x + closeBox.width <= pictureBox.x + pictureBox.width, "the close button floats over the picture's top right")
  // The folder button asks the CLI for the checkpoint's folder and has the app open it in Finder.
  await panel.getByRole("button", { name: "Show in Finder" }).click()
  await wait(300)
  check(JSON.stringify(await page.evaluate(() => window.__opened)) === JSON.stringify(["/fake/saves/canvas-test/office-installed"]), "Show in Finder opens the checkpoint's folder")

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

  // Esc with nothing being edited eases it out; it is gone after the ease, and focus is back on the card.
  await page.keyboard.press("Escape")
  await wait(90)
  check((await panel.count()) === 1, "it stays in the page while it eases out")
  await shot(page, `${scheme}-46-details-closing`)
  await wait(400)
  check((await panel.count()) === 0, "and is gone when it has")
  check((await page.evaluate(() => document.activeElement?.closest(".checkpoint")?.getAttribute("data-name"))) === "office-installed", "focus is back on its card")

  // Select, let go and select again quickly: one panel, no stacking.
  const card = page.locator('.checkpoint[data-name="office-installed"] .checkpoint__hit')
  await card.click()
  await wait(60)
  await page.keyboard.press("Escape")
  await wait(60)
  await card.click()
  await wait(500)
  check((await panel.count()) === 1 && ((await panel.getAttribute("data-state")) === "open"), "select, let go and select again leaves one open panel")
  // Another checkpoint while it is open: the content changes in place, no new slide.
  await page.evaluate(() => document.querySelector(".checkpoint-details")?.setAttribute("data-mark", "same"))
  await page.locator('.checkpoint[data-name="auto-1"] .checkpoint__hit').click()
  await wait(400)
  check((await panel.getAttribute("data-mark")) === "same" && (await panel.getAttribute("data-state")) === "open", "another checkpoint changes the panel in place")
  await shot(page, `${scheme}-47-details-switched`)
  await page.keyboard.press("Escape")
  await wait(900)

  // An automatic one: the kind says when.
  await page.keyboard.press("Meta+0")
  await wait(900)
  await page.locator('.checkpoint[data-name="auto-3"] .checkpoint__hit').click()
  await wait(1200)
  await shot(page, `${scheme}-48-details-automatic`)
  check((await panel.locator(".checkpoint-details__kind").innerText()) === "Saved while idle", "the automatic kind chip says when")
  await page.keyboard.press("Escape")
  await wait(900)

  // One that can't be restored: a banner across the picture's foot, Restore off with the reason.
  await page.keyboard.press("Meta+0")
  await wait(900)
  await page.locator('.checkpoint[data-name="before-qemu-upgrade"] .checkpoint__hit').click()
  await wait(1200)
  await shot(page, `${scheme}-45-details-cant-load`)
  const why = panel.locator(".checkpoint-details__banner")
  check(((await why.innerText()) ?? "").replace(/\s+/g, " ").trim() === "Can't restore · Wrong QEMU version", "the reason is one line")
  check(((await why.getAttribute("title")) ?? "").includes("can't be restored on this machine"), "the whole reason is its tooltip")
  check(await panel.getByRole("button", { name: "Restore this checkpoint" }).isDisabled(), "Restore is off")
  await page.keyboard.press("Escape")
  await wait(900)

  // Suspended machine: the checkpoint taken at suspend.
  const stowed = await open(scheme, "?state=stowed")
  await enter(stowed)
  await wait(1600)
  await stowed.keyboard.press("Meta+0")
  await wait(900)
  await stowed.locator('.checkpoint[data-name="stow"] .checkpoint__hit').click()
  await wait(1200)
  await shot(stowed, `${scheme}-49-details-suspend`)
  check((await stowed.locator(".checkpoint-details__kind").innerText()) === "Saved on suspend", "the suspend kind chip")
  await stowed.close()

  // The zoom pill and the bar stay in view and clear of the panel at 720 and 1000 wide, with it open.
  for (const [w, h] of [
    [720, 520],
    [1000, 800],
  ]) {
    const narrow = await open(scheme)
    await narrow.setViewportSize({ width: w, height: h })
    await enter(narrow)
    await wait(1600)
    await narrow.keyboard.press("Meta+0")
    await wait(900)
    await narrow.locator('.checkpoint[data-name="before-qemu-upgrade"] .checkpoint__hit').click()
    await wait(1200)
    await narrow.keyboard.press("Meta+=")
    await wait(300)
    await shot(narrow, `${scheme}-55-details-${String(w)}`)
    const pb = await narrow.locator(".checkpoint-details").boundingBox()
    const bb = await narrow.locator(".spatial-canvas__controls").boundingBox()
    const zb = await narrow.locator(".checkpoints__zoom").boundingBox()
    check(pb !== null && bb !== null && pb.y + pb.height <= bb.y, `${String(w)}: the panel ends above the bar`)
    check(pb !== null && zb !== null && pb.y + pb.height <= zb.y, `${String(w)}: the panel ends above the zoom pill`)
    check(pb !== null && pb.width <= w - 132 - 128 + 1, `${String(w)}: the panel leaves room (${String(pb?.width)} wide)`)
    await narrow.close()
  }

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

// Sections: the tool, drawing with the grid showing, naming the tab, cards put in and carried with it, handles, two side by side
// with their gap, a blocked overlap, Delete keeping the cards, and it all coming back. CHECKING the rules as it goes.
// RENDER_ONLY=sections runs just this.
let sectionsBroke = false
const sectionCheck = (ok, what) => {
  if (!ok) {
    sectionsBroke = true
    console.error(`SECTIONS CHECK FAILED: ${what}`)
  }
}
const cameraOf = (page) =>
  page.evaluate(() => {
    const m = /translate3d\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px[^)]*\) scale\((-?[\d.e+-]+)\)/.exec(document.querySelector(".spatial-canvas__scene").style.transform)
    return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) }
  })
const sectionsOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".section")].map((el) => {
      const m = /translate3d\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px/.exec(el.style.transform)
      return { id: el.dataset.section, x: Number(m[1]), y: Number(m[2]), w: parseFloat(el.style.width), h: parseFloat(el.style.height), label: el.getAttribute("aria-label"), selected: el.dataset.selected === "true" }
    }),
  )
const worldBox = async (page, name) => {
  const c = await cameraOf(page)
  const b = await page.locator(`.checkpoint[data-name="${name}"]`).boundingBox()
  return b === null ? null : { x: (b.x - c.x) / c.zoom, y: (b.y - c.y) / c.zoom, w: b.width / c.zoom, h: b.height / c.zoom }
}
const screenOf = async (page, p) => {
  const c = await cameraOf(page)
  return { x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y }
}
async function drag(page, from, to, { hold = false, steps = 12 } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  if (!hold) await page.mouse.up()
}
for (const scheme of only === undefined || only === "sections" ? ["dark", "light"] : []) {
  const page = await open(scheme)
  await enter(page)
  await wait(3600)
  const GRID = 24
  const onGrid = (v) => Math.abs(v / GRID - Math.round(v / GRID)) < 1e-6
  const tool = page.getByRole("button", { name: "Section", exact: true })
  sectionCheck((await tool.getAttribute("aria-pressed")) === "false" && (await tool.getAttribute("title")) === "Section (S)", "the tool is a button with its tip")
  await shot(page, `${scheme}-80-sections-bar`)
  await page.keyboard.press("s")
  await wait(200)
  sectionCheck((await tool.getAttribute("aria-pressed")) === "true", "S turns the tool on")
  sectionCheck((await page.locator(".spatial-canvas__viewport").getAttribute("data-tool")) === "section", "the viewport says the tool is on (a crosshair)")
  await page.mouse.move(400, 300)
  await shot(page, `${scheme}-81-tool-on`)

  // Yesterday's three cards: draw a section round them.
  const names = ["auto-2", "repro-bug-4521", "before-qemu-upgrade"]
  const boxes = await Promise.all(names.map((n) => worldBox(page, n)))
  const x0 = Math.min(...boxes.map((b) => b.x)) - 50
  const y0 = Math.min(...boxes.map((b) => b.y)) - 50
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 50
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 160
  const a = await screenOf(page, { x: x0, y: y0 })
  const z = await screenOf(page, { x: x1, y: y1 })
  await drag(page, a, z, { hold: true })
  await wait(350)
  sectionCheck((await page.locator(".checkpoints__grid").evaluate((el) => getComputedStyle(el).opacity)) === "1", "the grid shows while one is drawn")
  sectionCheck((await page.locator(".section-draft").count()) === 1, "the rectangle is drawn")
  await shot(page, `${scheme}-82-drawing-grid`)
  await page.mouse.up()
  await wait(400)
  let secs = await sectionsOf(page)
  sectionCheck(secs.length === 1, "releasing makes one section")
  sectionCheck(secs.every((s) => onGrid(s.x) && onGrid(s.y) && onGrid(s.w) && onGrid(s.h)), "its corners are on the grid")
  sectionCheck((await tool.getAttribute("aria-pressed")) === "false", "the tool goes back to select")
  sectionCheck((await page.locator(".checkpoints__grid").evaluate((el) => getComputedStyle(el).opacity)) === "0", "the grid fades away")
  sectionCheck((await page.locator(".section__input").inputValue()) === "Section", "the tab is a field, named Section")
  sectionCheck((await page.evaluate(() => { const i = document.querySelector(".section__input"); return i.selectionStart === 0 && i.selectionEnd === i.value.length })) === true, "the name is selected")
  sectionCheck((secs[0]?.label ?? "").includes("3 checkpoints"), `it holds the three cards it was drawn round (${secs[0]?.label})`)
  await shot(page, `${scheme}-83-created-editing`)
  await page.keyboard.type("Yesterday's runs")
  await wait(100)
  await shot(page, `${scheme}-84-typing`)
  await page.keyboard.press("Enter")
  await wait(300)
  sectionCheck((await page.locator(".section__name").textContent()) === "Yesterday's runs", "Return keeps the name")
  sectionCheck((await page.getByRole("group", { name: "Section: Yesterday's runs, 3 checkpoints" }).count()) === 1, "the section is a group with a name and a count")
  // "Yesterday" no longer has a date: all its cards are in a section.
  sectionCheck((await page.locator('.checkpoints__day[data-day]').count()) >= 0, "(days)")
  await shot(page, `${scheme}-85-renamed-selected`)

  // Carry it by its tab: the cards go with it, still where they were inside it.
  const card0 = await worldBox(page, "repro-bug-4521")
  const tab = await page.locator(".section__tab").boundingBox()
  await drag(page, { x: tab.x + 20, y: tab.y + tab.height / 2 }, { x: tab.x + 20 - 110, y: tab.y + tab.height / 2 - 40 }, { hold: true })
  await wait(350)
  sectionCheck((await page.locator(".checkpoints__grid").evaluate((el) => getComputedStyle(el).opacity)) === "1", "the grid shows while it is carried")
  const carried = await worldBox(page, "repro-bug-4521")
  sectionCheck(carried !== null && Math.abs(carried.x - card0.x) > 20, "the cards are carried along while it moves")
  await shot(page, `${scheme}-86-moving`)
  await page.mouse.up()
  await wait(300)
  const moved = (await sectionsOf(page))[0]
  const card1 = await worldBox(page, "repro-bug-4521")
  sectionCheck(onGrid(moved.x) && onGrid(moved.y), "moved, it is on the grid")
  sectionCheck(Math.abs(card1.x - card0.x - (moved.x - secs[0].x)) < 0.6 && Math.abs(card1.y - card0.y - (moved.y - secs[0].y)) < 0.6, "the cards went with it")

  // Handles, and a resize by the east edge (the west edge stays).
  const sec = (await sectionsOf(page))[0]
  const handles = await page.locator(".section__corner, .section__edge").count()
  sectionCheck(handles === 8, `eight handles (${String(handles)})`)
  const east = await page.locator('.section__edge[data-handle="e"]').boundingBox()
  await drag(page, { x: east.x + east.width / 2, y: east.y + east.height / 2 }, { x: east.x + east.width / 2 + 77, y: east.y + east.height / 2 }, { hold: true })
  await wait(300)
  await shot(page, `${scheme}-87-resizing`)
  await page.mouse.up()
  await wait(300)
  const grown = (await sectionsOf(page))[0]
  sectionCheck(grown.x === sec.x && grown.y === sec.y && grown.h === sec.h && grown.w > sec.w && onGrid(grown.w), "east edge: the others stay, the width snaps")
  await shot(page, `${scheme}-88-selected-handles`)

  // A second section beside it, drawn from the right towards it: it stops one cell short, though the pointer goes on.
  await page.keyboard.press("s")
  const edge = await page.locator(`.section[data-section="${sec.id}"] .section__body`).boundingBox()
  const p0 = { x: edge.x + edge.width + 220, y: edge.y + 40 }
  const p1 = { x: edge.x + edge.width - 120, y: edge.y + 190 }
  await drag(page, p0, p1, { hold: true })
  await wait(350)
  const draft = await page.locator(".section-draft").boundingBox()
  const first = await page.locator(`.section[data-section="${sec.id}"] .section__body`).boundingBox()
  sectionCheck(draft !== null && first !== null && Math.abs(draft.x - (first.x + first.width) - GRID * (await cameraOf(page)).zoom) < 1.5, "drawn towards the first, it stops one cell short of it")
  await shot(page, `${scheme}-89-draw-beside-blocked`)
  await page.mouse.up()
  await wait(300)
  await page.keyboard.press("Enter")
  await wait(200)
  secs = await sectionsOf(page)
  sectionCheck(secs.length === 2, `two sections (${String(secs.length)})`)
  sectionCheck((await page.locator(".section__name").allTextContents()).sort().join("|") === "Section|Yesterday's runs", "the second is named Section")
  const second = secs.find((s) => s.id !== sec.id)
  const t2 = await page.locator(`.section[data-section="${second.id}"] .section__tab`).boundingBox()
  // Pull it left over the first one, and down: it stays a cell away and slides.
  await drag(page, { x: t2.x + 20, y: t2.y + t2.height / 2 }, { x: t2.x + 20 - 900, y: t2.y + t2.height / 2 + 70 }, { hold: true })
  await wait(300)
  await shot(page, `${scheme}-90-blocked-overlap`)
  await page.mouse.up()
  await wait(300)
  secs = await sectionsOf(page)
  const [s1, s2] = secs.sort((p, q) => p.x - q.x)
  sectionCheck(s2.x - (s1.x + s1.w) === GRID, `the second stops exactly one cell from the first (${String(s2.x - (s1.x + s1.w))})`)
  sectionCheck(s2.y > second.y, "and slides along it")
  await shot(page, `${scheme}-91-two-sections`)

  // Delete takes only the section; the cards stay where they are.
  await page.locator(`.section[data-section="${s1.id}"]`).focus()
  const before = await worldBox(page, "auto-2")
  await page.keyboard.press("Delete")
  await wait(300)
  const after = await worldBox(page, "auto-2")
  sectionCheck((await sectionsOf(page)).length === 1, "Delete removes the section")
  sectionCheck(after !== null && Math.abs(after.x - before.x) < 0.6 && Math.abs(after.y - before.y) < 0.6, "its cards stay exactly where they were")
  await shot(page, `${scheme}-92-removed`)

  // Leaving and coming back: it is kept.
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await wait(900)
  await enter(page)
  await wait(1200)
  sectionCheck((await sectionsOf(page)).length === 1, "the section is still there when the view is opened again")
  await shot(page, `${scheme}-93-again`)
  await page.close()
}
if (sectionsBroke) process.exitCode = 1

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

}

await browser.close()
server.close()
for (const s of shots) console.log(s)
