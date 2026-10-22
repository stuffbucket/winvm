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
 *   POST /ui      {op,...}             UI Automation via winvm-ui.exe (assets/winvm-ui.cs, docs/gui.md)
 *   POST /exit                        stop the agent (reinstall)
 */
import { spawn as nodeSpawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { timingSafeEqual } from "node:crypto"

/** Bumped whenever the protocol or behaviour changes; the host reinstalls on mismatch. */
export const AGENT_VERSION = 3
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
 * The command that starts `argv` through the session launcher (runinsession.exe,
 * `--self`): as the agent's user, in its session, with a console of its own and
 * no window. It prints `session <id> pid <pid>` and exits.
 */
export function launcherArgv(runinsession: string, argv: readonly string[]): string[] {
  return [runinsession, "--self", "--hidden", ...argv]
}

/** The pid from the launcher's `session <id> pid <pid>`, or null. */
export function parseLauncherPid(stdout: string): number | null {
  const m = /\bpid (\d+)\b/.exec(stdout)
  return m === null ? null : Number(m[1])
}

/**
 * Start a program and leave it running.
 *
 * ON WINDOWS, NOT node's `detached`. Two requirements pull apart: the program
 * must outlive the agent, so it cannot be an ordinary libuv child (those sit in
 * a kill-on-close job object and die with it); and `detached` is
 * DETACHED_PROCESS, which leaves a console program with NO console. GUI
 * programs and cmd.exe shrug that off. Windows PowerShell does not: started
 * that way it exits 0 at once and runs nothing (measured: `launch --
 * powershell.exe -File x.ps1` returned a pid and the script never ran; `conhost
 * --headless powershell …` the same, while `exec` of it worked).
 *
 * So the session launcher starts it: an ordinary child of ours that calls
 * CreateProcess with CREATE_NO_WINDOW (a console of its own, invisible; ignored
 * for GUI programs) and no inherited handles, then exits. libuv's job allows
 * silent breakaway, so the grandchild is outside it and survives us. Images or
 * installs without the launcher fall back to `detached`.
 */
async function launch(r: LaunchRequest): Promise<{ readonly pid: number }> {
  const [exe, ...rest] = r.argv
  if (exe === undefined) throw new Error("argv is empty")
  const cwd = r.cwd === undefined ? {} : { cwd: r.cwd }
  const env = r.env === undefined ? process.env : { ...process.env, ...r.env }
  const ris = `${dirname(import.meta.path)}\\runinsession.exe`
  if (isWin && existsSync(ris)) {
    const p = Bun.spawn(launcherArgv(ris, r.argv), { ...cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    const pid = parseLauncherPid(out)
    if (code !== 0 || pid === null) throw new Error(`could not start ${exe}: ${(err || out).trim() || `launcher exit ${String(code)}`}`)
    return { pid }
  }
  const child = nodeSpawn(exe, rest, { detached: true, stdio: "ignore", ...cwd, env })
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

/** A UI Automation request: `op` plus its fields (see assets/winvm-ui.cs). */
export type UiRequest = { readonly op: string } & Readonly<Record<string, unknown>>
/** What the helper answered: a result, or an error with a code (notfound | timeout | bad | fail | unavailable). */
export type UiReply = { readonly result: Record<string, unknown> } | { readonly error: string; readonly code: string }

/**
 * winvm-ui.exe, the UI Automation helper (assets/winvm-ui.cs, compiled at
 * install): one long-lived .NET process in this session, JSON lines both ways,
 * answers matched by id so a long `wait` does not hold up anything else.
 * Started on first use (the first call pays ~300 ms of UIA warm-up), started
 * again if it dies; it exits when its stdin closes, so never outlives us.
 */
class UiHost {
  private proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | null = null
  private readonly waiting = new Map<number, (r: UiReply) => void>()
  private next = 1
  private readonly exe: string
  constructor(exe: string) {
    this.exe = exe
  }

  async call(req: UiRequest): Promise<UiReply> {
    if (!isWin) return { error: "UI Automation exists only in the Windows guest", code: "unavailable" }
    if (!existsSync(this.exe)) return { error: `${this.exe} is missing: reinstall the agent (winvm agent install)`, code: "unavailable" }
    const proc = this.proc ?? this.start()
    const id = this.next++
    const reply = new Promise<UiReply>((res) => this.waiting.set(id, res))
    proc.stdin.write(`${JSON.stringify({ ...req, id })}\n`)
    await proc.stdin.flush()
    return await reply
  }

  private start(): ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> {
    const proc = Bun.spawn([this.exe], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    this.proc = proc
    void (async () => {
      const dec = new TextDecoder()
      let buf = ""
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true })
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line === "") continue
          const { id, ...r } = JSON.parse(line) as { id: number } & UiReply
          this.waiting.get(id)?.(r)
          this.waiting.delete(id)
        }
      }
      if (this.proc === proc) this.proc = null
      for (const w of this.waiting.values()) w({ error: "winvm-ui.exe exited", code: "fail" })
      this.waiting.clear()
    })()
    return proc
  }
}

// --- the spawner -------------------------------------------------------------

/**
 * Everything that starts a process runs in a SEPARATE process, the spawner,
 * started before the agent listens.
 *
 * ESSENTIAL ON WINDOWS. Bun creates its sockets inheritable and libuv spawns
 * with bInheritHandles, so every child of the process that listens gets a copy
 * of the LISTENING socket — and a detached GUI program outlives the agent. Once
 * the agent exited, that program kept the port bound and the next agent could
 * never listen (measured: a charmap started through /launch did exactly this).
 * There is no way to clear the flag from Bun (bun:ffi is not in the Windows
 * ARM64 build), so the process that spawns simply never has the socket: it is
 * started before the socket exists. One JSON line each way per operation.
 */
type Op =
  | { readonly op: "exec"; readonly req: ExecRequest }
  | { readonly op: "pwsh"; readonly script: string; readonly timeoutMs: number }
  | { readonly op: "launch"; readonly req: LaunchRequest }
  | { readonly op: "procs" }
  | { readonly op: "kill"; readonly pid: number; readonly tree: boolean }
  | { readonly op: "ui"; readonly req: UiRequest }

let pwshHost: PwshHost | null = null
let uiHost: UiHost | null = null
async function runOp(o: Op): Promise<unknown> {
  switch (o.op) {
    case "exec":
      return await runExec(o.req)
    case "pwsh":
      pwshHost ??= new PwshHost(POWERSHELL)
      return await pwshHost.run(o.script, o.timeoutMs)
    case "launch":
      return await launch(o.req)
    case "procs":
      return listProcs()
    case "kill":
      if (o.tree) killTree(o.pid)
      else process.kill(o.pid, "SIGKILL")
      return { ok: true }
    case "ui":
      uiHost ??= new UiHost(process.env["WINVM_UI_EXE"] ?? join(import.meta.dir, "winvm-ui.exe"))
      return await uiHost.call(o.req)
  }
}

/** The spawner's main loop: ops in on stdin, results out on stdout; gone with the agent. */
async function runSpawner(): Promise<void> {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true })
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim() === "") continue
      const { id, ...o } = JSON.parse(line) as Op & { id: number }
      runOp(o as Op).then(
        (result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`),
        (error: unknown) => process.stdout.write(`${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`),
      )
    }
  }
  process.exit(0)
}

/** The agent's end of the spawner. */
class Spawner {
  private readonly proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">>
  private readonly waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  private next = 1
  private dead = false

  constructor(onDeath: () => void) {
    this.proc = Bun.spawn([process.execPath, import.meta.path, "--spawner"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
    void this.read(onDeath)
  }

  private async read(onDeath: () => void): Promise<void> {
    const dec = new TextDecoder()
    let buf = ""
    for await (const chunk of this.proc.stdout) {
      buf += dec.decode(chunk, { stream: true })
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const m = JSON.parse(buf.slice(0, nl)) as { id: number; result?: unknown; error?: string }
        buf = buf.slice(nl + 1)
        const w = this.waiting.get(m.id)
        this.waiting.delete(m.id)
        if (m.error !== undefined) w?.rej(new Error(m.error))
        else w?.res(m.result)
      }
    }
    this.dead = true
    for (const w of this.waiting.values()) w.rej(new Error("the spawner exited"))
    this.waiting.clear()
    onDeath()
  }

  async call<T>(o: Op): Promise<T> {
    if (this.dead) throw new Error("the spawner exited")
    const id = this.next++
    const p = new Promise<unknown>((res, rej) => this.waiting.set(id, { res, rej }))
    this.proc.stdin.write(`${JSON.stringify({ id, ...o })}\n`)
    await this.proc.stdin.flush()
    return (await p) as T
  }

  stop(): void {
    this.dead = true
    this.proc.kill()
  }
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

export interface RunningAgent {
  readonly port: number
  stop(): void
}

/**
 * Start serving: the spawner first (see above — it must not hold the socket),
 * then the server. `onFatal` runs if the spawner dies; the agent cannot start
 * a new one without leaking the socket into it, so the CLI exits and its
 * supervisor starts both afresh.
 */
export function startAgent(o: AgentOptions, onFatal: () => void = () => {}): RunningAgent {
  const token = tokenReader(o.tokenFile)
  const started = performance.now()
  const log = (line: string): void => {
    if (o.log === undefined) return
    try {
      appendFileSync(o.log, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // logging is best effort
    }
  }
  let stopping = false
  const spawner = new Spawner(() => {
    if (stopping) return
    log("the spawner died")
    onFatal()
  })
  let session: Promise<number | null> | null = null
  const ownSession = async (): Promise<number | null> =>
    !isWin ? null : ((await spawner.call<Proc[]>({ op: "procs" })).find((p) => p.pid === process.pid)?.session ?? null)

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
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
              session ??= ownSession().catch(() => null)
              const h: Health = {
                ok: true,
                version: AGENT_VERSION,
                pid: process.pid,
                arch: process.arch,
                platform: process.platform,
                bun: Bun.version,
                session: await session,
                from,
                uptimeMs: Math.round(performance.now() - started),
              }
              return json(h)
            }
            case "POST /exec": {
              const r = (await req.json()) as ExecRequest
              if (!Array.isArray(r.argv) || r.argv.length === 0) return fail(400, "argv must be a non-empty array")
              return json(await spawner.call<ExecResponse>({ op: "exec", req: r }))
            }
            case "POST /pwsh": {
              const r = (await req.json()) as { script?: string; timeoutMs?: number }
              if (typeof r.script !== "string") return fail(400, "script must be a string")
              if (!isWin) return fail(501, "powershell is only on the Windows guest")
              return json(await spawner.call<PwshResponse>({ op: "pwsh", script: r.script, timeoutMs: r.timeoutMs ?? 600_000 }))
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
              const out = await spawner.call<{ pid: number }>({ op: "launch", req: r })
              log(`launch ${JSON.stringify(r.argv)} -> pid ${String(out.pid)}`)
              return json(out)
            }
            case "GET /procs":
              return json(await spawner.call<Proc[]>({ op: "procs" }))
            case "POST /kill": {
              const r = (await req.json()) as { pid?: number; tree?: boolean }
              if (typeof r.pid !== "number") return fail(400, "pid required")
              return json(await spawner.call({ op: "kill", pid: r.pid, tree: r.tree !== false }))
            }
            case "POST /ui": {
              const r = (await req.json()) as UiRequest
              if (typeof r.op !== "string") return fail(400, "op required")
              const out = await spawner.call<UiReply>({ op: "ui", req: r })
              if ("result" in out) return json(out.result)
              const status = { notfound: 404, timeout: 408, bad: 400, unavailable: 501 }[out.code] ?? 500
              return json({ error: out.error, code: out.code }, status)
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
  } catch (error) {
    stopping = true
    spawner.stop()
    throw error
  }
  log(`listening ${o.hostname}:${String(server.port)} pid ${String(process.pid)} ${process.arch} bun ${Bun.version}`)
  return {
    port: server.port ?? o.port,
    stop: () => {
      stopping = true
      spawner.stop()
      void server.stop(true)
    },
  }
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

/**
 * `--supervise`: run the agent as a child and start it again if it dies (not
 * after a clean exit, which is what /exit asks for). Holds no socket itself.
 * Killing the supervisor takes the agent with it (libuv's kill-on-close job).
 */
async function supervise(argv: readonly string[]): Promise<never> {
  let backoff = 1000
  for (;;) {
    const t0 = Date.now()
    const p = Bun.spawn([process.execPath, import.meta.path, ...argv], { stdio: ["ignore", "inherit", "inherit"] })
    const code = await p.exited
    if (code === 0) process.exit(0)
    backoff = Date.now() - t0 > 60_000 ? 1000 : Math.min(backoff * 2, 30_000)
    await Bun.sleep(backoff)
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (argv.includes("--spawner")) {
    await runSpawner()
  } else if (argv.includes("--supervise")) {
    await supervise(argv.filter((a) => a !== "--supervise"))
  } else {
    const allow = flag(argv, "allow-from")
    const logFile = flag(argv, "log")
    try {
      startAgent(
        {
          port: Number(flag(argv, "port") ?? GUEST_PORT),
          hostname: flag(argv, "hostname") ?? "0.0.0.0",
          tokenFile: flag(argv, "token-file") ?? `${WINDOWS_DIR}\\token`,
          allowFrom: allow === undefined ? null : allow.split(","),
          ...(logFile === undefined ? {} : { log: logFile }),
        },
        () => process.exit(3),
      )
    } catch (error) {
      // Usually the port: something still holds it. Say so where install looks.
      if (logFile !== undefined) appendFileSync(logFile, `${new Date().toISOString()} could not start: ${String(error)}\n`)
      process.exit(2)
    }
    if (argv.includes("--close-sysprep")) closeSysprep()
  }
}
