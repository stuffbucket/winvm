/**
 * The host side of the in-guest agent (guestagent.ts): its client, where it is
 * reached, and the per-instance state that says so.
 *
 * Reached through a QEMU user-net port forward, `127.0.0.1:<hostPort>` on the
 * host to the guest's GUEST_PORT. The forward is added at RUNTIME over the
 * monitor (`hostfwd_add`), never on the command line: a save's compatibility
 * hash (saves.ts) covers the hardware arguments, and a forward there would make
 * every existing save incompatible. The price is that a QEMU started afresh —
 * `start`, a `load` into a new process — has no forward until `reattach` adds
 * it back; a `loadvm` inside a running QEMU keeps it.
 *
 *   <instance>/agent.json   { token, hostPort }   (mode 0600)
 *
 * The token is generated once per instance and kept: a guest restored from a
 * save still holds the token it had, and the guest agent re-reads its token
 * file, so writing it again over qemu-ga is all a rewrite ever needs.
 */
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"

import type { ExecRequest, ExecResponse, Health, LaunchRequest, Proc, PwshResponse } from "./guestagent"
import { GUEST_PORT } from "./guestagent"
import type { Paths } from "./paths"

export type { ExecResponse, Health, Proc, PwshResponse } from "./guestagent"
export { AGENT_VERSION, GUEST_PORT } from "./guestagent"

export class AgentError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
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
    })
    if (!r.ok) {
      const text = await r.text()
      let msg = text
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text
      } catch {
        // not JSON
      }
      throw new AgentError(`agent ${method} ${path.split("?")[0] ?? path}: ${String(r.status)} ${msg}`, r.status)
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
    return await Bun.write(hostPath, r)
  }

  /** Start a program detached in the logged-on user's session — GUI programs show on the desktop. */
  async launch(argv: readonly string[], o: LaunchOptions = {}): Promise<{ readonly pid: number }> {
    const body: LaunchRequest = { argv, ...o }
    return await this.post<{ pid: number }>("/launch", body)
  }

  async procs(): Promise<readonly Proc[]> {
    return (await (await this.req("GET", "/procs")).json()) as Proc[]
  }

  /** Kill a process; by default its whole tree. */
  async kill(pid: number, o: { readonly tree?: boolean } = {}): Promise<void> {
    await this.post("/kill", { pid, tree: o.tree ?? true })
  }

  /** Ask the agent to exit (the Run key starts it again at the next logon). */
  async exit(): Promise<void> {
    await this.post("/exit", {})
  }
}

// --- per-instance state ---------------------------------------------------

export interface AgentState {
  readonly token: string
  /** The host end of the forward, or null before one was ever added. */
  readonly hostPort: number | null
}

export const statePath = (p: Paths): string => resolve(p.dir, "agent.json")

export function readState(p: Paths): AgentState | null {
  const f = statePath(p)
  if (!existsSync(f)) return null
  try {
    const s = JSON.parse(readFileSync(f, "utf8")) as Partial<AgentState>
    if (typeof s.token !== "string" || s.token === "") return null
    return { token: s.token, hostPort: typeof s.hostPort === "number" ? s.hostPort : null }
  } catch {
    return null
  }
}

export function writeState(p: Paths, s: AgentState): void {
  const f = statePath(p)
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
  chmodSync(f, 0o600)
}

/** The instance's state, creating a token the first time. */
export function ensureState(p: Paths): AgentState {
  const s = readState(p)
  if (s !== null) return s
  const fresh: AgentState = { token: randomBytes(32).toString("hex"), hostPort: null }
  writeState(p, fresh)
  return fresh
}

/** A port nothing on the host is listening on right now. */
export async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer()
    srv.once("error", rej)
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address()
      const port = typeof a === "object" && a !== null ? a.port : 0
      srv.close(() => res(port))
    })
  })
}

// --- the port forward -------------------------------------------------------

/** QEMU's id for the user-net backend; see qemu.ts (`-netdev user,id=net0`). */
export const NETDEV = "net0"

export const hostfwdRule = (hostPort: number): string => `tcp:127.0.0.1:${String(hostPort)}-:${String(GUEST_PORT)}`

/** Host ports that `info usernet` shows forwarded to the agent's guest port. */
export function forwardedPorts(usernet: string): readonly number[] {
  const ports: number[] = []
  for (const line of usernet.split(/\r?\n/)) {
    // TCP[HOST_FORWARD]  12       127.0.0.1 47801       10.0.2.15  7801     0     0
    const m = /^\s*TCP\[HOST_FORWARD\]\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s/.exec(line)
    if (m !== null && Number(m[2]) === GUEST_PORT) ports.push(Number(m[1]))
  }
  return ports
}

export const clientFor = (s: AgentState & { readonly hostPort: number }): AgentClient =>
  new AgentClient(`http://127.0.0.1:${String(s.hostPort)}`, s.token)

