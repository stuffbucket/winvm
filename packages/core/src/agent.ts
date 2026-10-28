/**
 * The host side of the in-guest agent (guestagent.ts): its client, `connect`,
 * and `install` into a running guest over qemu-ga. The per-instance state and
 * the port forward it is reached through live in agentfwd.ts.
 *
 *   const c = await agent.ensure(name)         // connect, else adopt, else install
 *   const c = await agent.connect(name)        // null: no agent answering
 *   const c = await agent.install(name)        // (re)install, start, connect
 *   await c.exec([...]); await c.pwsh("..."); await c.putFile(host, guest)
 *   await c.getFile(guest, host); await c.launch([exe]); await c.kill(pid)
 *   await c.list(dir); await c.mkdir(dir); await c.rename(a, b); await c.copy(a, b); await c.remove([a])
 *
 * The token is generated once per instance and kept: a guest restored from a
 * save still holds the token it had, and the guest agent re-reads its token
 * file, so writing it again over qemu-ga is all a rewrite ever needs.
 */
import { randomBytes } from "node:crypto"
import { createWriteStream, readFileSync } from "node:fs"
import { once } from "node:events"
import { resolve } from "node:path"

import type { AgentState } from "./agentfwd"
import { ensureForward, ensureState, readState, restoreForward } from "./agentfwd"
import type {
  DirListing,
  DisplayRequest,
  ExecRequest,
  ExecResponse,
  FsDeleteResult,
  FsPathResult,
  Health,
  LaunchRequest,
  Proc,
  PwshResponse,
} from "./guestagent"
import { AGENT_VERSION, GUEST_PORT, WINDOWS_DIR } from "./guestagent"
import { bunZip } from "./media"
import { PACKAGE_DIR, pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"

export type { AgentState } from "./agentfwd"
export { ensureForward, forwardedPorts, readState, statePath } from "./agentfwd"
export type { DirEntry, DirListing, ExecResponse, FsCode, FsDeleteResult, FsPathResult, Health, Place, Proc, PwshResponse } from "./guestagent"
export { AGENT_VERSION, GUEST_PORT } from "./guestagent"

export class AgentError extends Error {
  readonly status: number
  /** What the agent said went wrong, when it says: an FsCode from a listing or a file operation (notfound, denied, exists…). */
  readonly code: string | null
  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface ExecOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string
  /** Killed (with its whole tree) after this long; default 10 minutes. */
  readonly timeoutMs?: number
  readonly verbatim?: boolean
}

export interface LaunchOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

type Body = string | Uint8Array | Blob | ReadableStream<Uint8Array>

/** A connection to one guest's agent. Every call is one HTTP request. */
export class AgentClient {
  readonly base: string
  private readonly token: string
  constructor(base: string, token: string) {
    this.base = base
    this.token = token
  }

  private async req(method: string, path: string, body?: RequestInit["body"], timeoutMs = 30_000): Promise<Response> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}` },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
      // The signal is the deadline. Bun's fetch also drops a connection idle
      // for 5 minutes (BUN_CONFIG_HTTP_IDLE_TIMEOUT), and /exec and /pwsh send
      // nothing until the command ends, so without this every guest command
      // longer than 300 s failed with "The operation timed out" and its output
      // was lost, whatever timeoutMs said (measured, Bun 1.3.14).
      timeout: false,
    })
    if (!r.ok) {
      const text = await r.text()
      let msg = text
      let code: string | null = null
      try {
        const body = JSON.parse(text) as { error?: string; code?: string }
        msg = body.error ?? text
        code = body.code ?? null
      } catch {
        // not JSON
      }
      throw new AgentError(`agent ${method} ${path.split("?")[0] ?? path}: ${String(r.status)} ${msg}`, r.status, code)
    }
    return r
  }

  private async post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    return (await (await this.req("POST", path, JSON.stringify(body), timeoutMs)).json()) as T
  }

  async health(timeoutMs = 5000): Promise<Health> {
    return (await (await this.req("GET", "/health", undefined, timeoutMs)).json()) as Health
  }

  /** Run a program (no shell) and wait for it. Exit code, stdout and stderr as text. */
  async exec(argv: readonly string[], o: ExecOptions = {}): Promise<ExecResponse> {
    const timeoutMs = o.timeoutMs ?? 600_000
    const body: ExecRequest = { argv, ...o, timeoutMs }
    // The HTTP deadline outlives the guest-side one, so a timeout comes back as a result.
    return await this.post<ExecResponse>("/exec", body, timeoutMs + 30_000)
  }

  /** A script in the agent's warm Windows PowerShell; output merges both streams. */
  async pwsh(script: string, o: { readonly timeoutMs?: number } = {}): Promise<PwshResponse> {
    const timeoutMs = o.timeoutMs ?? 600_000
    return await this.post<PwshResponse>("/pwsh", { script, timeoutMs }, timeoutMs + 30_000)
  }

  /** Write `data` to a guest file, creating its directory. */
  async put(guestPath: string, data: Body, timeoutMs = 600_000): Promise<{ readonly bytes: number; readonly ms: number }> {
    const r = await this.req("PUT", `/file?path=${encodeURIComponent(guestPath)}`, data as RequestInit["body"], timeoutMs)
    return (await r.json()) as { bytes: number; ms: number }
  }

  async putFile(hostPath: string, guestPath: string): Promise<{ readonly bytes: number; readonly ms: number }> {
    return await this.put(guestPath, Bun.file(hostPath))
  }

  /** A guest file's bytes. Throws AgentError 404 if it is not there. */
  async get(guestPath: string, timeoutMs = 600_000): Promise<Uint8Array> {
    const r = await this.req("GET", `/file?path=${encodeURIComponent(guestPath)}`, undefined, timeoutMs)
    return new Uint8Array(await r.arrayBuffer())
  }

  /** Stream a guest file to a host file; returns the byte count. */
  async getFile(guestPath: string, hostPath: string, timeoutMs = 600_000): Promise<number> {
    const r = await this.req("GET", `/file?path=${encodeURIComponent(guestPath)}`, undefined, timeoutMs)
    // Chunk by chunk, not `Bun.write(hostPath, r)`: that spins at 100% CPU and
    // never finishes on a response arriving through slirp (Bun 1.3.14).
    const out = createWriteStream(hostPath)
    let n = 0
    try {
      for await (const chunk of r.body ?? new ReadableStream<Uint8Array>()) {
        n += chunk.length
        if (!out.write(chunk)) await once(out, "drain")
      }
    } finally {
      out.end()
      await once(out, "close")
    }
    return n
  }

  /** Start a program detached in the logged-on user's session — GUI programs show on the desktop. */
  async launch(argv: readonly string[], o: LaunchOptions = {}): Promise<{ readonly pid: number }> {
    const body: LaunchRequest = { argv, ...o }
    return await this.post<{ pid: number }>("/launch", body)
  }

  /**
   * A guest folder's entries, folders first, and the known folders (Desktop,
   * Documents, Downloads, the profile, C:\work, the drives). No path: the
   * Desktop. Hidden and system entries only with `hidden`. Throws AgentError
   * with code notfound (404), denied (403) or notdir (400).
   */
  async list(guestPath = "", o: { readonly hidden?: boolean; readonly limit?: number } = {}): Promise<DirListing> {
    const q = new URLSearchParams({ path: guestPath })
    if (o.hidden === true) q.set("hidden", "1")
    if (o.limit !== undefined) q.set("limit", String(o.limit))
    return (await (await this.req("GET", `/fs/list?${q.toString()}`)).json()) as DirListing
  }

  /** A new folder; its parent must exist. Throws AgentError with an FsCode (exists, notfound, notdir…). */
  async mkdir(guestPath: string): Promise<FsPathResult> {
    return await this.post<FsPathResult>("/fs/mkdir", { path: guestPath })
  }

  /**
   * Rename or move to `to`, a full path. Never replaces anything (code exists),
   * but a change of case alone renames. Onto another drive it copies, so it
   * may take a while.
   */
  async rename(from: string, to: string, timeoutMs = 600_000): Promise<FsPathResult> {
    return await this.post<FsPathResult>("/fs/rename", { from, to }, timeoutMs)
  }

  /** Copy a file, or a folder and all in it, to `to`, a full path. Never replaces anything (code exists). */
  async copy(from: string, to: string, timeoutMs = 600_000): Promise<FsPathResult> {
    return await this.post<FsPathResult>("/fs/copy", { from, to }, timeoutMs)
  }

  /**
   * Delete files and folders: to the Recycle Bin unless `recycle` is false,
   * then for good. A missing path deletes nothing (code notfound); with no
   * Recycle Bin (not Windows) the code is unavailable.
   */
  async remove(paths: readonly string[], o: { readonly recycle?: boolean } = {}): Promise<FsDeleteResult> {
    return await this.post<FsDeleteResult>("/fs/delete", { paths, recycle: o.recycle ?? true }, 630_000)
  }

  async procs(): Promise<readonly Proc[]> {
    return (await (await this.req("GET", "/procs")).json()) as Proc[]
  }

  /** Kill a process; by default its whole tree. */
  async kill(pid: number, o: { readonly tree?: boolean } = {}): Promise<void> {
    await this.post("/kill", { pid, tree: o.tree ?? true })
  }

  /**
   * One UI Automation request (`op` plus fields) to the guest's winvm-ui helper;
   * ui.ts wraps it. Throws AgentError: 404 not found, 408 timed out, 400 bad request.
   */
  async ui<T>(req: { readonly op: string } & Readonly<Record<string, unknown>>, timeoutMs = 30_000): Promise<T> {
    return await this.post<T>("/ui", req, timeoutMs)
  }

  /**
   * The guest's screen size and display scaling, through winvm-display.exe
   * (guestdisplay.ts wraps it). Throws AgentError: 408 the size never became a
   * mode, 409 the driver refused it, 413 too big for the driver, 400 bad request.
   */
  async display<T>(req: DisplayRequest, timeoutMs?: number): Promise<T> {
    return await this.post<T>("/display", req, timeoutMs ?? (req.waitMs ?? 2000) + 20_000)
  }

  /** Ask the agent to exit (the Run key starts it again at the next logon). */
  async exit(): Promise<void> {
    await this.post("/exit", {})
  }
}

/**
 * The agent of a running instance, or null when it has none (never installed,
 * not running, not answering within `timeoutMs`). Adds the forward if needed.
 */
export async function connect(name: string, o: { readonly timeoutMs?: number } = {}): Promise<AgentClient | null> {
  const p = pathsFor(name)
  if (readState(p) === null || !qemu.isRunning(p)) return null
  const deadline = Date.now() + (o.timeoutMs ?? 2000)
  let client: AgentClient
  try {
    client = clientFor({ ...ensureState(p), hostPort: await ensureForward(p) })
  } catch {
    return null
  }
  for (;;) {
    try {
      await client.health(Math.max(500, Math.min(3000, deadline - Date.now())))
      return client
    } catch (error) {
      if (error instanceof AgentError && error.status === 401) return null
      if (Date.now() >= deadline) return null
      await Bun.sleep(200)
    }
  }
}

/** Like `connect`, but throws with a hint when there is no agent. */
export async function requireAgent(name: string, timeoutMs = 2000): Promise<AgentClient> {
  const c = await connect(name, { timeoutMs })
  if (c === null) throw new Error(`instance "${name}" has no agent answering — \`winvm agent install -i ${name}\``)
  return c
}

/**
 * Put the forward back after something started a new QEMU process. qemu.launch
 * already does this; exported for callers that want to be explicit. Never throws.
 */
export async function reattach(name: string): Promise<void> {
  const p = pathsFor(name)
  if (qemu.isRunning(p)) await restoreForward(p)
}

export const clientFor = (s: AgentState & { readonly hostPort: number }): AgentClient =>
  new AgentClient(`http://127.0.0.1:${String(s.hostPort)}`, s.token)

// --- install ----------------------------------------------------------------

const ASSETS = resolve(PACKAGE_DIR, "assets")
const STAGE_DIR = "C:\\ProgramData\\winvm\\stage"
const CMD = "C:\\Windows\\System32\\cmd.exe"
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
/** Where the session launcher lands; usable over qemu-ga once the agent is installed. */
export const RUNINSESSION = `${WINDOWS_DIR}\\runinsession.exe`

/** Write a guest file over qemu-ga: slow (base64 over a serial channel), so for small files. */
export async function qgaWriteFile(sock: string, guestPath: string, data: Uint8Array): Promise<void> {
  const open = await qga.call(sock, { execute: "guest-file-open", arguments: { path: guestPath, mode: "wb" } })
  const handle = open["return"]
  if (typeof handle !== "number") throw new Error(`guest-file-open ${guestPath}: ${JSON.stringify(open)}`)
  try {
    const CHUNK = 256 * 1024
    for (let off = 0; off < data.length || off === 0; off += CHUNK) {
      const part = data.subarray(off, off + CHUNK)
      const r = await qga.call(sock, { execute: "guest-file-write", arguments: { handle, "buf-b64": Buffer.from(part).toString("base64") } })
      if (r["error"] !== undefined) throw new Error(`guest-file-write ${guestPath}: ${JSON.stringify(r["error"])}`)
      if (data.length === 0) break
    }
  } finally {
    await qga.call(sock, { execute: "guest-file-close", arguments: { handle } })
  }
}

/**
 * Serve one file to the guest at http://10.0.2.2:<port>/<secret>/<name> — slirp
 * maps 10.0.2.2 to the host's loopback — for as long as `fn` runs.
 */
async function serveToGuest<T>(file: string, fn: (url: string) => Promise<T>): Promise<T> {
  const secret = randomBytes(16).toString("hex")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => (new URL(req.url).pathname === `/${secret}/file` ? new Response(Bun.file(file)) : new Response("no", { status: 404 })),
  })
  try {
    return await fn(`http://10.0.2.2:${String(server.port)}/${secret}/file`)
  } finally {
    void server.stop(true)
  }
}

export interface InstallOptions {
  readonly log?: (line: string) => void
  /** How long to wait for the freshly started agent to answer. */
  readonly timeoutMs?: number
}

/**
 * Install (or reinstall) the agent into a running guest over qemu-ga, start it
 * in the logged-on session, forward a host port to it, and return a client.
 */
export async function install(name: string, o: InstallOptions = {}): Promise<AgentClient> {
  const log = o.log ?? ((): void => {})
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) throw new Error(`instance "${name}" is not running`)
  const s = ensureState(p)
  const t0 = performance.now()
  // A FOLDER OF ITS OWN PER ATTEMPT. When a qemu-ga call times out on the host,
  // qemu-ga can still carry it out: a guest-file-open the host gave up on leaves
  // that file open in the guest, with a handle the host never learned, and every
  // later open of the same path fails ("being used by another process"). So a
  // retried install, writing the same paths, could never succeed. What earlier
  // attempts left is cleared first, as far as nothing holds it.
  const stage = `${STAGE_DIR}\\${randomBytes(4).toString("hex")}`
  const mk = await qga.exec(p.qga, CMD, ["/d", "/c", `rmdir /s /q ${STAGE_DIR} 2>nul & mkdir ${stage} 2>nul & mkdir ${WINDOWS_DIR} 2>nul & exit 0`])
  if (mk.exitcode !== 0) throw new Error(`could not create the agent's directories: ${mk.stderr}`)
  for (const [from, to] of [
    [resolve(PACKAGE_DIR, "src", "guestagent.ts"), `${stage}\\guestagent.ts`],
    [resolve(ASSETS, "agent-install.ps1"), `${stage}\\agent-install.ps1`],
    [resolve(ASSETS, "runinsession.cs"), `${stage}\\runinsession.cs`],
    [resolve(ASSETS, "winvm-ui.cs"), `${stage}\\winvm-ui.cs`],
    [resolve(ASSETS, "conpty.cs"), `${stage}\\conpty.cs`],
    [resolve(ASSETS, "winvm-display.cs"), `${stage}\\winvm-display.cs`],
  ] as const) {
    await qgaWriteFile(p.qga, to, new Uint8Array(readFileSync(from)))
  }
  await qgaWriteFile(p.qga, `${WINDOWS_DIR}\\token`, new TextEncoder().encode(s.token))
  log(`staged in ${(performance.now() - t0).toFixed(0)} ms`)

  const script = async (extra: readonly string[]): Promise<qga.ExecResult> =>
    await qga.exec(p.qga, POWERSHELL, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      `${stage}\\agent-install.ps1`,
      "-Source",
      stage,
      "-Port",
      String(GUEST_PORT),
      ...extra,
    ])
  let r = await script([])
  if (r.exitcode === 3) {
    log("no bun in the guest; serving one from the host")
    r = await serveToGuest(bunZip(), async (url) => await script(["-BunUrl", url]))
  }
  for (const line of `${r.stdout}${r.stderr}`.split(/\r?\n/)) if (line.trim() !== "") log(`  guest: ${line.trimEnd()}`)
  if (r.exitcode !== 0) throw new Error(`agent install failed in the guest (exit ${String(r.exitcode)})`)
  log(`installed in ${(performance.now() - t0).toFixed(0)} ms`)

  const port = await ensureForward(p)
  const client = clientFor({ ...s, hostPort: port })
  const deadline = Date.now() + (o.timeoutMs ?? 30_000)
  for (;;) {
    try {
      const h = await client.health(2000)
      if (h.version !== AGENT_VERSION) throw new Error(`agent reports version ${String(h.version)}, expected ${String(AGENT_VERSION)}`)
      log(`agent up: pid ${String(h.pid)}, ${h.arch}, session ${String(h.session)}, 127.0.0.1:${String(port)} (${(performance.now() - t0).toFixed(0)} ms)`)
      return client
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`the agent did not answer after install: ${error instanceof Error ? error.message : String(error)}`)
      await Bun.sleep(250)
    }
  }
}

/**
 * The one call a harness needs: a working agent for a running instance, by the
 * cheapest route that works.
 *
 *   1. already answering with this version             ~ms
 *   2. present in the guest but holding another token  ~100 ms: write ours over
 *      qemu-ga (an image with the agent baked in, or a guest restored from a
 *      save another instance took), add the forward, and wait for it to answer
 *      — up to `waitMs`, for one still starting at logon
 *   3. otherwise a full install                         ~7 s
 */
export async function ensure(name: string, o: InstallOptions & { readonly waitMs?: number } = {}): Promise<AgentClient> {
  // An instance that has had an agent most likely still has one that is just
  // starting: right after `start` returns the Run key has fired but the agent
  // takes a few seconds to listen. Waiting is far cheaper than reinstalling.
  const c = await connect(name, { timeoutMs: readState(pathsFor(name)) === null ? 2000 : (o.waitMs ?? 15_000) })
  if (c !== null && (await c.health()).version === AGENT_VERSION) return c
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) throw new Error(`instance "${name}" is not running`)
  if (c === null) {
    try {
      const s = ensureState(p)
      await qgaWriteFile(p.qga, `${WINDOWS_DIR}\\token`, new TextEncoder().encode(s.token))
      const client = clientFor({ ...s, hostPort: await ensureForward(p) })
      // The token landed, so the agent's directory exists: an image with the
      // agent baked in, or an earlier install. Its Run key fires at logon, so
      // right after a cold start it may still be seconds from listening — and
      // waiting is far cheaper than reinstalling.
      const deadline = Date.now() + (o.waitMs ?? 15_000)
      for (;;) {
        const h = await client.health(1000).catch(() => null)
        if (h !== null && h.version === AGENT_VERSION) return client
        if (h !== null || Date.now() >= deadline) break
        await Bun.sleep(100)
      }
    } catch {
      // not there (no directory to write the token into): install
    }
  }
  return await install(name, o)
}

/**
 * Start a program on the logged-on desktop over qemu-ga, for when the agent is
 * not answering — through the session launcher the install left behind.
 */
export async function qgaLaunch(name: string, argv: readonly string[]): Promise<qga.ExecResult> {
  return await qga.exec(pathsFor(name).qga, RUNINSESSION, argv)
}
