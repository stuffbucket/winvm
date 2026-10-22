/**
 * `winvm web` — the guest's screen and status in a browser, with buttons.
 *
 * A small HTTP server on 127.0.0.1 that serves one page: noVNC showing the
 * screen (straight from QEMU's own websocket listener, see vnc.ts) beside the
 * status report, plus buttons for the lifecycle verbs. The buttons don't call
 * into this process's copy of the code: each one RUNS THE CLI (`bun winvm.ts
 * <verb> -i <name>`), so the page does exactly what the command line does,
 * including verbs added after this file was written, and shows its output.
 *
 * ## Who can use it
 *
 * Loopback only, and that is not enough on its own: any page open in a local
 * browser can send requests to 127.0.0.1. So:
 *
 *   - Every /api request needs the server's TOKEN, random per server start, in
 *     an `X-Winvm-Token` header. A custom header can't be sent cross-origin
 *     without a CORS preflight, which this server never approves, so another
 *     page can't even attempt it. The token reaches the browser in the URL's
 *     #fragment, which browsers never send to any server or put in a Referer.
 *   - The Host header must name this server, which shuts out DNS rebinding.
 *   - The VNC password (needed by the websocket) is only handed out by the
 *     token-protected API.
 *
 * `winvm open --web` starts this in the background when it isn't running and
 * records { pid, port, token } in $WINVM_HOME/web.json (mode 0600), which is
 * how a later `open --web` finds it again.
 */
import { spawn } from "node:child_process"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, resolve, sep } from "node:path"

import type { Args } from "./args"
import * as input from "./input"
import { home, listInstances, pathsFor, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as status from "./status"
import * as timemachine from "./timemachine"
import { passwordFor, websocketPort } from "./vnc"

export const DEFAULT_PORT = 5690
export const TOKEN_HEADER = "x-winvm-token"

export interface ServerInfo {
  readonly pid: number
  readonly port: number
  readonly token: string
  readonly startedAt: string
}

export const statePath = (): string => resolve(home(), "web.json")
export const logPath = (): string => resolve(home(), "web.log")
const webRoot = resolve(import.meta.dir, "web")
const cliPath = resolve(import.meta.dir, "winvm.ts")

// ---------------------------------------------------------------------------
// Pure pieces

export const newToken = (): string => randomBytes(24).toString("base64url")

/** Constant-time, and false for anything missing or the wrong length. */
export function tokenMatches(expected: string, provided: string | null | undefined): boolean {
  if (provided === null || provided === undefined || expected === "") return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The Host header must be this server by a loopback name; anything else is a rebinding attempt. */
export function hostAllowed(host: string | null, port: number): boolean {
  if (host === null) return false
  return host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`
}

/** The page for an instance. The token rides in the #fragment, never sent over the wire. */
export function pageUrl(port: number, instance: string, token: string): string {
  return `http://127.0.0.1:${String(port)}/?i=${encodeURIComponent(instance)}#token=${encodeURIComponent(token)}`
}

/**
 * The verbs the page may run, and what argument each takes. `save` and `load`
 * name a save; `key` takes a combo like ctrl-alt-delete.
 */
export const ACTIONS: Readonly<Record<string, "none" | "optional" | "required">> = {
  start: "none",
  stop: "none",
  pause: "none",
  resume: "none",
  save: "optional",
  load: "required",
  stow: "none",
  key: "required",
}

const SAFE_ARG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
export const SAFE_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * argv for `bun winvm.ts <verb> -i <instance> [arg]`, or the reason not.
 * Nothing goes through a shell, but an argument starting with `-` would still be
 * read as a flag, so arguments are restricted to plain names.
 */
export function actionArgv(verb: string, instance: string, arg?: string): readonly string[] | string {
  const kind = ACTIONS[verb]
  if (kind === undefined) return `"${verb}" is not an action this page runs`
  if (!SAFE_INSTANCE.test(instance)) return `bad instance name "${instance}"`
  const a = arg === undefined || arg === "" ? undefined : arg
  if (kind === "required" && a === undefined) return `${verb} needs an argument`
  if (kind === "none" && a !== undefined) return `${verb} takes no argument`
  if (a !== undefined && !SAFE_ARG.test(a)) return `bad argument "${a}"`
  return [verb, "-i", instance, ...(a === undefined ? [] : [a])]
}

// ---------------------------------------------------------------------------
// The server's record

export function readState(): ServerInfo | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<ServerInfo>
    if (typeof raw.pid === "number" && typeof raw.port === "number" && typeof raw.token === "string") {
      return { pid: raw.pid, port: raw.port, token: raw.token, startedAt: raw.startedAt ?? "" }
    }
  } catch {
    // absent or unreadable
  }
  return null
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function ping(s: ServerInfo): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${String(s.port)}/api/ping`, {
      headers: { [TOKEN_HEADER]: s.token },
      signal: AbortSignal.timeout(3000),
    })
    return r.ok
  } catch {
    return false
  }
}

/** The running server, starting one in the background if needed. */
export async function ensureServer(): Promise<ServerInfo> {
  const cur = readState()
  if (cur !== null && alive(cur.pid) && (await ping(cur))) return cur

  mkdirSync(home(), { recursive: true })
  const log = openSync(logPath(), "a")
  const child = spawn(process.execPath, [cliPath, "web"], { detached: true, stdio: ["ignore", log, log], env: process.env })
  closeSync(log)
  child.unref()
  let gone = false
  child.on("exit", () => {
    gone = true
  })

  // Generous: on a heavily loaded host Bun alone can take seconds to start.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !gone) {
    const s = readState()
    if (s !== null && s.pid === child.pid && (await ping(s))) return s
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`the web server did not come up — see ${logPath()}`)
}

// ---------------------------------------------------------------------------
// Jobs: one CLI run per button press

interface Job {
  readonly id: string
  readonly instance: string
  readonly verb: string
  readonly argv: readonly string[]
  readonly startedAt: string
  finishedAt: string | null
  exitCode: number | null
  output: string
}

const jobs = new Map<string, Job>()
const MAX_OUTPUT = 64 * 1024

function startJob(instance: string, verb: string, argv: readonly string[]): Job {
  const job: Job = {
    id: randomBytes(6).toString("hex"),
    instance,
    verb,
    argv,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: "",
  }
  jobs.set(job.id, job)
  // Keep the last 50.
  for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 50))) jobs.delete(id)

  const child = spawn(process.execPath, [cliPath, ...argv], {
    cwd: import.meta.dir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const add = (chunk: Buffer): void => {
    job.output = (job.output + chunk.toString("utf8")).slice(-MAX_OUTPUT)
  }
  child.stdout.on("data", add)
  child.stderr.on("data", add)
  child.on("error", (error) => add(Buffer.from(`\n${error.message}\n`)))
  child.on("close", (code) => {
    job.exitCode = code ?? 1
    job.finishedAt = new Date().toISOString()
  })
  return job
}

const busy = (instance: string): Job | undefined =>
  [...jobs.values()].find((j) => j.instance === instance && j.exitCode === null)

// ---------------------------------------------------------------------------
// HTTP

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' blob: data:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}

const json = (body: unknown, code = 200): Response =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS },
  })

const notFound = (): Response => new Response("not found", { status: 404 })

function staticFile(rel: string): Response {
  const path = resolve(webRoot, rel)
  // No escaping the web/ directory, whatever the URL says.
  if (!path.startsWith(webRoot + sep)) return notFound()
  const type = TYPES[extname(path)]
  try {
    if (type === undefined || !statSync(path).isFile()) return notFound()
  } catch {
    return notFound()
  }
  return new Response(Bun.file(path), { headers: { "content-type": type, "cache-control": "no-cache", ...SECURITY_HEADERS } })
}

async function statusBody(name: string): Promise<unknown> {
  const s = await status.gather(name, true)
  const live = s.state === "running" || s.state === "paused"
  const meta = readMeta(name)
  return {
    status: s,
    report: status.statusReport(s, timemachine.summary(), Date.now()),
    saves: status.readSaves(name),
    vnc:
      live && meta !== null
        ? { display: meta.vnc, websocketPort: websocketPort(meta.vnc), password: passwordFor(pathsFor(name)) }
        : null,
  }
}

async function screenshotResponse(name: string): Promise<Response> {
  const p = pathsFor(name)
  if (readMeta(name) === null || !qemu.isRunning(p)) return json({ error: `instance "${name}" is not running` }, 409)
  const file = resolve(tmpdir(), `winvm-web-${String(process.pid)}-${randomBytes(4).toString("hex")}.png`)
  try {
    await input.screenshot(p, file)
    return new Response(readFileSync(file), {
      headers: { "content-type": "image/png", "cache-control": "no-store", ...SECURITY_HEADERS },
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  } finally {
    rmSync(file, { force: true })
  }
}

export function makeHandler(port: () => number, token: string): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!hostAllowed(req.headers.get("host"), port())) return new Response("forbidden", { status: 403 })
    const url = new URL(req.url)
    const path = url.pathname

    if (!path.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 })
      if (path === "/" || path === "/index.html") return staticFile("index.html")
      if (path === "/app.js" || path === "/app.css") return staticFile(path.slice(1))
      if (path.startsWith("/novnc/")) {
        let rel: string
        try {
          rel = decodeURIComponent(path.slice(1))
        } catch {
          return notFound()
        }
        return staticFile(rel)
      }
      return notFound()
    }

    if (!tokenMatches(token, req.headers.get(TOKEN_HEADER))) return json({ error: "missing or wrong token" }, 401)
    const name = url.searchParams.get("i") ?? ""

    if (req.method === "GET") {
      switch (path) {
        case "/api/ping":
          return json({ ok: true, pid: process.pid })
        case "/api/instances":
          return json({ instances: listInstances() })
        case "/api/status":
          return SAFE_INSTANCE.test(name) ? json(await statusBody(name)) : json({ error: "bad instance" }, 400)
        case "/api/screenshot":
          return SAFE_INSTANCE.test(name) ? await screenshotResponse(name) : json({ error: "bad instance" }, 400)
        case "/api/job": {
          const job = jobs.get(url.searchParams.get("id") ?? "")
          return job === undefined ? json({ error: "no such job" }, 404) : json(job)
        }
        default:
          return json({ error: "not found" }, 404)
      }
    }

    if (req.method === "POST" && path === "/api/action") {
      let body: { instance?: unknown; verb?: unknown; arg?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return json({ error: "body must be JSON" }, 400)
      }
      const instance = typeof body.instance === "string" ? body.instance : ""
      const verb = typeof body.verb === "string" ? body.verb : ""
      const arg = typeof body.arg === "string" ? body.arg : undefined
      const argv = actionArgv(verb, instance, arg)
      if (typeof argv === "string") return json({ error: argv }, 400)
      const running = busy(instance)
      if (running !== undefined) return json({ error: `"${running.verb}" is still running on "${instance}"`, job: running }, 409)
      return json(startJob(instance, verb, argv), 202)
    }

    return json({ error: "not found" }, 404)
  }
}

// ---------------------------------------------------------------------------
// The command

function listen(port: number, handler: (req: Request) => Promise<Response>): ReturnType<typeof Bun.serve> {
  // A screenshot or a status probe takes a second or two; nothing is long-lived.
  return Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 60, fetch: handler })
}

export async function run(args: Args): Promise<number> {
  const cur = readState()
  if (args.flags.has("stop")) {
    if (cur === null || !alive(cur.pid)) {
      rmSync(statePath(), { force: true })
      console.log("the web server is not running")
      return 0
    }
    process.kill(cur.pid, "SIGTERM")
    console.log(`stopped the web server (pid ${String(cur.pid)})`)
    return 0
  }
  if (cur !== null && alive(cur.pid) && (await ping(cur))) {
    console.log(`already running on http://127.0.0.1:${String(cur.port)}/ (pid ${String(cur.pid)}) — \`winvm web --stop\` stops it`)
    return 0
  }

  const token = newToken()
  let boundPort = 0
  const handler = makeHandler(() => boundPort, token)
  const wanted = Number(args.flags.get("port") ?? process.env["WINVM_WEB_PORT"] ?? DEFAULT_PORT)
  let server: ReturnType<typeof Bun.serve>
  try {
    server = listen(wanted, handler)
  } catch {
    // Taken by something else: any free port will do, and web.json says which.
    server = listen(0, handler)
  }
  boundPort = server.port ?? 0

  const info: ServerInfo = { pid: process.pid, port: boundPort, token, startedAt: new Date().toISOString() }
  mkdirSync(home(), { recursive: true })
  writeFileSync(statePath(), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
  chmodSync(statePath(), 0o600)

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      // Only remove the record if it is still ours.
      if (readState()?.pid === process.pid) rmSync(statePath(), { force: true })
      process.exit(0)
    })
  }

  const first = listInstances()[0] ?? "default"
  console.log(`winvm web: listening on http://127.0.0.1:${String(boundPort)}/ (pid ${String(process.pid)})`)
  console.log(`  ${pageUrl(boundPort, first, token)}`)
  console.log("  `winvm open --web [-i name]` opens a page; Ctrl-C or `winvm web --stop` stops the server")
  // Serve until a signal arrives.
  return await new Promise<number>(() => undefined)
}
