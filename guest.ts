/**
 * The channel a job runs over: run a program, move a file, start something
 * detached, kill it. One small interface so the runner does not care whether
 * it is talking to qemu-ga (always there, runs as SYSTEM in session 0) or the
 * in-guest HTTP agent (faster, runs in the logged-on user's session).
 *
 * qgaGuest is the fallback and today's default. Swapping the runner to the
 * agent is one line in `guestFor`.
 */
import { readFileSync } from "node:fs"

import type { AgentClient } from "./agent"
import { AgentError, connect } from "./agent"
import type { Paths } from "./paths"
import { pathsFor } from "./paths"
import * as qga from "./qga"

export interface RunResult {
  readonly exitcode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface Guest {
  /** What it is, for the report: "qga" or "agent". */
  readonly kind: string
  /** Whose session a step runs in, for the report. */
  readonly session: "system" | "user"
  /** True when `putFile` is fast enough for installers (otherwise stage over HTTP). */
  readonly fastFiles: boolean
  run(argv: readonly string[], timeoutMs: number): Promise<RunResult>
  /** Start a program and do not wait for it. Its output goes nowhere. */
  launch(argv: readonly string[]): Promise<number>
  kill(pid: number): Promise<void>
  put(guestPath: string, data: Uint8Array | string): Promise<void>
  putFile(hostPath: string, guestPath: string): Promise<void>
  /** A guest file's bytes, or null when it is not there. */
  get(guestPath: string): Promise<Uint8Array | null>
}

const CMD = "C:\\Windows\\System32\\cmd.exe"
const CHUNK = 1024 * 1024
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The QEMU guest agent. Runs everything as NT AUTHORITY\SYSTEM in session 0. */
export function qgaGuest(p: Paths): Guest {
  const sock = p.qga
  const ret = (r: Record<string, unknown>, what: string): unknown => {
    if (r["error"] !== undefined) throw new Error(`${what}: ${JSON.stringify(r["error"])}`)
    return r["return"]
  }
  const open = async (path: string, mode: string): Promise<number> =>
    ret(await qga.call(sock, { execute: "guest-file-open", arguments: { path, mode } }), `open ${path}`) as number
  const close = async (handle: number): Promise<void> => {
    await qga.call(sock, { execute: "guest-file-close", arguments: { handle } })
  }
  const g: Guest = {
    kind: "qga",
    session: "system",
    fastFiles: false,
    async run(argv, timeoutMs) {
      const [path, ...arg] = argv
      if (path === undefined) throw new Error("empty argv")
      const started = ret(
        await qga.call(sock, { execute: "guest-exec", arguments: { path, arg, "capture-output": true } }),
        "guest-exec",
      ) as { pid: number }
      const deadline = Date.now() + timeoutMs
      let pollMs = 25
      for (;;) {
        const st = ret(await qga.call(sock, { execute: "guest-exec-status", arguments: { pid: started.pid } }), "guest-exec-status") as {
          exited?: boolean
          exitcode?: number
          "out-data"?: string
          "err-data"?: string
        }
        const dec = (s: string | undefined): string => (s === undefined ? "" : Buffer.from(s, "base64").toString("utf8"))
        if (st.exited === true) {
          return { exitcode: st.exitcode ?? 0, stdout: dec(st["out-data"]), stderr: dec(st["err-data"]), timedOut: false }
        }
        if (Date.now() > deadline) {
          await g.kill(started.pid)
          return { exitcode: -1, stdout: dec(st["out-data"]), stderr: dec(st["err-data"]), timedOut: true }
        }
        await sleep(pollMs)
        pollMs = Math.min(pollMs * 2, 500)
      }
    },
    async launch(argv) {
      const [path, ...arg] = argv
      if (path === undefined) throw new Error("empty argv")
      // No capture: qga would otherwise hold pipes the child inherits.
      const r = ret(await qga.call(sock, { execute: "guest-exec", arguments: { path, arg, "capture-output": false } }), "guest-exec") as {
        pid: number
      }
      return r.pid
    },
    async kill(pid) {
      await qga.exec(sock, CMD, ["/c", `taskkill /pid ${String(pid)} /t /f >nul 2>&1`]).catch(() => undefined)
    },
    async put(guestPath, data) {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
      const h = await open(guestPath, "wb")
      try {
        for (let off = 0; off < bytes.length; off += CHUNK) {
          ret(
            await qga.call(
              sock,
              { execute: "guest-file-write", arguments: { handle: h, "buf-b64": bytes.subarray(off, off + CHUNK).toString("base64") } },
              120_000,
            ),
            `write ${guestPath}`,
          )
        }
      } finally {
        await close(h)
      }
    },
    async putFile(hostPath, guestPath) {
      await g.put(guestPath, readFileSync(hostPath))
    },
    async get(guestPath) {
      // Chunked to fit what the agent can answer — see qga.READ_CHUNK.
      const bytes = await qga.readFile(sock, guestPath)
      return bytes === null ? null : new Uint8Array(bytes)
    },
  }
  return g
}

/**
 * The in-guest agent (agent.ts): runs in the logged-on user's session, so
 * %LOCALAPPDATA% and HKCU are that user's and a launched GUI program is on the
 * desktop. Exec is ~10 ms rather than qemu-ga's ~80, and files move over HTTP.
 */
export function agentGuest(client: AgentClient): Guest {
  return {
    kind: "agent",
    session: "user",
    fastFiles: true,
    async run(argv, timeoutMs) {
      // cmd.exe parses its own command line and does not understand the
      // MSVCRT quoting Bun would add; hand it the words as written.
      const verbatim = /\\cmd\.exe$/i.test(argv[0] ?? "")
      const r = await client.exec(argv, { timeoutMs, verbatim })
      return { exitcode: r.timedOut ? -1 : r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
    },
    async launch(argv) {
      return (await client.launch(argv)).pid
    },
    async kill(pid) {
      await client.kill(pid).catch(() => undefined)
    },
    async put(guestPath, data) {
      await client.put(guestPath, typeof data === "string" ? new TextEncoder().encode(data) : data)
    },
    async putFile(hostPath, guestPath) {
      await client.putFile(hostPath, guestPath)
    },
    async get(guestPath) {
      try {
        return await client.get(guestPath)
      } catch (error) {
        if (error instanceof AgentError && error.status === 404) return null
        throw error
      }
    },
  }
}

/**
 * The channel for an instance: its agent when one answers, else qemu-ga.
 * WINVM_CHANNEL=qga forces the fallback (to compare, or to run as SYSTEM).
 */
export async function guestFor(instance: string): Promise<Guest> {
  const p = pathsFor(instance)
  if (process.env["WINVM_CHANNEL"] !== "qga") {
    const client = await connect(instance, { timeoutMs: 5000 })
    if (client !== null) return agentGuest(client)
  }
  return qgaGuest(p)
}
