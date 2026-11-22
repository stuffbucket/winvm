import {
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, relative, resolve } from "node:path"

import { type Browser, type Page, webkit } from "playwright"

interface Entry {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly name: string
}

interface Probe {
  finished: boolean
  status: string | null
  errors: string[]
}

interface Shot {
  readonly entry: Entry
  readonly theme: Theme
  readonly file: string | null
  readonly error: string | null
}

type Theme = "light" | "dark"

const PKG = resolve(import.meta.dir, "..")
const STATIC = join(PKG, "storybook-static")
const THEMES: readonly Theme[] = ["light", "dark"]
const VIEWPORT = { width: 1280, height: 900 }
const SCALE = 2
const WORKERS = 4
const STORY_TIMEOUT_MS = 45_000
const STEADY_FRAMES = 3
const MAX_FRAMES = 240
const PADDING = 16
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

const OUT = resolve(option("--out") ?? join(PKG, "shots"))
const MATCH = option("--match")

function installProbe(): void {
  const probe: Probe = { finished: false, status: null, errors: [] }
  const scope = window as unknown as {
    __shotProbe?: Probe
    __STORYBOOK_ADDONS_CHANNEL__?: unknown
  }
  scope.__shotProbe = probe
  interface Channel {
    on(event: string, listener: (payload: unknown) => void): void
  }
  const seen = new WeakSet()
  const attach = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return
    const channel = value as Partial<Channel>
    if (typeof channel.on !== "function") return
    seen.add(value)
    const on = channel.on.bind(value)
    on("storyFinished", (payload) => {
      probe.finished = true
      probe.status =
        (payload as { status?: string } | null)?.status ?? "success"
    })
    for (const event of [
      "playFunctionThrewException",
      "storyThrewException",
      "storyErrored",
      "storyMissing",
      "unhandledErrorsWhilePlaying",
    ])
      on(event, (payload) => {
        probe.errors.push(`${event}: ${JSON.stringify(payload)}`)
      })
  }
  let channel = scope.__STORYBOOK_ADDONS_CHANNEL__
  attach(channel)
  Object.defineProperty(window, "__STORYBOOK_ADDONS_CHANNEL__", {
    configurable: true,
    get: () => channel,
    set: (value: unknown) => {
      channel = value
      attach(value)
    },
  })
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const docs = [
      document,
      ...[...document.querySelectorAll("iframe")]
        .map((frame) => frame.contentDocument)
        .filter((doc): doc is Document => doc !== null),
    ]
    await Promise.all(
      docs.map(async (doc) => {
        await doc.fonts.ready
        await Promise.all(
          [...doc.images]
            .filter((image) => !image.complete)
            .map(
              (image) =>
                new Promise<void>((done) => {
                  image.addEventListener("load", () => {
                    done()
                  })
                  image.addEventListener("error", () => {
                    done()
                  })
                }),
            ),
        )
      }),
    )
  })
  await page.evaluate(
    async ([steadyFrames, maxFrames]) => {
      const signature = (): string => {
        const root = document.querySelector("#storybook-root")
        const frames = [...document.querySelectorAll("iframe")].map(
          (frame) => frame.contentDocument?.body.innerHTML.length ?? 0,
        )
        const boxes = [...(root?.children ?? [])].map((el) => {
          const box = el.getBoundingClientRect()
          return [box.x, box.y, box.width, box.height]
        })
        return JSON.stringify([root?.innerHTML.length ?? 0, frames, boxes])
      }
      const frame = (): Promise<void> =>
        new Promise((done) => {
          requestAnimationFrame(() => {
            done()
          })
        })
      let previous = ""
      let steady = 0
      for (let i = 0; i < maxFrames && steady < steadyFrames; i += 1) {
        await frame()
        const current = signature()
        steady = current === previous ? steady + 1 : 0
        previous = current
      }
    },
    [STEADY_FRAMES, MAX_FRAMES] as const,
  )
}

async function clip(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return await page.evaluate((padding) => {
    if (document.querySelector("dialog[open], [role='dialog']") !== null)
      return null
    const root = document.querySelector("#storybook-root")
    const boxes = [...(root?.children ?? [])]
      .map((el) => el.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
    if (boxes.length === 0) return null
    const left = Math.max(0, Math.min(...boxes.map((b) => b.left)) - padding)
    const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - padding)
    const right = Math.min(
      document.documentElement.scrollWidth,
      Math.max(...boxes.map((b) => b.right)) + padding,
    )
    const bottom = Math.min(
      document.documentElement.scrollHeight,
      Math.max(...boxes.map((b) => b.bottom)) + padding,
    )
    return {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.ceil(right - left),
      height: Math.ceil(bottom - top),
    }
  }, PADDING)
}

async function shoot(
  browser: Browser,
  base: string,
  entry: Entry,
  theme: Theme,
): Promise<Shot> {
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: theme,
  })
  page.setDefaultTimeout(STORY_TIMEOUT_MS)
  try {
    await page.addInitScript(installProbe)
    await page.goto(
      `${base}/iframe.html?id=${entry.id}&viewMode=story&globals=theme:${theme}`,
    )
    const handle = await page.waitForFunction(() => {
      const probe = (window as unknown as { __shotProbe?: Probe }).__shotProbe
      return probe !== undefined && (probe.finished || probe.errors.length > 0)
        ? JSON.stringify(probe)
        : ""
    })
    const probe = JSON.parse(await handle.jsonValue()) as Probe
    if (probe.errors.length > 0 || probe.status !== "success")
      throw new Error(
        probe.errors.join("\n") || `status ${String(probe.status)}`,
      )
    await page.addStyleTag({
      content: "*,*::before,*::after{caret-color:transparent!important}",
    })
    await settle(page)
    const dir = join(OUT, theme)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${entry.id}.png`)
    const area = await clip(page)
    await page.screenshot(
      area === null
        ? { path: file }
        : { path: file, clip: area, fullPage: true },
    )
    return { entry, theme, file, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { entry, theme, file: null, error: message }
  } finally {
    await page.close()
  }
}

function serve(): Promise<{ base: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = join(
      STATIC,
      decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname),
    )
    const file = path.endsWith("/") ? join(path, "index.html") : path
    if (!file.startsWith(STATIC) || !existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    })
    createReadStream(file).pipe(res)
  })
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      done({
        base: `http://127.0.0.1:${String(port)}`,
        close: () => server.close(),
      })
    })
  })
}

const html = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")

function index(shots: readonly Shot[], stories: readonly Entry[]): void {
  const link = (shot: Shot | undefined): string =>
    shot?.file === null || shot?.file === undefined
      ? `<p class="error">${html(shot?.error ?? "missing")}</p>`
      : `<a href="${html(relative(OUT, shot.file))}"><img loading="lazy" src="${html(relative(OUT, shot.file))}" alt=""></a>`
  const groups = [...new Set(stories.map((s) => s.title))]
  const sections = groups.map((title) => {
    const rows = stories
      .filter((s) => s.title === title)
      .map((s) => {
        const of = (theme: Theme): Shot | undefined =>
          shots.find((x) => x.entry.id === s.id && x.theme === theme)
        return `<tr><th scope="row">${html(s.name)}<br><code>${html(s.id)}</code></th><td>${link(of("light"))}</td><td>${link(of("dark"))}</td></tr>`
      })
      .join("\n")
    return `<h2>${html(title)}</h2>\n<table><thead><tr><th>Story</th><th>Light</th><th>Dark</th></tr></thead><tbody>\n${rows}\n</tbody></table>`
  })
  const failed = shots.filter((s) => s.error !== null).length
  writeFileSync(
    join(OUT, "index.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>winvm Storybook screenshots</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}
table{border-collapse:collapse;width:100%;margin-bottom:32px}
th,td{border-top:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}
th[scope=row]{width:16rem}
img{max-width:100%;max-height:420px;border:1px solid #ccc;background:#fff}
td:last-child img{background:#111}
.error{color:#b91c1c;white-space:pre-wrap}
</style></head><body>
<h1>winvm Storybook screenshots</h1>
<p>${String(stories.length)} stories, light and dark, ${String(shots.length - failed)} screenshots, ${String(failed)} failed. Taken ${new Date().toISOString()}.</p>
${sections.join("\n")}
</body></html>
`,
  )
  writeFileSync(
    join(OUT, "index.md"),
    [
      "# winvm Storybook screenshots",
      "",
      `${String(stories.length)} stories in light and dark; ${String(failed)} failed.`,
      "",
      ...groups.flatMap((title) => [
        `## ${title}`,
        "",
        "| Story | Light | Dark |",
        "|---|---|---|",
        ...stories
          .filter((s) => s.title === title)
          .map((s) => {
            const cell = (theme: Theme): string => {
              const shot = shots.find(
                (x) => x.entry.id === s.id && x.theme === theme,
              )
              return shot?.file === null || shot?.file === undefined
                ? `failed: ${shot?.error?.split("\n")[0] ?? "missing"}`
                : `[${theme}](${relative(OUT, shot.file)})`
            }
            return `| ${s.name} | ${cell("light")} | ${cell("dark")} |`
          }),
        "",
      ]),
    ].join("\n"),
  )
}

if (!existsSync(join(STATIC, "index.json"))) {
  console.error("no storybook-static: run `bun run storybook:build` first")
  process.exit(2)
}
const { entries } = (await Bun.file(join(STATIC, "index.json")).json()) as {
  entries: Record<string, Entry>
}
const stories = Object.values(entries).filter(
  (e) =>
    e.type === "story" &&
    (MATCH === undefined || new Bun.Glob(MATCH).match(e.id)),
)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const server = await serve()
const browser = await webkit.launch()
const jobs = THEMES.flatMap((theme) =>
  stories.map((entry) => ({ entry, theme })),
)
const shots: Shot[] = []
let next = 0
const worker = async (): Promise<void> => {
  for (let job = jobs[next++]; job !== undefined; job = jobs[next++]) {
    const shot = await shoot(browser, server.base, job.entry, job.theme)
    console.error(
      `${shot.error === null ? "ok  " : "FAIL"} ${job.theme} ${job.entry.id}${shot.error === null ? "" : `\n     ${shot.error.split("\n")[0] ?? ""}`}`,
    )
    shots.push(shot)
  }
}
try {
  await Promise.all(Array.from({ length: WORKERS }, worker))
} finally {
  await browser.close()
  server.close()
}
index(shots, stories)
const failed = shots.filter((s) => s.error !== null).length
console.log(
  `shots: ${String(shots.length - failed)} of ${String(shots.length)} written to ${OUT}`,
)
if (failed > 0) process.exit(1)
