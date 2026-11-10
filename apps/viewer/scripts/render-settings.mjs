/** Settings and native-menu parity in WebKit, with fake state only. */
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = join(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-settings-render")
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
let failed = false
const check = (ok, message) => { console.log(`${ok ? "ok" : "FAIL"} ${message}`); if (!ok) failed = true }
try {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, colorScheme: scheme, deviceScaleFactor: 2 })
    page.on("pageerror", (e) => { console.error(e); failed = true })
    await page.addInitScript({ path: join(VIEWER, "tests/render/fake-tauri.js") })
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?state=running`)
    await page.waitForSelector(".machine-picker")
    await page.waitForFunction(() => window.__menuEnabled?.["vm-sleep"] === true)
    await page.evaluate(() => window.__fakeMenu("settings"))
    await page.waitForSelector(".settings-dialog[open]")
    await page.getByLabel("Idle minutes before a checkpoint", { exact: true }).waitFor()
    check(await page.evaluate(() => window.__menuEnabled?.["vm-stop"] === false), `${scheme}: native power is disabled while Settings is modal`)
    await page.getByLabel("Idle minutes before a checkpoint", { exact: true }).fill("15")
    await page.getByLabel("Automatic checkpoints to keep", { exact: true }).fill("5")
    await page.getByRole("button", { name: "Apply Policy" }).click()
    await page.waitForFunction(() => window.__policyWrites?.length === 1)
    const writes = await page.evaluate(() => window.__policyWrites)
    check(JSON.stringify(writes) === JSON.stringify([["autosave.idleMinutes=15", "autosave.keep=5"]]), `${scheme}: applies only two changed settings`)
    await page.screenshot({ path: join(OUT, `${scheme}-policy.png`) })
    await page.getByText("Processors, memory and disk", { exact: true }).click()
    await page.getByLabel("Processors", { exact: true }).waitFor()
    await page.screenshot({ path: join(OUT, `${scheme}-hardware.png`) })
    const bounds = await page.locator(".settings-dialog").boundingBox()
    check(bounds.x >= 0 && bounds.y >= 0 && bounds.y + bounds.height <= 801, `${scheme}: Settings fits the window`)
    await page.getByRole("button", { name: "Done", exact: true }).click()
    await page.waitForSelector(".settings-dialog", { state: "detached" })
    await page.waitForFunction(() => window.__menuEnabled?.["vm-sleep"] === true)
    await page.evaluate(() => window.__fakeMenu("view-details"))
    await page.waitForSelector(".panel")
    check(await page.locator(".panel").count() === 1, `${scheme}: native View action opens Details`)
    await page.close()
  }
} finally { await browser.close(); server.close() }
console.log(`screenshots in ${OUT}`)
process.exit(failed ? 1 : 0)
