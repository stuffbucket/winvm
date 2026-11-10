/** Snapshot card/crop/presentation review in WebKit; fake guest state only. */
import assert from "node:assert/strict"
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = join(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-snapshot-design")
if (!process.env.PLAYWRIGHT_DIR) throw new Error("set PLAYWRIGHT_DIR=/tmp/pw")
const { webkit } = createRequire(join(resolve(process.env.PLAYWRIGHT_DIR), "package.json"))("playwright")
mkdirSync(OUT, { recursive: true })
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }
const server = createServer((req, res) => {
  const path = join(DIST, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname))
  if (!path.startsWith(`${DIST}/`) || !existsSync(path)) return void res.writeHead(404).end()
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" })
  createReadStream(path).pipe(res)
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const browser = await webkit.launch()
const open = async (scheme, query = "", reducedMotion = "no-preference") => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2, reducedMotion })
  page.on("pageerror", (error) => { throw error })
  await page.addInitScript({ path: join(VIEWER, "tests/render/fake-tauri.js") })
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html${query}`)
  await page.waitForSelector(".machine-picker")
  await page.evaluate(() => window.__fakeScreen())
  await page.getByRole("button", { name: "Checkpoints", exact: true }).focus()
  await page.keyboard.press("Enter")
  await page.waitForSelector('.checkpoints[data-phase="open"]')
  assert.equal(await page.evaluate(() => window.__presentation), true)
  assert.equal(await page.locator(".viewer").evaluate((el) => el.inert), true)
  assert.deepEqual(await page.locator(".checkpoints__canvas").evaluate((el) => {
    const style = getComputedStyle(el)
    return [style.filter, style.transform, style.animationName]
  }), ["none", "none", "none"], "settled canvas must release transition compositing")
  return page
}
const selected = async (page, name) => {
  const card = page.locator(`.checkpoint[data-name="${name}"] .checkpoint__hit`)
  await card.click()
  await page.waitForTimeout(800)
  return card
}
try {
  for (const scheme of ["light", "dark"]) {
    const page = await open(scheme)
    await page.screenshot({ path: join(OUT, `${scheme}-overview.png`) })
    const card = await selected(page, "clean-desktop")
    await card.locator("img").waitFor()
    const style = await card.evaluate((el) => {
      const img = el.querySelector("img")
      const footer = el.querySelector(".checkpoint__caption").getBoundingClientRect()
      const frame = el.querySelector(".checkpoint__frame").getBoundingClientRect()
      return { fit: getComputedStyle(img).objectFit, anchor: getComputedStyle(img).objectPosition, below: footer.top >= frame.bottom - 1, radius: getComputedStyle(el).borderRadius, token: getComputedStyle(el).getPropertyValue("--radius-card").trim() }
    })
    assert.equal(style.fit, "cover")
    assert.equal(style.anchor, "50% 100%")
    assert.equal(style.below, true)
    assert.equal(style.token, "8px")
    await card.screenshot({ path: join(OUT, `${scheme}-card.png`) })

    // Deliberately mismatched portrait fixture: the distinct bottom strip must survive fill-cropping.
    await card.locator("img").evaluate((img) => {
      const canvas = document.createElement("canvas")
      canvas.width = 640; canvas.height = 800
      const ctx = canvas.getContext("2d")
      ctx.fillStyle = "#52685c"; ctx.fillRect(0, 0, 640, 800)
      ctx.fillStyle = "#c5aa82"; ctx.fillRect(0, 740, 640, 60)
      img.src = canvas.toDataURL()
    })
    await card.locator("img").evaluate(async (img) => { await img.decode() })
    await card.screenshot({ path: join(OUT, `${scheme}-bottom-crop.png`) })

    await page.getByRole("button", { name: "Done", exact: true }).click()
    await page.waitForSelector(".checkpoints", { state: "detached" })
    assert.equal(await page.evaluate(() => window.__presentation), false)
    assert.equal(await page.locator(".viewer").evaluate((el) => el.inert), false)
    assert.equal(await page.getByRole("button", { name: "Checkpoints", exact: true }).evaluate((el) => el === document.activeElement), true)
    await page.close()

    const empty = await open(scheme, "?pictures=none")
    const fallback = await selected(empty, "clean-desktop")
    assert.equal(await fallback.locator("img").count(), 0)
    assert.equal(await fallback.locator(".checkpoint__wallpaper").count(), 1)
    assert.equal(await fallback.locator(".checkpoint__frame").innerText(), "")
    await fallback.screenshot({ path: join(OUT, `${scheme}-wallpaper.png`) })
    await empty.close()

    const reduced = await open(scheme, "", "reduce")
    const motion = await reduced.locator(".checkpoints__canvas").evaluate((el) => {
      const s = getComputedStyle(el)
      return [s.animationName, s.transform, s.filter]
    })
    assert.deepEqual(motion, ["none", "none", "none"])
    await reduced.getByRole("button", { name: "Done", exact: true }).click()
    await reduced.waitForSelector(".checkpoints", { state: "detached" })
    assert.equal(await reduced.evaluate(() => window.__presentation), false)
    await reduced.close()
    console.log(`${scheme}: card/crop/wallpaper/presentation/focus/reduced-motion passed`)
  }
} finally { await browser.close(); server.close() }
console.log(`screenshots: ${OUT}`)
