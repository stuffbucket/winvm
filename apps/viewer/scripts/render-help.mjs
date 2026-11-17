import { spawn, spawnSync } from "node:child_process"
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const argv = process.argv.slice(2)
const option = (name) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined
const OUT = resolve(
  option("--out") ?? join(VIEWER, "ui", "src", "features", "help", "img"),
)
const PREVIEW =
  option("--preview") === undefined ? null : resolve(option("--preview"))
const FAKES = ["tests/render/fake-tauri.js", "tests/render/fake-help.js"].map(
  (f) => resolve(VIEWER, f),
)

const WIDTH = 800
const HEIGHT = 450
const SCALE = 1.5
const WIDE = { width: 960, height: 540, scale: 1.25 }
const QUALITY = 86
const PICTURE_WIDTH = 1200
const NOW = new Date(2026, 10, 3, 15, 30)

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

function build() {
  const r = spawnSync("bun", [resolve(VIEWER, "scripts", "build-ui.ts")], {
    cwd: VIEWER,
    stdio: "inherit",
  })
  if (r.status !== 0) {
    console.error("the UI did not build")
    process.exit(1)
  }
}
if (!argv.includes("--no-build")) build()
if (!existsSync(join(DIST, "index.html"))) {
  console.error("no dist/index.html: run `bun scripts/build-ui.ts` first")
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const term = spawn(
  "bun",
  [resolve(VIEWER, "tests", "render", "help-term-server.ts")],
  {
    cwd: VIEWER,
    stdio: ["ignore", "pipe", "inherit"],
  },
)
const endpoint = await new Promise((ok, fail) => {
  let text = ""
  term.stdout.on("data", (d) => {
    text += String(d)
    if (text.includes("\n")) ok(text.trim())
  })
  term.on("exit", () => fail(new Error("the fake terminal server stopped")))
})

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
}
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
  const path = join(DIST, url)
  if (!path.startsWith(DIST) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(path)] ?? "application/octet-stream",
  })
  createReadStream(path).pipe(res)
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const base = `http://127.0.0.1:${String(server.address().port)}`

const browser = await webkit.launch()
const written = []
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function open(
  scheme,
  path,
  size = { width: WIDTH, height: HEIGHT },
  scale = SCALE,
) {
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: scale,
    colorScheme: scheme,
  })
  await page.clock.setFixedTime(NOW)
  page.on("pageerror", (e) =>
    console.error(`[${scheme}] page error: ${e.message}`),
  )
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !/fake tauri|Failed to load resource/.test(m.text())
    )
      console.error(`[${scheme}] console: ${m.text()}`)
  })
  for (const f of FAKES) await page.addInitScript({ path: f })
  await page.goto(`${base}/${path}`)
  return page
}

async function chrome(page, title) {
  await page.evaluate((title) => {
    const el = document.createElement("div")
    el.setAttribute("aria-hidden", "true")
    const lights = ["#ff5f57", "#febc2e", "#28c840"]
      .map(
        (c) =>
          `<i style="width:12px;height:12px;border-radius:50%;background:${c}"></i>`,
      )
      .join("")
    const bar = title !== null
    el.style.cssText = `position:fixed;z-index:2147483647;left:0;top:0;display:flex;align-items:center;gap:8px;pointer-events:none;padding-left:13px;${bar ? "right:0;height:28px;background:var(--surface-card);border-bottom:1px solid var(--border-subtle)" : "height:44px"}`
    el.innerHTML = `${lights}${bar ? `<span style="position:absolute;inset:0;display:grid;place-items:center;font:500 13px var(--font-body);color:var(--text-muted)">${title}</span>` : ""}`
    document.body.append(el)
    if (bar) {
      const root = document.getElementById("root")
      if (root !== null) root.style.cssText = "position:fixed;inset:28px 0 0 0;"
    }
  }, title)
}

async function picture(page, name, scheme, clip) {
  const file = join(OUT, `${name}.${scheme}.jpg`)
  await page.screenshot({
    path: file,
    type: "jpeg",
    quality: QUALITY,
    ...(clip === undefined ? {} : { clip }),
  })
  written.push(file)
}

async function checkpointsView(scheme) {
  const page = await open(scheme, "index.html", WIDE, WIDE.scale)
  await page.waitForSelector(".display")
  await page.evaluate(() => window.__fakeScreen())
  await wait(300)
  await page.evaluate(() => window.__fakeMenu("checkpoints"))
  await page.waitForSelector('.checkpoints[data-phase="open"]')
  await wait(1500)
  return page
}

async function terminalPicture(scheme) {
  const page = await open(
    scheme,
    `terminal.html?term=${encodeURIComponent(endpoint)}`,
  )
  await page.waitForSelector(".xterm, canvas, [class*=terminal]")
  await wait(1800)
  await chrome(page, "Work PC — PowerShell 7")
  await wait(200)
  await picture(page, "exec-terminal", scheme)
  await page.close()
}

async function filesPicture(scheme) {
  const page = await open(
    scheme,
    "files.html?instance=canvas-test&title=Work%20PC",
  )
  await page.waitForSelector(".files__list, [class*=files__row], .fw__places")
  await wait(900)
  await chrome(page, null)
  await picture(page, "files-files", scheme)
  await page.close()
}

async function checkpointPictures(scheme) {
  const page = await checkpointsView(scheme)
  await page.getByRole("button", { name: "New Checkpoint" }).click()
  await page.keyboard.type("Before the driver update")
  await wait(500)
  await picture(page, "save-new", scheme)
  await page.close()

  const view = await checkpointsView(scheme)
  await picture(view, "restore-browse", scheme)
  await view
    .locator('.checkpoint[data-name="office-installed"] .checkpoint__hit')
    .click()
  await wait(1400)
  await picture(view, "restore-goBack", scheme)
  await view.close()
}

async function claudePanel(scheme, size, scale) {
  const page = await open(scheme, "index.html", size, scale)
  await page.waitForSelector(".display")
  await page.evaluate(() => window.__fakeScreen())
  await wait(300)
  await page.getByRole("button", { name: "Use with Claude" }).click()
  await page.waitForSelector(".popover .clients")
  await wait(400)
  await page.evaluate(() => {
    const panel = document.querySelector(".popover")
    panel.style.top = `${String(panel.getBoundingClientRect().top + 48)}px`
  })
  await wait(100)
  return page
}

async function claudePicture(scheme) {
  const size = { width: 1000, height: 680 }
  const MARGIN = 24
  const probe = await claudePanel(scheme, size, 1)
  const box = await probe.locator(".popover").boundingBox()
  await probe.close()
  const width = Math.round(box.width + 2 * MARGIN)
  const height = Math.round((width * 9) / 16)
  const clip = {
    x: Math.round(box.x - MARGIN),
    y: Math.round(box.y + box.height / 2 - height / 2),
    width,
    height,
  }
  const page = await claudePanel(scheme, size, PICTURE_WIDTH / width)
  await picture(page, "agent-claude", scheme, clip)
  await page.close()
}

const only = option("--only")
try {
  for (const scheme of option("--scheme") === undefined
    ? ["light", "dark"]
    : [option("--scheme")]) {
    if (only === undefined || only === "terminal") await terminalPicture(scheme)
    if (only === undefined || only === "files") await filesPicture(scheme)
    if (only === undefined || only === "checkpoints")
      await checkpointPictures(scheme)
    if (only === undefined || only === "claude") await claudePicture(scheme)
  }

  if (PREVIEW !== null) {
    mkdirSync(PREVIEW, { recursive: true })
    build()
    const topics = ["exec", "files", "save", "restore", "agent"]
    const shot = async (page, name) => {
      const file = join(PREVIEW, `${name}.png`)
      await page.screenshot({ path: file })
      written.push(file)
    }
    for (const scheme of ["light", "dark"]) {
      for (const [label, size, css] of [
        ["wide", { width: 1280, height: 820 }, ""],
        ["small", { width: 960, height: 720 }, ""],
        [
          "wrapped",
          { width: 1280, height: 820 },
          ".abilities__list { width: 15rem }",
        ],
      ]) {
        const page = await open(scheme, "index.html?state=stopped", size)
        await page.waitForSelector(".abilities", { state: "attached" })
        if (!(await page.locator(".abilities").isVisible())) {
          if (label !== "small")
            throw new Error(`${scheme}-${label}: help list unexpectedly hidden`)
          await shot(page, `${scheme}-${label}-list-hidden`)
          await page.close()
          continue
        }
        if (css !== "") await page.addStyleTag({ content: css })
        await wait(500)
        await shot(page, `${scheme}-${label}-list`)
        for (const id of label === "wrapped" ? ["restore"] : topics) {
          await page
            .locator(".ability")
            .nth(topics.indexOf(id))
            .click({ force: true })
          await page.waitForSelector(".help")
          await wait(400)
          await shot(page, `${scheme}-${label}-${id}`)
          await page.keyboard.press("Escape")
        }
        await page.close()
      }
      const stowed = await open(scheme, "index.html?state=stowed", {
        width: 1280,
        height: 820,
      })
      await stowed.waitForSelector(".abilities")
      await wait(500)
      await shot(stowed, `${scheme}-stowed-list`)
      await stowed
        .locator(".ability")
        .nth(topics.indexOf("agent"))
        .click({ force: true })
      await stowed.waitForSelector(".help")
      await wait(400)
      await shot(stowed, `${scheme}-stowed-agent`)
      await stowed.close()
    }
  }
} finally {
  await browser.close()
  server.close()
  term.kill()
}
for (const f of written) console.log(f)
