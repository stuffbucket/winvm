/**
 * The in-guest agent: a small HTTP+JSON server that runs INSIDE the Windows
 * guest, in the logged-on user's session, so the host can run commands, move
 * files and start GUI programs in milliseconds rather than the 75-190 ms a
 * qemu-ga `guest-exec` costs (and qemu-ga runs in session 0, as x64 under
 * Prism, where nothing it starts can show a window).
 *
 * SELF-CONTAINED ON PURPOSE. This one file is copied into the guest as-is and
 * run by the guest's own native ARM64 `bun.exe`; it imports nothing but Node
 * and Bun built-ins. The host imports it only for its constants and types (and
 * tests run it on the host), so the server starts only under `import.meta.main`.
 *
 * Reached from the host through a QEMU user-net port forward added at runtime
 * (`hostfwd_add`, see agent.ts) — slirp delivers those connections from
 * 10.0.2.2, so the guest side binds the guest port and is told to accept only
 * that address and loopback. Every request must carry `Authorization: Bearer
 * <token>`; the token file is re-read whenever it changes, so the host can set
 * or rotate it over qemu-ga without restarting anything (a guest restored from
 * a save keeps serving with whatever token the host writes next).
 *
 *   GET  /health                      version, pid, arch, session, peer address
 *   POST /exec    {argv,cwd?,env?,stdin?,timeoutMs?,verbatim?}  -> {code,stdout,stderr,ms,timedOut}
 *   POST /pwsh    {script,timeoutMs?}  warm Windows PowerShell   -> {code,output,ms,timedOut}
 *   PUT  /file?path=…                 raw body to a guest file  -> {bytes,ms}
 *   GET  /file?path=…                 a guest file, raw
 *   POST /launch  {argv,cwd?,env?}    detached, in this session  -> {pid}
 *   GET  /procs                       [{pid,name,session}]
 *   POST /kill    {pid,tree?}
 *   POST /exit                        stop the agent (reinstall)
 */
import { spawn as nodeSpawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { timingSafeEqual } from "node:crypto"

/** Bumped whenever the protocol or behaviour changes; the host reinstalls on mismatch. */
export const AGENT_VERSION = 1
/** The port the agent listens on INSIDE the guest. The host side is per instance. */
export const GUEST_PORT = 7801
export const WINDOWS_DIR = "C:\\ProgramData\\winvm\\agent"

export interface Health {
  readonly ok: true
  readonly version: number
  readonly pid: number
  readonly arch: string
  readonly platform: string
  readonly bun: string
  readonly session: number | null
  readonly from: string | null
  readonly uptimeMs: number
}

export interface ExecRequest {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string
  readonly timeoutMs?: number
  /** Windows: pass the command line unquoted (cmd.exe needs this for `"`-heavy commands). */
  readonly verbatim?: boolean
}
export interface ExecResponse {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly ms: number
  readonly timedOut: boolean
}
export interface PwshResponse {
  readonly code: number
  readonly output: string
  readonly ms: number
  readonly timedOut: boolean
}
export interface LaunchRequest {
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}
export interface Proc {
  readonly pid: number
  readonly name: string
  readonly session: number | null
}

export interface AgentOptions {
  readonly port: number
  readonly hostname: string
  readonly tokenFile: string
  /** Peer addresses allowed to connect; null allows any (the token still applies). */
  readonly allowFrom: readonly string[] | null
  readonly log?: string
}

const isWin = process.platform === "win32"
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

/** The token, re-read only when the file changes. Missing or empty: refuse everything. */
function tokenReader(file: string): () => string | null {
  let cached: { readonly mtimeMs: number; readonly size: number; readonly token: string | null } | null = null
  return () => {
    try {
      const st = statSync(file)
      if (cached !== null && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.token
      const t = readFileSync(file, "utf8").trim()
      cached = { mtimeMs: st.mtimeMs, size: st.size, token: t === "" ? null : t }
      return cached.token
    } catch {
      cached = null
      return null
    }
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function drain(s: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const dec = new TextDecoder()
  for await (const chunk of s) sink.push(dec.decode(chunk, { stream: true }))
  sink.push(dec.decode())
}

/** Kill a process and, on Windows, everything it started — `kill()` alone orphans the tree. */
function killTree(pid: number): void {
  if (isWin) {
    Bun.spawnSync(["C:\\Windows\\System32\\taskkill.exe", "/t", "/f", "/pid", String(pid)], { stdout: "ignore", stderr: "ignore" })
    return
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // already gone
  }
}

async function runExec(r: ExecRequest): Promise<ExecResponse> {
  const t0 = performance.now()
  const p = Bun.spawn([...r.argv], {
    ...(r.cwd === undefined ? {} : { cwd: r.cwd }),
    env: r.env === undefined ? process.env : { ...process.env, ...r.env },
    stdin: r.stdin === undefined ? "ignore" : new TextEncoder().encode(r.stdin),
    stdout: "pipe",
    stderr: "pipe",
    ...(r.verbatim === true ? { windowsVerbatimArguments: true } : {}),
  })
  const out: string[] = []
  const err: string[] = []
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    killTree(p.pid)
  }, r.timeoutMs ?? 600_000)
  const drained = Promise.all([drain(p.stdout, out), drain(p.stderr, err)])
  const code = await p.exited
  clearTimeout(killer)
  // EXIT decides, not EOF: a grandchild that inherited the pipe can hold it
  // open long after the command itself is done.
  await Promise.race([drained, Bun.sleep(500)])
  return { code, stdout: out.join(""), stderr: err.join(""), ms: performance.now() - t0, timedOut }
}

/**
 * One long-lived Windows PowerShell, fed scripts on stdin. A cold
 * `powershell.exe` costs ~300 ms+ even native; a warm one answers in ~8 ms.
 * Scripts go in base64 so no quoting survives to bite; a nonce line marks the
 * end of each one's output. Strictly one at a time.
 */
class PwshHost {
  private proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | null = null
  private reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> } | null = null
  private buf = ""
  private readonly dec = new TextDecoder()
  private queue: Promise<unknown> = Promise.resolve()

  private readonly exe: string
  constructor(exe: string) {
    this.exe = exe
  }

  run(script: string, timeoutMs: number): Promise<PwshResponse> {
    const next = this.queue.then(
      async () => await this.runOne(script, timeoutMs),
      async () => await this.runOne(script, timeoutMs),
    )
    this.queue = next
    return next
  }

  private start(): void {
    const proc = Bun.spawn([this.exe, "-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    this.proc = proc
    this.reader = proc.stdout.getReader()
    this.buf = ""
  }

  private stop(): void {
    if (this.proc !== null) killTree(this.proc.pid)
    this.proc = null
    this.reader = null
  }

  private async runOne(script: string, timeoutMs: number): Promise<PwshResponse> {
    const t0 = performance.now()
    if (this.proc === null) this.start()
    const proc = this.proc
    const reader = this.reader
    if (proc === null || reader === null) throw new Error("powershell did not start")
    const nonce = `__winvm_end_${crypto.randomUUID().replaceAll("-", "")}__`
    const b64 = Buffer.from(script, "utf8").toString("base64")
    proc.stdin.write(
      `$global:LASTEXITCODE = 0; $__ok = $true; try { & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))) 2>&1 | Out-String -Width 4096 | Write-Output } catch { $__ok = $false; "ERROR: $_" }; "${nonce} $(if ($__ok) { $global:LASTEXITCODE } else { 1 })"\n`,
    )
    await proc.stdin.flush()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.stop()
    }, timeoutMs)
    try {
      for (;;) {
        const i = this.buf.indexOf(nonce)
        if (i >= 0) {
          const rest = this.buf.slice(i + nonce.length)
          const nl = rest.indexOf("\n")
          if (nl >= 0) {
            const output = this.buf.slice(0, i)
            const code = Number.parseInt(rest.slice(0, nl).trim(), 10)
            this.buf = rest.slice(nl + 1)
            return { code: Number.isNaN(code) ? 0 : code, output, ms: performance.now() - t0, timedOut: false }
          }
        }
        const { value, done } = await reader.read()
        if (done || value === undefined) {
          this.stop()
          return { code: -1, output: this.buf, ms: performance.now() - t0, timedOut }
        }
        this.buf += this.dec.decode(value, { stream: true })
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Start a program and leave it running, detached — node's `detached`, not
 * Bun.spawn: on Windows libuv puts ordinary children in a kill-on-close job
 * object, so everything the agent launched would die with it.
 */
async function launch(r: LaunchRequest): Promise<{ readonly pid: number }> {
  const [exe, ...rest] = r.argv
  if (exe === undefined) throw new Error("argv is empty")
  const child = nodeSpawn(exe, rest, {
    detached: true,
    stdio: "ignore",
    ...(r.cwd === undefined ? {} : { cwd: r.cwd }),
    env: r.env === undefined ? process.env : { ...process.env, ...r.env },
  })
  await new Promise<void>((res, rej) => {
    child.once("spawn", () => res())
    child.once("error", rej)
  })
  child.unref()
  if (child.pid === undefined) throw new Error("no pid")
  return { pid: child.pid }
}

/** Parse `tasklist /fo csv /nh`: "Image Name","PID","Session Name","Session#","Mem Usage". */
export function parseTasklist(csv: string): Proc[] {
  const procs: Proc[] = []
  for (const line of csv.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? "").replaceAll('""', '"'))
    const pid = Number.parseInt(cells[1] ?? "", 10)
    if (cells.length < 4 || Number.isNaN(pid)) continue
    const session = Number.parseInt(cells[3] ?? "", 10)
    procs.push({ pid, name: cells[0] ?? "", session: Number.isNaN(session) ? null : session })
  }
  return procs
}

function listProcs(): Proc[] {
  if (isWin) {
    const r = Bun.spawnSync(["C:\\Windows\\System32\\tasklist.exe", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "ignore" })
    return parseTasklist(r.stdout.toString())
  }
  const r = Bun.spawnSync(["ps", "-axo", "pid=,comm="], { stdout: "pipe", stderr: "ignore" })
  const procs: Proc[] = []
  for (const line of r.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m !== null) procs.push({ pid: Number(m[1]), name: (m[2] ?? "").trim(), session: null })
  }
  return procs
}

let ownSession: number | null | undefined
function sessionOfSelf(): number | null {
  if (ownSession !== undefined) return ownSession
  ownSession = isWin ? (listProcs().find((p) => p.pid === process.pid)?.session ?? null) : null
  return ownSession
}

/**
 * `mkdir -p` that tolerates what Bun on Windows reports for some existing
 * directories (C:\Users\Public, a reparse point, gives EEXIST even with `recursive`).
 */
function ensureDir(dir: string): void {
  if (existsSync(dir)) return
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error
  }
}

const json = (v: unknown, status = 200): Response => Response.json(v, { status })
const fail = (status: number, error: string): Response => json({ error }, status)

/** Start serving. Returns the server so a test (or `/exit`) can stop it. */
export function startAgent(o: AgentOptions): ReturnType<typeof Bun.serve> {
  const token = tokenReader(o.tokenFile)
  const pwsh = new PwshHost(POWERSHELL)
  const started = performance.now()
  const log = (line: string): void => {
    if (o.log === undefined) return
    try {
      appendFileSync(o.log, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // logging is best effort
    }
  }

  const server = Bun.serve({
    port: o.port,
    hostname: o.hostname,
    maxRequestBodySize: 8 * 1024 ** 3,
    idleTimeout: 0,
    async fetch(req, srv) {
      const from = srv.requestIP(req)?.address ?? null
      if (o.allowFrom !== null && (from === null || !o.allowFrom.includes(from.replace(/^::ffff:/, "")))) {
        return fail(403, "forbidden")
      }
      const want = token()
      const got = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      if (want === null || !sameSecret(got, want)) return fail(401, "unauthorized")

      const u = new URL(req.url)
      try {
        switch (`${req.method} ${u.pathname}`) {
          case "GET /health": {
            const h: Health = {
              ok: true,
              version: AGENT_VERSION,
              pid: process.pid,
              arch: process.arch,
              platform: process.platform,
              bun: Bun.version,
              session: sessionOfSelf(),
              from,
              uptimeMs: Math.round(performance.now() - started),
            }
            return json(h)
          }
          case "POST /exec": {
            const r = (await req.json()) as ExecRequest
            if (!Array.isArray(r.argv) || r.argv.length === 0) return fail(400, "argv must be a non-empty array")
            return json(await runExec(r))
          }
          case "POST /pwsh": {
            const r = (await req.json()) as { script?: string; timeoutMs?: number }
            if (typeof r.script !== "string") return fail(400, "script must be a string")
            if (!isWin) return fail(501, "powershell is only on the Windows guest")
            return json(await pwsh.run(r.script, r.timeoutMs ?? 600_000))
          }
          case "PUT /file": {
            const path = u.searchParams.get("path")
            if (path === null || path === "") return fail(400, "path required")
            const t0 = performance.now()
            ensureDir(dirname(path))
            const bytes = await Bun.write(path, req as unknown as Response) // a Request streams like a Response; the types lag
            return json({ bytes, ms: performance.now() - t0 })
          }
          case "GET /file": {
            const path = u.searchParams.get("path")
            if (path === null || path === "") return fail(400, "path required")
            if (!existsSync(path) || !statSync(path).isFile()) return fail(404, `no such file: ${path}`)
            return new Response(Bun.file(path))
          }
          case "POST /launch": {
            const r = (await req.json()) as LaunchRequest
            if (!Array.isArray(r.argv) || r.argv.length === 0) return fail(400, "argv must be a non-empty array")
            const out = await launch(r)
            log(`launch ${JSON.stringify(r.argv)} -> pid ${String(out.pid)}`)
            return json(out)
          }
          case "GET /procs":
            return json(listProcs())
          case "POST /kill": {
            const r = (await req.json()) as { pid?: number; tree?: boolean }
            if (typeof r.pid !== "number") return fail(400, "pid required")
            if (r.tree === false) process.kill(r.pid, "SIGKILL")
            else killTree(r.pid)
            return json({ ok: true })
          }
          case "POST /exit":
            log("exit requested")
            setTimeout(() => process.exit(0), 50)
            return json({ ok: true })
          default:
            return fail(404, `no route ${req.method} ${u.pathname}`)
        }
      } catch (error) {
        return fail(500, error instanceof Error ? error.message : String(error))
      }
    },
  })
  log(`listening ${o.hostname}:${String(server.port)} pid ${String(process.pid)} ${process.arch} bun ${Bun.version}`)
  return server
}

/**
 * Audit mode opens the Sysprep dialog at every logon, on top of whatever a GUI
 * test is about to look at. The agent starts at every logon, so it closes it —
 * a few times, because the dialog can arrive after the agent does.
 */
function closeSysprep(): void {
  for (const ms of [0, 5000, 20_000, 60_000]) {
    setTimeout(() => {
      Bun.spawn(["C:\\Windows\\System32\\taskkill.exe", "/f", "/im", "sysprep.exe"], { stdout: "ignore", stderr: "ignore" })
    }, ms)
  }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const allow = flag(argv, "allow-from")
  const logFile = flag(argv, "log")
  startAgent({
    port: Number(flag(argv, "port") ?? GUEST_PORT),
    hostname: flag(argv, "hostname") ?? "0.0.0.0",
    tokenFile: flag(argv, "token-file") ?? `${WINDOWS_DIR}\\token`,
    allowFrom: allow === undefined ? null : allow.split(","),
    ...(logFile === undefined ? {} : { log: logFile }),
  })
  if (argv.includes("--close-sysprep")) closeSysprep()
}
