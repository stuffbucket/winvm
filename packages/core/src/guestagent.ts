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
 *   GET  /fs/list?path=…&hidden=1&limit=N  a folder's entries, and the known folders -> DirListing
 *   POST /fs/mkdir  {path}            a new folder (its parent must exist)       -> {path}
 *   POST /fs/rename {from,to}         rename or move; never replaces anything     -> {path}
 *   POST /fs/copy   {from,to}         a file or a whole folder; never replaces    -> {path}
 *   POST /fs/delete {paths,recycle?}  to the Recycle Bin (default), or for good  -> {deleted}
 *                                     the /fs/* routes fail with {error, code}: see FsCode
 *   POST /kill    {pid,tree?}
 *   POST /ui      {op,...}             UI Automation via winvm-ui.exe (assets/winvm-ui.cs, docs/gui.md)
 *   GET  /term?shell=&cwd=&cols=&rows=  a terminal, as a WebSocket (conpty.exe, assets/conpty.cs)
 *   POST /display {op,...}             screen size and scaling via winvm-display.exe (assets/winvm-display.cs)
 *   GET  /stats                       memory in use and the system drive's space -> GuestStats
 *   POST /smb/setup {user,password}   share C:\ and the profile with the Mac (finder.ts) -> {code,output,ms,timedOut}
 *   POST /exit                        stop the agent (reinstall)
 */
import { spawn as nodeSpawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, type Stats as FileStats } from "node:fs"
import { cp, lstat, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises"
import { freemem, homedir, totalmem } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { Server, ServerWebSocket, Socket, TCPSocketListener, WebSocketHandler } from "bun"

/** Bumped whenever the protocol or behaviour changes; the host reinstalls on mismatch. */
export const AGENT_VERSION = 9
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
  /** The terminal helper's command (tests); default conpty.exe beside the agent. */
  readonly termHelper?: readonly string[]
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

// --- folder listings ---------------------------------------------------------

/** One thing in a folder. `size` and `modified` are null when Windows would not say (access denied, a dangling link). */
export interface DirEntry {
  readonly name: string
  readonly dir: boolean
  /** Bytes; null for a folder. */
  readonly size: number | null
  /** Last written, in ms since the epoch. */
  readonly modified: number | null
  /** Hidden or system, which Explorer hides by default (a dot name where there is no such attribute). */
  readonly hidden: boolean
}

/** A folder people go to: Desktop, Documents, Downloads, the profile, C:\work, and the drives. */
export interface Place {
  readonly kind: "desktop" | "documents" | "downloads" | "home" | "work" | "drive"
  readonly name: string
  readonly path: string
}

export interface DirListing {
  /** The folder, absolute and normalized. */
  readonly path: string
  /** The folder it is in; null at a drive's root. */
  readonly parent: string | null
  /** Folders first, then files, each by name as Explorer orders them; at most `limit` of them. */
  readonly entries: readonly DirEntry[]
  /** How many there are in all (hidden ones only when asked for): more than `entries` holds when cut at the limit. */
  readonly total: number
  readonly places: readonly Place[]
}

/** What /fs/mkdir, /fs/rename and /fs/copy answer: where the item is now. */
export interface FsPathResult {
  readonly path: string
}

/** What /fs/delete answers: how many of the paths went. */
export interface FsDeleteResult {
  readonly deleted: number
}

/** The most entries a listing returns unless asked for more: a huge folder still answers at once. */
export const LIST_LIMIT = 5000
const LIST_LIMIT_MAX = 100_000
/** Stats at a time: each one opens the file on Windows, so a 20 000-entry folder is not 20 000 handles at once. */
const STAT_BATCH = 256

/**
 * Why a file operation failed, as the /fs/* routes say it: `notfound` (404),
 * `denied` (403), `notdir` (400, a file where a folder is needed), `exists`
 * (409, the target is taken: nothing is ever replaced), `busy` (409, in use by
 * a program), `into` (400, a folder moved or copied into itself), `bad` (400,
 * a malformed request or name) and `unavailable` (501, no Recycle Bin here).
 */
export type FsCode = "notfound" | "denied" | "notdir" | "exists" | "busy" | "into" | "bad" | "unavailable"

const FS_STATUS: Readonly<Record<FsCode, number>> = { notfound: 404, denied: 403, notdir: 400, exists: 409, busy: 409, into: 400, bad: 400, unavailable: 501 }

/** A file operation's failure: the route's status, and a `code` the caller can branch on. */
export class FsError extends Error {
  readonly status: number
  readonly code: FsCode
  constructor(code: FsCode, message: string) {
    super(message)
    this.status = FS_STATUS[code]
    this.code = code
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The known folders that exist here: the agent's user's, since it runs as them. */
export function knownFolders(): Place[] {
  const home = process.env["USERPROFILE"] ?? homedir()
  const places: Place[] = []
  const add = (kind: Place["kind"], path: string, name: string): void => {
    if (isDir(path)) places.push({ kind, name, path })
  }
  add("desktop", join(home, "Desktop"), "Desktop")
  add("documents", join(home, "Documents"), "Documents")
  add("downloads", join(home, "Downloads"), "Downloads")
  add("home", home, home.split(/[\\/]/).filter((p) => p !== "").pop() ?? home)
  if (!isWin) {
    add("drive", "/", "/")
    return places
  }
  add("work", "C:\\work", "work")
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") add("drive", `${letter}:\\`, `${letter}:`)
  return places
}

/** Absolute and tidy; a bare `C:` is the drive's root, not the current folder on it. */
export const normalizeDir = (path: string): string => resolve(/^[A-Za-z]:$/.test(path) ? `${path}\\` : path)

/**
 * The names `dir /a:h` prints: the hidden and system entries, the one thing
 * Node's fs cannot tell on Windows. `cmd /u` makes its built-ins write UTF-16
 * to a pipe, so any name survives (the OEM code page would not). It spawns, so
 * it runs in the spawner.
 */
async function hiddenNames(dir: string): Promise<string[]> {
  const p = Bun.spawn(["C:\\Windows\\System32\\cmd.exe", "/d", "/u", "/s", "/c", `"dir /b /a:h "${dir}""`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    windowsVerbatimArguments: true,
  })
  const [out] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited])
  return Buffer.from(out).toString("utf16le").split(/\r?\n/).filter((n) => n !== "")
}

function listError(error: unknown, path: string): Error {
  switch ((error as { code?: string }).code) {
    case "ENOENT":
      return new FsError("notfound", `no such folder: ${path}`)
    case "EACCES":
    case "EPERM":
      return new FsError("denied", `access denied: ${path}`)
    case "ENOTDIR":
      return new FsError("notdir", `not a folder: ${path}`)
    default:
      return error instanceof Error ? error : new Error(String(error))
  }
}

type Stats = Awaited<ReturnType<typeof stat>>

async function statAll(paths: readonly string[]): Promise<(Stats | null)[]> {
  const out: (Stats | null)[] = []
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    out.push(...(await Promise.all(paths.slice(i, i + STAT_BATCH).map(async (p) => await stat(p).catch(() => null)))))
  }
  return out
}

/**
 * One folder's entries, folders first. Only what is returned is stat'ed (and
 * links, to learn whether they lead to a folder), so a folder of tens of
 * thousands answers about as fast as one of `limit`.
 */
export async function listDir(
  path: string,
  o: { readonly withHidden: boolean; readonly limit: number; readonly hidden: Promise<ReadonlySet<string>> },
): Promise<Omit<DirListing, "places">> {
  const dirents = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    throw listError(error, path)
  })
  const hidden = await o.hidden
  const isHidden = (name: string): boolean => hidden.has(name) || (!isWin && name.startsWith("."))
  const kept = dirents.filter((d) => o.withHidden || !isHidden(d.name))
  const links = kept.filter((d) => d.isSymbolicLink())
  const linkStats = await statAll(links.map((d) => join(path, d.name)))
  const linkDir = new Map(links.map((d, i) => [d.name, linkStats[i]?.isDirectory() ?? false]))
  const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
  const sorted = kept
    .map((d) => ({ name: d.name, dir: linkDir.get(d.name) ?? d.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? byName.compare(a.name, b.name) : a.dir ? -1 : 1))
    .slice(0, Math.max(0, Math.min(o.limit, LIST_LIMIT_MAX)))
  const stats = await statAll(sorted.map((e) => join(path, e.name)))
  const entries = sorted.map((e, i): DirEntry => {
    const st = stats[i] ?? null
    return {
      name: e.name,
      dir: e.dir,
      size: e.dir || st === null ? null : Number(st.size),
      modified: st === null ? null : Math.round(Number(st.mtimeMs)),
      hidden: isHidden(e.name),
    }
  })
  const up = dirname(path)
  return { path, parent: up === path ? null : up, entries, total: kept.length }
}

// --- changing files ----------------------------------------------------------

/** An fs call's failure as an FsError, naming `path`. */
function fsFailure(error: unknown, path: string): Error {
  switch ((error as { code?: string }).code) {
    case "ENOENT":
      return new FsError("notfound", `no such file or folder: ${path}`)
    case "EACCES":
    case "EPERM":
      return new FsError("denied", `access denied: ${path}`)
    case "ENOTDIR":
      return new FsError("notdir", `not a folder: ${path}`)
    case "EEXIST":
    case "ENOTEMPTY":
      return new FsError("exists", `already exists: ${path}`)
    case "EBUSY":
      return new FsError("busy", `in use by a program: ${path}`)
    case "EINVAL":
    case "ENAMETOOLONG":
      return new FsError("bad", `not a name Windows takes: ${path}`)
    default:
      return error instanceof Error ? error : new Error(String(error))
  }
}

/** A request's path: a non-empty string, made absolute and tidy. */
export function fsPath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new FsError("bad", "a path is required")
  return normalizeDir(value)
}

const there = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null)) !== null

async function lstatOf(path: string): Promise<FileStats> {
  try {
    return await lstat(path)
  } catch (error) {
    throw fsFailure(error, path)
  }
}

/** `b` is `a` itself, perhaps spelt in another case: renaming it only changes its case. */
async function sameItem(a: string, b: string, aStat: FileStats): Promise<boolean> {
  if (isWin) return a.toLowerCase() === b.toLowerCase()
  const bStat = await lstat(b).catch(() => null)
  return bStat !== null && bStat.ino === aStat.ino && bStat.dev === aStat.dev
}

/** `path` is `folder` or somewhere under it (Windows' paths compare without case). */
export function isWithin(folder: string, path: string): boolean {
  const rel = isWin ? relative(folder.toLowerCase(), path.toLowerCase()) : relative(folder, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** The folder a new item goes in must be there, and be a folder. */
async function needFolder(path: string): Promise<void> {
  const parent = dirname(path)
  const st = await stat(parent).catch(() => null)
  if (st === null) throw new FsError("notfound", `no such folder: ${parent}`)
  if (!st.isDirectory()) throw new FsError("notdir", `not a folder: ${parent}`)
}

/** A new, empty folder. Its parent must exist. */
export async function makeFolder(raw: unknown): Promise<string> {
  const path = fsPath(raw)
  if (await there(path)) throw new FsError("exists", `already exists: ${path}`)
  await needFolder(path)
  try {
    await mkdir(path)
  } catch (error) {
    throw fsFailure(error, path)
  }
  return path
}

/** A file or folder, and everything in it, copied to `to`. Links stay links. */
async function copyTree(from: string, to: string): Promise<void> {
  try {
    await cp(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true })
  } catch (error) {
    throw fsFailure(error, to)
  }
}

/**
 * Rename or move `from` to `to`, a full path (moving into a folder is
 * `folder\name`). Nothing is ever replaced: a taken `to` is `exists`, unless it
 * is `from` itself in another case, which renames it. Onto another drive it
 * copies, then removes the original.
 */
export async function movePath(rawFrom: unknown, rawTo: unknown): Promise<string> {
  const from = fsPath(rawFrom)
  const to = fsPath(rawTo)
  const st = await lstatOf(from)
  if (!(await sameItem(from, to, st))) {
    if (st.isDirectory() && isWithin(from, to)) throw new FsError("into", `can't move a folder into itself: ${to}`)
    if (await there(to)) throw new FsError("exists", `already exists: ${to}`)
    await needFolder(to)
  }
  try {
    await rename(from, to)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== "EXDEV") throw fsFailure(error, code === "ENOENT" ? from : to)
    await copyTree(from, to)
    try {
      await rm(from, { recursive: true })
    } catch (e) {
      throw fsFailure(e, from)
    }
  }
  return to
}

/** Copy a file, or a folder and all in it, to `to`. Nothing is ever replaced. */
export async function copyPath(rawFrom: unknown, rawTo: unknown): Promise<string> {
  const from = fsPath(rawFrom)
  const to = fsPath(rawTo)
  const st = await lstatOf(from)
  if (await there(to)) throw new FsError("exists", `already exists: ${to}`)
  if (st.isDirectory() && isWithin(from, to)) throw new FsError("into", `can't copy a folder into itself: ${to}`)
  await needFolder(to)
  await copyTree(from, to)
  return to
}

/**
 * Sends one item to the Recycle Bin through shell32's SHFileOperation,
 * compiled once into the agent's warm PowerShell. Not Microsoft.VisualBasic's
 * FileSystem.DeleteFile: its recycling overloads take a UIOption whose quietest
 * value is OnlyErrorDialogs, and an error dialog in the logged-on session
 * would hold the request until someone clicked it. These flags show nothing,
 * ever: FOF_ALLOWUNDO (0x40, the Recycle Bin) | FOF_NOCONFIRMATION (0x10) |
 * FOF_NOERRORUI (0x400) | FOF_SILENT (0x4). It returns the shell's code, or
 * -1 when the operation was aborted.
 */
const RECYCLE_CS = `using System;
using System.Runtime.InteropServices;
public static class WinvmRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string path) {
    var op = new SHFILEOPSTRUCT { wFunc = 3, pFrom = path + "\\0\\0", fFlags = 0x0454 };
    int r = SHFileOperation(ref op);
    return r == 0 && op.fAnyOperationsAborted ? -1 : r;
  }
}`

/**
 * The PowerShell that recycles `paths`, printing `recycle <index> <code>` for
 * each. The paths travel as base64, so no name can break out of the script.
 */
export function recycleScript(paths: readonly string[]): string {
  const b64 = paths.map((p) => `'${Buffer.from(p, "utf8").toString("base64")}'`).join(",")
  return [
    "if (-not ('WinvmRecycle' -as [type])) { Add-Type -TypeDefinition @'",
    RECYCLE_CS,
    "'@ }",
    `$paths = @(@(${b64}) | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })`,
    'for ($i = 0; $i -lt $paths.Count; $i++) { "recycle $i $([WinvmRecycle]::Recycle($paths[$i]))" }',
  ].join("\n")
}

/** What SHFileOperation's codes (Win32 errors, or its own DE_* ones) mean here. */
export function recycleFailure(code: number, path: string): Error {
  if ([0x2, 0x3, 0x7c, 0x402].includes(code)) return new FsError("notfound", `no such file or folder: ${path}`)
  if ([0x5, 0x78].includes(code)) return new FsError("denied", `access denied: ${path}`)
  if ([0x20, 0x21].includes(code)) return new FsError("busy", `in use by a program: ${path}`)
  if (code === -1) return new Error(`moving ${path} to the Recycle Bin was cancelled`)
  return new Error(`couldn't move ${path} to the Recycle Bin (shell error 0x${code.toString(16)})`)
}

/** The codes `recycleScript` printed, by index; null where it printed none. */
export function parseRecycled(output: string, count: number): (number | null)[] {
  const codes: (number | null)[] = Array.from({ length: count }, () => null)
  for (const m of output.matchAll(/^recycle (\d+) (-?\d+)\s*$/gm)) {
    const i = Number(m[1])
    if (i < count) codes[i] = Number(m[2])
  }
  return codes
}

/**
 * Delete files and folders: to the Recycle Bin (Windows only), or for good,
 * with everything in them. Every path is checked first, so a missing one
 * deletes nothing. Recycling runs PowerShell, which only the spawner may start,
 * so the caller passes the way to it.
 */
export async function removePaths(
  raw: unknown,
  o: { readonly recycle: boolean; readonly pwsh: (script: string) => Promise<PwshResponse> },
): Promise<number> {
  if (!Array.isArray(raw) || raw.length === 0) throw new FsError("bad", "paths must be a non-empty array")
  const paths = raw.map(fsPath)
  for (const p of paths) {
    if (dirname(p) === p) throw new FsError("denied", `won't delete a drive: ${p}`)
    await lstatOf(p)
  }
  if (!o.recycle) {
    for (const p of paths) {
      try {
        await rm(p, { recursive: true })
      } catch (error) {
        throw fsFailure(error, p)
      }
    }
    return paths.length
  }
  if (!isWin) throw new FsError("unavailable", "there is no Recycle Bin here: delete permanently instead")
  const out = await o.pwsh(recycleScript(paths))
  const codes = parseRecycled(out.output, paths.length)
  const bad = codes.findIndex((c) => c !== 0)
  if (bad === -1) return paths.length
  const code = codes[bad] ?? null
  const path = paths[bad] ?? ""
  if (code === null) throw new Error(`couldn't move ${path} to the Recycle Bin: ${out.output.trim() || `exit ${String(out.code)}`}`)
  throw recycleFailure(code, path)
}

/**
 * A display request (assets/winvm-display.cs): `get`, `modes`, `set` (width,
 * height, waitMs?, scale?) or `scale` (scale).
 */
export interface DisplayRequest {
  readonly op: "get" | "modes" | "set" | "scale"
  readonly width?: number
  readonly height?: number
  readonly waitMs?: number
  readonly scale?: number
}

/** winvm-display.exe's arguments for a request; null when the request is malformed. */
export function displayArgv(r: DisplayRequest): string[] | null {
  const int = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0
  switch (r.op) {
    case "get":
    case "modes":
      return [r.op]
    case "set":
      if (!int(r.width) || !int(r.height)) return null
      if (r.waitMs !== undefined && !int(r.waitMs)) return null
      if (r.scale !== undefined && !int(r.scale)) return null
      return ["set", String(r.width), String(r.height), String(r.waitMs ?? 2000), String(r.scale ?? 0)]
    case "scale":
      return int(r.scale) ? ["scale", String(r.scale)] : null
    default:
      return null
  }
}

/**
 * What the meters show: Windows' memory (total and available, as Task Manager
 * counts "in use" = total - available) and the system drive's space. Cheap:
 * no process is started, so the host can ask every few seconds.
 */
export interface GuestStats {
  readonly memory: { readonly total: number; readonly available: number }
  /** The system drive (C:\ on Windows); null if it could not be read. */
  readonly disk: { readonly path: string; readonly total: number; readonly free: number } | null
}

export async function guestStats(): Promise<GuestStats> {
  const path = isWin ? `${process.env["SystemDrive"] ?? "C:"}\\` : "/"
  let disk: GuestStats["disk"] = null
  try {
    const s = await statfs(path)
    disk = { path, total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) }
  } catch {
    // reported as unknown
  }
  return { memory: { total: totalmem(), available: freemem() }, disk }
}

// --- file sharing with the Mac (finder.ts) -----------------------------------

/** POST /smb/setup: the account the Mac signs in as, and its password. In the body, never on a command line. */
export interface SmbSetupRequest {
  readonly user: string
  readonly password: string
}

/** The shares the Mac mounts, by name: the whole of C:, and the profile. */
export const SMB_SHARES: Readonly<Record<string, string>> = { C: "C:\\", Home: "C:\\Users\\Administrator" }

/** Checks a /smb/setup body; null when it is fine. The script quotes both, so they are held to plain characters. */
export function smbSetupError(r: Partial<Record<keyof SmbSetupRequest, unknown>>): string | null {
  if (typeof r.user !== "string" || !/^[A-Za-z0-9._-]{1,20}$/.test(r.user)) return "user must be 1-20 letters, digits, '.', '_' or '-'"
  if (typeof r.password !== "string" || !/^[A-Za-z0-9_-]{20,127}$/.test(r.password)) {
    return "password must be 20-127 letters, digits, '_' or '-'"
  }
  return null
}

/**
 * The PowerShell that makes the guest's file server reachable from the Mac,
 * and only from the Mac. Idempotent: run again, it resets the password and
 * puts everything back as it should be.
 *
 *   1. a local account, created disabled (or its password reset);
 *   2. denied interactive, remote-interactive, batch and service logons
 *      (secedit), BEFORE it is enabled — so it never logs on anywhere but the
 *      network, and no profile is ever made for it;
 *   3. an administrator (to reach every file), hidden from the sign-in screen;
 *   4. the Server service automatic and running; the shares (C:\ and the
 *      profile, caching off); and a firewall rule letting TCP 445 in from
 *      10.0.2.2 only — the address slirp gives connections from the Mac.
 *
 * SMB signing and encryption are left as Windows has them (signing required,
 * encryption off): the traffic never leaves the Mac.
 */
export function smbSetupScript(r: SmbSetupRequest): string {
  const shares = Object.entries(SMB_SHARES)
    .map(([name, path]) => `'${name}' = '${path}'`)
    .join("; ")
  return String.raw`$ErrorActionPreference = 'Stop'
$user = '${r.user}'
$secret = ConvertTo-SecureString '${r.password}' -AsPlainText -Force
$shares = [ordered]@{ ${shares} }
$rights = 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyBatchLogonRight', 'SeDenyServiceLogonRight'

$u = Get-LocalUser -Name $user -ErrorAction SilentlyContinue
if ($null -eq $u) {
  New-LocalUser -Name $user -Password $secret -Disabled -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword -Description 'winvm: the Mac opens C: and Home in Finder' | Out-Null
  "created $user (disabled until its logons are limited)"
} else {
  Set-LocalUser -Name $user -Password $secret -PasswordNeverExpires $true -AccountNeverExpires
  "reset the password of $user"
}
$sid = (Get-LocalUser -Name $user).SID.Value

# Callers wrap it in @(): PowerShell unrolls a returned array, so one member
# would come back a string, and += would glue the SID onto its name.
function Get-Members($inf, $right) {
  $line = Get-Content $inf | Where-Object { $_ -match "^$right\s*=" } | Select-Object -First 1
  if ($null -eq $line) { return @() }
  return @(($line -replace "^$right\s*=\s*", '').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}
$tmp = Join-Path $env:TEMP ('winvm-smb-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  secedit /export /cfg "$tmp\now.inf" /areas USER_RIGHTS /quiet | Out-Null
  $out = @('[Unicode]', 'Unicode=yes', '[Version]', 'signature="$CHICAGO$"', 'Revision=1', '[Privilege Rights]')
  foreach ($right in $rights) {
    $list = @(Get-Members "$tmp\now.inf" $right)
    if (($list -notcontains "*$sid") -and ($list -notcontains $user)) { $list += "*$sid" }
    $out += "$right = $($list -join ',')"
  }
  Set-Content -Path "$tmp\deny.inf" -Value $out -Encoding Unicode
  secedit /configure /db "$tmp\deny.sdb" /cfg "$tmp\deny.inf" /areas USER_RIGHTS /log "$tmp\deny.log" /quiet | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $why = (Get-Content "$tmp\deny.log" -ErrorAction SilentlyContinue | Where-Object { $_ -match '\S' } | Select-Object -Last 8) -join "; "
    throw "secedit /configure failed ($LASTEXITCODE): $why"
  }
  secedit /export /cfg "$tmp\after.inf" /areas USER_RIGHTS /quiet | Out-Null
  foreach ($right in $rights) {
    $list = @(Get-Members "$tmp\after.inf" $right)
    if (($list -notcontains "*$sid") -and ($list -notcontains $user)) { throw "$right does not name $user" }
  }
  "denied $user interactive, remote-interactive, batch and service logons"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$admins = Get-LocalGroup -SID 'S-1-5-32-544'
if (-not (Get-LocalGroupMember -Group $admins | Where-Object { $_.SID.Value -eq $sid })) {
  Add-LocalGroupMember -Group $admins -Member $sid
}
$hidden = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
New-Item -Path $hidden -Force | Out-Null
New-ItemProperty -Path $hidden -Name $user -Value 0 -PropertyType DWord -Force | Out-Null
# With UAC on, a local administrator signing in over the network gets a
# filtered token without its rights, and the profile is closed to it.
$system = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
if ((Get-ItemProperty $system).EnableLUA -ne 0) {
  New-ItemProperty -Path $system -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force | Out-Null
}
Enable-LocalUser -Name $user
"$user is an administrator, hidden from the sign-in screen"

Set-Service -Name LanmanServer -StartupType Automatic
Start-Service -Name LanmanServer
foreach ($name in $shares.Keys) {
  if (Get-SmbShare -Name $name -ErrorAction SilentlyContinue) { Remove-SmbShare -Name $name -Force }
  New-SmbShare -Name $name -Path $shares[$name] -FullAccess $user -CachingMode None | Out-Null
  "shared $($shares[$name]) as $name"
}
Remove-NetFirewallRule -Name 'winvm-smb' -ErrorAction SilentlyContinue
New-NetFirewallRule -Name 'winvm-smb' -DisplayName 'winvm: file sharing with the Mac' -Direction Inbound -Protocol TCP -LocalPort 445 -RemoteAddress 10.0.2.2 -Action Allow -Profile Any | Out-Null
"firewall rule winvm-smb: TCP 445 from 10.0.2.2 only"
`
}

/** A UI Automation request: `op` plus its fields (see assets/winvm-ui.cs). */
export type UiRequest = { readonly op: string } & Readonly<Record<string, unknown>>
/** What the helper answered: a result, or an error with a code (notfound | timeout | covered | bad | fail | unavailable). */
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

const LATE = Symbol("late")

/**
 * winvm-display.exe kept running (`serve`, assets/winvm-display.cs): a
 * request's words in, one JSON line out, in order. Starting it costs ~0.6 s in
 * the guest, most of a live resize, so it starts once. One request at a time:
 * a `set` waiting for the driver's mode holds the next rather than interleave.
 * A helper that does not answer in time is stopped; the next request starts a
 * fresh one, as does one after it exits.
 */
export class DisplayHost {
  private proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | null = null
  private answer: ((line: string | null) => void) | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly argv: readonly string[]
  /** `argv`: the helper's command, without `serve`. */
  constructor(argv: readonly string[]) {
    this.argv = argv
  }

  call(args: readonly string[], timeoutMs: number): Promise<string> {
    const run = this.queue.then(async () => await this.send(args, timeoutMs))
    this.queue = run.catch(() => undefined)
    return run
  }

  stop(): void {
    const proc = this.proc
    this.proc = null
    this.answer?.(null)
    proc?.kill()
  }

  private async send(args: readonly string[], timeoutMs: number): Promise<string> {
    const proc = this.proc ?? this.start()
    const line = new Promise<string | null>((res) => (this.answer = res))
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<typeof LATE>((res) => (timer = setTimeout(() => res(LATE), timeoutMs)))
    try {
      proc.stdin.write(`${args.join(" ")}\n`)
      await proc.stdin.flush()
      const got = await Promise.race([line, late])
      if (got === LATE) {
        this.stop()
        throw new Error(`winvm-display.exe did not answer within ${String(timeoutMs)} ms`)
      }
      if (got === null) throw new Error("winvm-display.exe exited")
      return got
    } finally {
      clearTimeout(timer)
      this.answer = null
    }
  }

  private start(): ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> {
    const proc = Bun.spawn([...this.argv, "serve"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    this.proc = proc
    void (async () => {
      const dec = new TextDecoder()
      let buf = ""
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true })
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const got = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (got !== "" && this.proc === proc) this.answer?.(got)
        }
      }
      if (this.proc === proc) {
        this.proc = null
        this.answer?.(null)
      }
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
  | { readonly op: "hidden"; readonly path: string }
  | { readonly op: "display"; readonly args: readonly string[]; readonly timeoutMs: number }

/** Where winvm-display.exe is: beside the agent, or WINVM_DISPLAY_EXE (tests). */
const displayExe = (): string => process.env["WINVM_DISPLAY_EXE"] ?? join(import.meta.dir, "winvm-display.exe")

let pwshHost: PwshHost | null = null
let uiHost: UiHost | null = null
let displayHost: DisplayHost | null = null
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
    case "hidden":
      return await hiddenNames(o.path)
    case "display":
      displayHost ??= new DisplayHost([displayExe()])
      return { line: await displayHost.call(o.args, o.timeoutMs) }
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

// --- terminals (GET /term) ----------------------------------------------------

/**
 * A terminal is a WebSocket on GET /term, carried in the guest by conpty.exe
 * (assets/conpty.cs): a shell in a pseudo-console. Binary frames are terminal
 * bytes both ways; text frames are JSON control messages (TermControl in,
 * TermEvent out). Browsers cannot set headers on a WebSocket, so the token may
 * also come as a subprotocol: the client offers `winvm-term,
 * winvm-token.<token>` and the agent answers `winvm-term`.
 *
 * The HTTP server must not spawn (the spawner section above), so the spawner
 * launches conpty.exe through runinsession.exe, and conpty.exe connects BACK to
 * a loopback listener here, naming its session with a one-time key. It exits
 * when that connection ends, and takes the shell's tree with it (a job object),
 * so closing the WebSocket, or the agent dying, leaves nothing behind.
 */
export const TERM_PROTOCOL = "winvm-term"
export const TERM_TOKEN_PREFIX = "winvm-token."
export const TERM_SHELLS = ["pwsh", "powershell", "cmd"] as const
export type TermShell = (typeof TERM_SHELLS)[number]

export interface TermRequest {
  readonly shell: TermShell
  readonly cwd: string | null
  readonly cols: number
  readonly rows: number
}
/** Client to agent, as a text frame. */
export type TermControl = { readonly type: "resize"; readonly cols: number; readonly rows: number }
/** Agent to client, as a text frame. */
export type TermEvent = { readonly type: "exit"; readonly code: number } | { readonly type: "error"; readonly message: string }

/** What a Sec-WebSocket-Protocol header offers: our protocol, and a token. */
export function termProtocols(header: string | null): { readonly offered: boolean; readonly token: string | null } {
  const list = (header ?? "").split(",").map((s) => s.trim())
  const tok = list.find((s) => s.startsWith(TERM_TOKEN_PREFIX))
  return { offered: list.includes(TERM_PROTOCOL), token: tok === undefined ? null : tok.slice(TERM_TOKEN_PREFIX.length) }
}

const dim = (v: string | null, dflt: number): number | null => {
  if (v === null || v === "") return dflt
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null
}

/** GET /term's query: `shell` (default pwsh), `cwd`, `cols` and `rows` (default 80x24). */
export function parseTermQuery(q: URLSearchParams): TermRequest | { readonly error: string } {
  const shell = q.get("shell") ?? "pwsh"
  if (!(TERM_SHELLS as readonly string[]).includes(shell)) return { error: `shell must be one of ${TERM_SHELLS.join(", ")}` }
  const cols = dim(q.get("cols"), 80)
  const rows = dim(q.get("rows"), 24)
  if (cols === null || rows === null) return { error: "cols and rows must be whole numbers from 1 to 1000" }
  const cwd = q.get("cwd")
  return { shell: shell as TermShell, cwd: cwd === null || cwd === "" ? null : cwd, cols, rows }
}

/** A client's text frame, or null for anything that is not a well-formed control message. */
export function parseTermControl(text: string): TermControl | null {
  try {
    const m = JSON.parse(text) as Record<string, unknown>
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1000
    if (m["type"] === "resize" && ok(m["cols"]) && ok(m["rows"])) return { type: "resize", cols: m["cols"], rows: m["rows"] }
  } catch {
    // not JSON
  }
  return null
}

/** One frame on the conpty.exe connection: [type][uint32 LE length][payload]. */
export function termFrame(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  out[0] = type.charCodeAt(0)
  new DataView(out.buffer).setUint32(1, payload.length, true)
  out.set(payload, 5)
  return out
}

/** The resize frame's payload: cols, rows as uint16 LE. */
export function resizePayload(cols: number, rows: number): Uint8Array {
  const b = new Uint8Array(4)
  const v = new DataView(b.buffer)
  v.setUint16(0, cols, true)
  v.setUint16(2, rows, true)
  return b
}

/** Reassembles frames from a byte stream that arrives in arbitrary pieces. */
export class FrameReader {
  private buf = new Uint8Array(0)
  push(chunk: Uint8Array): { readonly type: string; readonly payload: Uint8Array }[] {
    const all = new Uint8Array(this.buf.length + chunk.length)
    all.set(this.buf)
    all.set(chunk, this.buf.length)
    const frames: { type: string; payload: Uint8Array }[] = []
    let off = 0
    while (all.length - off >= 5) {
      const n = new DataView(all.buffer, off + 1, 4).getUint32(0, true)
      if (all.length - off - 5 < n) break
      frames.push({ type: String.fromCharCode(all[off] ?? 0), payload: all.slice(off + 5, off + 5 + n) })
      off += 5 + n
    }
    this.buf = all.slice(off)
    return frames
  }
}

/**
 * The shell's command line in the guest. Images built before PowerShell 7 was
 * part of them have no pwsh.exe: Windows PowerShell stands in, with a note
 * for the terminal saying so.
 */
export function termShellArgv(
  shell: TermShell,
  o: { readonly win?: boolean; readonly exists?: (path: string) => boolean; readonly env?: Readonly<Record<string, string | undefined>> } = {},
): { readonly argv: string[]; readonly note: string | null } {
  if (!(o.win ?? isWin)) return { argv: [shell], note: null }
  if (shell === "cmd") return { argv: ["C:\\Windows\\System32\\cmd.exe"], note: null }
  const env = o.env ?? process.env
  const dirs = [`${env["ProgramFiles"] ?? "C:\\Program Files"}\\PowerShell\\7`, ...(env["PATH"] ?? "").split(";")]
  const pwsh = shell === "pwsh" ? dirs.filter((d) => d !== "").map((d) => `${d.replace(/\\$/, "")}\\pwsh.exe`).find(o.exists ?? existsSync) : undefined
  if (pwsh !== undefined) return { argv: [pwsh, "-NoLogo"], note: null }
  const note = shell === "pwsh" ? "PowerShell 7 is not installed in this guest; this is Windows PowerShell.\r\n" : null
  return { argv: [POWERSHELL, "-NoLogo"], note }
}

interface TermSession {
  readonly key: string
  readonly req: TermRequest
  ws: ServerWebSocket<TermSession> | null
  helper: Socket<TermLink> | null
  /** Frames for conpty.exe sent while it was still connecting, or held back by a full socket. */
  readonly out: Uint8Array[]
  pid: number | null
  done: boolean
  timer: ReturnType<typeof setTimeout> | null
}
interface TermLink {
  session: TermSession | null
  readonly frames: FrameReader
}

/** How long conpty.exe has to start and connect back. */
const TERM_CONNECT_MS = 20_000

class Terminals {
  private listener: TCPSocketListener<TermLink> | null = null
  private readonly sessions = new Map<string, TermSession>()
  private readonly spawner: Spawner
  private readonly helper: readonly string[] | undefined
  private readonly log: (line: string) => void

  constructor(spawner: Spawner, helper: readonly string[] | undefined, log: (line: string) => void) {
    this.spawner = spawner
    this.helper = helper
    this.log = log
  }

  private port(): number {
    this.listener ??= Bun.listen<TermLink>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          s.data = { session: null, frames: new FrameReader() }
        },
        data: (s, chunk) => {
          for (const f of s.data.frames.push(chunk)) this.fromHelper(s, f.type, f.payload)
        },
        drain: (s) => {
          if (s.data.session !== null) this.flush(s.data.session)
        },
        close: (s) => {
          const t = s.data.session
          if (t !== null) this.finish(t, { type: "error", message: "the terminal helper exited unexpectedly" })
        },
        error: () => undefined,
      },
    })
    return this.listener.port
  }

  /** Upgrade the request, or answer why not. */
  upgrade(req: Request, srv: Server<TermSession>, u: URL): Response | undefined {
    const r = parseTermQuery(u.searchParams)
    if ("error" in r) return fail(400, r.error)
    const t: TermSession = { key: randomBytes(16).toString("hex"), req: r, ws: null, helper: null, out: [], pid: null, done: false, timer: null }
    const offered = termProtocols(req.headers.get("sec-websocket-protocol")).offered
    if (!srv.upgrade(req, { data: t, ...(offered ? { headers: { "Sec-WebSocket-Protocol": TERM_PROTOCOL } } : {}) })) {
      return fail(400, "expected a WebSocket upgrade")
    }
    return undefined
  }

  readonly websocket: WebSocketHandler<TermSession> = {
    open: (ws) => {
      const t = ws.data
      t.ws = ws
      this.sessions.set(t.key, t)
      this.start(t).catch((error: unknown) => {
        this.finish(t, { type: "error", message: error instanceof Error ? error.message : String(error) })
      })
    },
    message: (ws, msg) => {
      if (typeof msg === "string") {
        const c = parseTermControl(msg)
        if (c !== null) this.toHelper(ws.data, termFrame("r", resizePayload(c.cols, c.rows)))
      } else {
        this.toHelper(ws.data, termFrame("i", new Uint8Array(msg)))
      }
    },
    close: (ws) => {
      this.finish(ws.data, null)
    },
    drain: (ws) => {
      ws.data.helper?.resume()
    },
  }

  private async start(t: TermSession): Promise<void> {
    const exe = this.helper ?? [join(import.meta.dir, "conpty.exe")]
    if (this.helper === undefined && !existsSync(exe[0] ?? "")) throw new Error(`${exe[0] ?? "conpty.exe"} is missing: reinstall the agent (winvm agent install)`)
    const sh = termShellArgv(t.req.shell)
    const argv = [
      ...exe,
      ...["--port", String(this.port()), "--key", t.key, "--cols", String(t.req.cols), "--rows", String(t.req.rows)],
      ...(t.req.cwd === null ? [] : ["--cwd", t.req.cwd]),
      "--",
      ...sh.argv,
    ]
    if (sh.note !== null) t.ws?.sendBinary(new TextEncoder().encode(sh.note))
    t.timer = setTimeout(() => {
      this.finish(t, { type: "error", message: "the terminal helper did not start" })
    }, TERM_CONNECT_MS)
    const { pid } = await this.spawner.call<{ pid: number }>({ op: "launch", req: { argv } })
    t.pid = pid
    this.log(`term ${t.req.shell} ${String(t.req.cols)}x${String(t.req.rows)}: helper pid ${String(pid)}`)
    if (t.done) this.kill(t)
  }

  private fromHelper(s: Socket<TermLink>, type: string, payload: Uint8Array): void {
    if (type === "H") {
      const t = this.sessions.get(new TextDecoder().decode(payload))
      if (t === undefined || t.helper !== null) {
        s.end()
        return
      }
      if (t.timer !== null) clearTimeout(t.timer)
      t.helper = s
      s.data.session = t
      this.flush(t)
      return
    }
    const t = s.data.session
    if (t === null || t.done) return
    if (type === "o") {
      // Output faster than the client takes it: stop reading until it drains.
      if (t.ws?.sendBinary(payload) === -1) s.pause()
    } else if (type === "x") {
      this.finish(t, { type: "exit", code: new DataView(payload.buffer, payload.byteOffset, 4).getInt32(0, true) })
    } else if (type === "e") {
      this.finish(t, { type: "error", message: new TextDecoder().decode(payload) })
    }
  }

  private toHelper(t: TermSession, frame: Uint8Array): void {
    if (t.done) return
    t.out.push(frame)
    this.flush(t)
  }

  /** Write what is queued; a partial write leaves the rest for `drain`. */
  private flush(t: TermSession): void {
    const s = t.helper
    if (s === null) return
    while (t.out.length > 0) {
      const f = t.out[0] as Uint8Array
      const n = s.write(f)
      if (n < f.length) {
        t.out[0] = f.subarray(Math.max(n, 0))
        return
      }
      t.out.shift()
    }
  }

  /** The end of a session, once: tell the client why (null: it left), and close both ends. */
  private finish(t: TermSession, ev: TermEvent | null): void {
    if (t.done) return
    t.done = true
    if (t.timer !== null) clearTimeout(t.timer)
    this.sessions.delete(t.key)
    this.log(`term ${ev === null ? "closed by the client" : ev.type === "exit" ? `exit ${String(ev.code)}` : `error: ${ev.message}`}`)
    try {
      if (ev !== null) t.ws?.send(JSON.stringify(ev))
      t.ws?.close(ev === null || ev.type === "exit" ? 1000 : 1011)
    } catch {
      // already closed
    }
    // conpty.exe ends the shell's tree when its connection ends.
    if (t.helper !== null) t.helper.end()
    else this.kill(t)
  }

  /** A helper that has not connected: stop it by pid. */
  private kill(t: TermSession): void {
    if (t.pid !== null && t.helper === null) this.spawner.call({ op: "kill", pid: t.pid, tree: true }).catch(() => undefined)
  }

  stop(): void {
    for (const t of [...this.sessions.values()]) this.finish(t, { type: "error", message: "the agent is stopping" })
    this.listener?.stop(true)
  }
}

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

  const terms = new Terminals(spawner, o.termHelper, log)

  let server: Server<TermSession>
  try {
    server = Bun.serve<TermSession>({
      port: o.port,
      hostname: o.hostname,
      maxRequestBodySize: 8 * 1024 ** 3,
      idleTimeout: 0,
      websocket: terms.websocket,
      async fetch(req, srv) {
        const from = srv.requestIP(req)?.address ?? null
        if (o.allowFrom !== null && (from === null || !o.allowFrom.includes(from.replace(/^::ffff:/, "")))) {
          return fail(403, "forbidden")
        }
        const u = new URL(req.url)
        const want = token()
        const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "")
        // A browser's WebSocket cannot send headers: a terminal may name the token as a subprotocol.
        const got = bearer === "" && u.pathname === "/term" ? (termProtocols(req.headers.get("sec-websocket-protocol")).token ?? "") : bearer
        if (want === null || !sameSecret(got, want)) return fail(401, "unauthorized")

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
            case "GET /fs/list": {
              const places = knownFolders()
              const asked = u.searchParams.get("path") ?? ""
              const start = places.find((p) => p.kind === "desktop") ?? places.find((p) => p.kind === "home")
              const path = normalizeDir(asked !== "" ? asked : (start?.path ?? homedir()))
              const limit = Number(u.searchParams.get("limit") ?? LIST_LIMIT)
              // Asked for alongside readdir; failing only means nothing is marked hidden.
              const hidden = (isWin ? spawner.call<string[]>({ op: "hidden", path }) : Promise.resolve([]))
                .then((names) => new Set(names))
                .catch(() => new Set<string>())
              const withHidden = u.searchParams.get("hidden") === "1"
              const listing = await listDir(path, { withHidden, limit: Number.isFinite(limit) ? limit : LIST_LIMIT, hidden })
              return json({ ...listing, places } satisfies DirListing)
            }
            case "POST /fs/mkdir": {
              const r = (await req.json()) as { path?: unknown }
              return json({ path: await makeFolder(r.path) } satisfies FsPathResult)
            }
            case "POST /fs/rename": {
              const r = (await req.json()) as { from?: unknown; to?: unknown }
              const path = await movePath(r.from, r.to)
              log(`rename ${String(r.from)} -> ${path}`)
              return json({ path } satisfies FsPathResult)
            }
            case "POST /fs/copy": {
              const r = (await req.json()) as { from?: unknown; to?: unknown }
              return json({ path: await copyPath(r.from, r.to) } satisfies FsPathResult)
            }
            case "POST /fs/delete": {
              const r = (await req.json()) as { paths?: unknown; recycle?: unknown }
              const recycle = r.recycle !== false
              const pwsh = async (script: string): Promise<PwshResponse> => await spawner.call<PwshResponse>({ op: "pwsh", script, timeoutMs: 600_000 })
              const deleted = await removePaths(r.paths, { recycle, pwsh })
              log(`delete ${JSON.stringify(r.paths)} ${recycle ? "to the Recycle Bin" : "for good"}`)
              return json({ deleted } satisfies FsDeleteResult)
            }
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
              const status = { notfound: 404, timeout: 408, bad: 400, covered: 409, unavailable: 501 }[out.code] ?? 500
              return json({ error: out.error, code: out.code }, status)
            }
            case "GET /term":
              return terms.upgrade(req, srv, u)
            case "POST /display": {
              const r = (await req.json()) as DisplayRequest
              const args = displayArgv(r)
              if (args === null) return fail(400, "op must be get, modes, set {width,height,waitMs?,scale?} or scale {scale}")
              if (!isWin) return fail(501, "the display helper exists only in the Windows guest")
              const exe = displayExe()
              if (!existsSync(exe)) return fail(501, `${exe} is missing: reinstall the agent (winvm agent install)`)
              const timeoutMs = (r.waitMs ?? 2000) + 15_000
              const { line } = await spawner.call<{ line: string }>({ op: "display", args, timeoutMs })
              let body: Record<string, unknown>
              try {
                body = JSON.parse(line) as Record<string, unknown>
              } catch {
                return fail(500, `winvm-display.exe said: ${line}`)
              }
              if (body["error"] === undefined) return json(body)
              const status = { bad: 400, badmode: 409, toobig: 413, timeout: 408 }[String(body["code"])] ?? 500
              return json(body, status)
            }
            case "GET /stats":
              return json(await guestStats())
            case "POST /smb/setup": {
              const r = (await req.json()) as Partial<Record<keyof SmbSetupRequest, unknown>>
              const bad = smbSetupError(r)
              if (bad !== null) return fail(400, bad)
              if (!isWin) return fail(501, "file sharing is set up only in the Windows guest")
              const script = smbSetupScript(r as SmbSetupRequest)
              const out = await spawner.call<PwshResponse>({ op: "pwsh", script, timeoutMs: 120_000 })
              // Never the request: it holds the password.
              log(`smb setup for ${String(r.user)}: exit ${String(out.code)}`)
              return json(out)
            }
            case "POST /exit":
              log("exit requested")
              setTimeout(() => process.exit(0), 50)
              return json({ ok: true })
            default:
              return fail(404, `no route ${req.method} ${u.pathname}`)
          }
        } catch (error) {
          if (error instanceof FsError) return json({ error: error.message, code: error.code }, error.status)
          return fail(500, error instanceof Error ? error.message : String(error))
        }
      },
    })
  } catch (error) {
    stopping = true
    spawner.stop()
    terms.stop()
    throw error
  }
  log(`listening ${o.hostname}:${String(server.port)} pid ${String(process.pid)} ${process.arch} bun ${Bun.version}`)
  return {
    port: server.port ?? o.port,
    stop: () => {
      stopping = true
      terms.stop()
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
