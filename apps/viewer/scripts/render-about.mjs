import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

const VIEWER = resolve(import.meta.dirname, "..")
const DIST = resolve(VIEWER, "dist")
const OUT = resolve(process.argv[2] ?? "/tmp/winvm-about-render")

const dir = process.env.PLAYWRIGHT_DIR
if (dir === undefined) {
  console.error("set PLAYWRIGHT_DIR to a folder with playwright installed")
  process.exit(2)
}
const { webkit } = createRequire(join(resolve(dir), "package.json"))(
  "playwright",
)
if (!existsSync(join(DIST, "about.html"))) {
  console.error("no dist/about.html: run `bun scripts/build-ui.ts` first")
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
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)
  const path = join(DIST, url)
  if (!path.startsWith(DIST) || !existsSync(path)) {
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

function fakeTauri() {
  const out = (value) => ({
    code: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  })
  const answers = {
    version: out({
      version: "0.1.4",
      build: `sha256:${"5fef1ac11139e9a1".repeat(4)}`,
      runtime: "11.1.2-2",
    }),
    ls: out({
      images: [{ name: "win11-arm64", snapshots: true }],
      instances: [{ name: "default" }, { name: "ci" }],
    }),
  }
  const invoke = async (cmd, args) => {
    if (cmd === "winvm") return answers[args.args[0]]
    if (cmd === "installed_cli") return "~/.local/bin/winvm"
    return null
  }
  const getCurrentWindow = () => ({
    show: async () => undefined,
    close: async () => undefined,
  })
  window.__TAURI__ = { core: { invoke }, window: { getCurrentWindow } }
}

const browser = await webkit.launch()
const shots = []
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({
    viewport: { width: 680, height: 360 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  })
  page.on("pageerror", (e) =>
    console.error(`[${scheme}] page error: ${e.message}`),
  )
  await page.addInitScript(fakeTauri)
  await page.goto(`http://127.0.0.1:${String(port)}/about.html?version=0.1.4`)
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".about__detail dd")].every(
      (dd) => dd.textContent !== "—",
    ),
  )
  await page.evaluate(() => document.fonts.ready)
  const file = join(OUT, `about-${scheme}.png`)
  await page.screenshot({ path: file })
  shots.push(file)
  await page.close()
}

await browser.close()
server.close()
for (const s of shots) console.log(s)
