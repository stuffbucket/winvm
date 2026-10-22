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

import type { Paths } from "./paths"
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
      let h: number
      try {
        h = await open(guestPath, "rb")
      } catch {
        return null
      }
      const parts: Buffer[] = []
      try {
        for (;;) {
          const r = ret(await qga.call(sock, { execute: "guest-file-read", arguments: { handle: h, count: CHUNK } }, 120_000), "read") as {
            "buf-b64": string
            count: number
            eof: boolean
          }
          parts.push(Buffer.from(r["buf-b64"], "base64"))
          if (r.eof || r.count === 0) break
        }
      } finally {
        await close(h)
      }
      return new Uint8Array(Buffer.concat(parts))
    },
  }
  return g
}

/** The channel for an instance. The in-guest agent, when present, replaces qga here. */
export function guestFor(p: Paths): Guest {
  return qgaGuest(p)
}
