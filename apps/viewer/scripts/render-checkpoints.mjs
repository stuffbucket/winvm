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
  console.error(
    "set PLAYWRIGHT_DIR to a folder with playwright installed (see the comment at the top)",
  )
  process.exit(2)
}
const { webkit } = createRequire(join(resolve(dir), "package.json"))(
  "playwright",
)
if (!existsSync(join(DIST, "index.html"))) {
  console.error("no dist/index.html: run `bun scripts/build-ui.ts` first")
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}
const PICTURES = process.env.CHECKPOINT_PICTURES
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
  const root =
    url.startsWith("/pictures/") && PICTURES !== undefined
      ? resolve(PICTURES)
      : DIST
  const path = join(root, url.replace(/^\/pictures/, ""))
  if (!path.startsWith(root) || !existsSync(path)) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(path)] ?? "application/octet-stream",
  })
  createReadStream(path).pipe(res)
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

const browser = await webkit.launch()
const shots = []
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function open(scheme, query = "") {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  })
  page.on("pageerror", (e) =>
    console.error(`[${scheme}] page error: ${e.message}`),
  )
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

for (const scheme of ["dark", "light"]) {
  const page = await open(scheme)
  await shot(page, `${scheme}-00-window`)
  await enter(page)
  await wait(180)
  await shot(page, `${scheme}-01-entering`)
  await wait(1300)
  await shot(page, `${scheme}-02-overview`)

  await page.keyboard.press("Meta+0")
  await wait(1100)
  await shot(page, `${scheme}-03-all`)

  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Meta+=")
  await wait(700)
  await shot(page, `${scheme}-04-zoomed-in`)

  const track = await page.locator(".timeline__track").boundingBox()
  if (track !== null) {
    await page.mouse.move(
      track.x + track.width / 2,
      track.y + track.height * 0.22,
    )
    await page.mouse.down()
    await page.mouse.up()
    await page.mouse.move(
      track.x + track.width / 2,
      track.y + track.height * 0.25,
    )
  }
  await wait(1100)
  await shot(page, `${scheme}-05-timeline`)

  await page.keyboard.press("Meta+0")
  await wait(1000)
  await page
    .locator('.checkpoint[data-name="office-installed"] .checkpoint__hit')
    .click()
  await wait(1200)
  await shot(page, `${scheme}-06-selected`)

  await page.keyboard.press(" ")
  await wait(400)
  await shot(page, `${scheme}-06b-quick-look`)
  await page.keyboard.press(" ")
  await wait(200)

  await page.getByRole("button", { name: "Go Back to This" }).click()
  await wait(300)
  await shot(page, `${scheme}-07-go-back`)
  await page.getByRole("button", { name: "Cancel" }).click()

  await page.keyboard.press("Escape")
  await page.keyboard.press("Meta+0")
  await wait(1000)
  await page
    .locator('.checkpoint[data-name="old-display"] .checkpoint__hit')
    .click()
  await wait(1100)
  await shot(page, `${scheme}-08-incompatible`)
  await page.getByRole("button", { name: "Delete…" }).click()
  await wait(300)
  await shot(page, `${scheme}-09-delete`)
  await page.getByRole("button", { name: "Cancel" }).click()

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

  await page.getByRole("button", { name: "New Checkpoint" }).click()
  await page.keyboard.type("Before the new installer")
  await shot(page, `${scheme}-12-new`)
  await page.keyboard.press("Enter")
  await wait(500)
  await shot(page, `${scheme}-13-taking`)
  await page.waitForSelector('.checkpoint[data-arriving="true"]', {
    timeout: 5000,
  })
  await wait(120)
  await shot(page, `${scheme}-14-arriving`)
  await wait(330)
  await shot(page, `${scheme}-14b-arriving`)
  await wait(1400)
  await shot(page, `${scheme}-15-arrived`)

  await page.keyboard.press("Escape")
  await wait(100)
  await page.keyboard.press("Escape")
  await wait(260)
  await shot(page, `${scheme}-16-leaving`)
  await wait(900)
  await shot(page, `${scheme}-17-left`)
  await page.close()
}

{
  const page = await open("dark", "?many=400")
  await enter(page)
  await wait(1400)
  const started = Date.now()
  await page.keyboard.press("Meta+0")
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
          el?.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: -40,
              bubbles: true,
              cancelable: true,
            }),
          )
          if ((i += 1) > 50) clearInterval(pan)
        }, 16)
      }),
  )
  await shot(page, "dark-21-many-panned")
  console.log(
    `many: ${String(cards)} cards drawn of 413; ${String(frames)} frames in a second of panning; fit took ${String(Date.now() - started)} ms`,
  )
  await page.close()
}

if (PICTURES !== undefined) {
  const files = readdirSync(PICTURES).filter((f) => f.endsWith(".png"))
  for (const scheme of ["dark", "light"]) {
    const page = await open(
      scheme,
      `?real=${files.map(encodeURIComponent).join(",")}`,
    )
    await enter(page)
    await wait(1600)
    await shot(page, `${scheme}-30-real`)
    await page
      .locator('.checkpoint[data-name="clean-desktop"] .checkpoint__hit')
      .click()
    await wait(1300)
    await shot(page, `${scheme}-31-real-selected`)
    await page.close()
  }
}

await browser.close()
server.close()
for (const s of shots) console.log(s)
