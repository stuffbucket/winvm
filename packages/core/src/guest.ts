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
  readonly kind: string
  readonly session: "system" | "user"
  readonly fastFiles: boolean
  run(argv: readonly string[], timeoutMs: number): Promise<RunResult>
  launch(argv: readonly string[]): Promise<number>
  kill(pid: number): Promise<void>
  put(guestPath: string, data: Uint8Array | string): Promise<void>
  putFile(hostPath: string, guestPath: string): Promise<void>
  get(guestPath: string): Promise<Uint8Array | null>
}

const CMD = "C:\\Windows\\System32\\cmd.exe"
const CHUNK = 1024 * 1024
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

export function qgaGuest(p: Paths): Guest {
  const sock = p.qga
  const ret = (r: Record<string, unknown>, what: string): unknown => {
    if (r.error !== undefined)
      throw new Error(`${what}: ${JSON.stringify(r.error)}`)
    return r.return
  }
  const open = async (path: string, mode: string): Promise<number> =>
    ret(
      await qga.call(sock, {
        execute: "guest-file-open",
        arguments: { path, mode },
      }),
      `open ${path}`,
    ) as number
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
        await qga.call(sock, {
          execute: "guest-exec",
          arguments: { path, arg, "capture-output": true },
        }),
        "guest-exec",
      ) as { pid: number }
      const deadline = Date.now() + timeoutMs
      let pollMs = 25
      for (;;) {
        const st = ret(
          await qga.call(sock, {
            execute: "guest-exec-status",
            arguments: { pid: started.pid },
          }),
          "guest-exec-status",
        ) as {
          exited?: boolean
          exitcode?: number
          "out-data"?: string
          "err-data"?: string
        }
        const dec = (s: string | undefined): string =>
          s === undefined ? "" : Buffer.from(s, "base64").toString("utf8")
        if (st.exited === true) {
          return {
            exitcode: st.exitcode ?? 0,
            stdout: dec(st["out-data"]),
            stderr: dec(st["err-data"]),
            timedOut: false,
          }
        }
        if (Date.now() > deadline) {
          await g.kill(started.pid)
          return {
            exitcode: -1,
            stdout: dec(st["out-data"]),
            stderr: dec(st["err-data"]),
            timedOut: true,
          }
        }
        await sleep(pollMs)
        pollMs = Math.min(pollMs * 2, 500)
      }
    },
    async launch(argv) {
      const [path, ...arg] = argv
      if (path === undefined) throw new Error("empty argv")
      const r = ret(
        await qga.call(sock, {
          execute: "guest-exec",
          arguments: { path, arg, "capture-output": false },
        }),
        "guest-exec",
      ) as {
        pid: number
      }
      return r.pid
    },
    async kill(pid) {
      await qga
        .exec(sock, CMD, ["/c", `taskkill /pid ${String(pid)} /t /f >nul 2>&1`])
        .catch(() => undefined)
    },
    async put(guestPath, data) {
      const bytes =
        typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
      const h = await open(guestPath, "wb")
      try {
        for (let off = 0; off < bytes.length; off += CHUNK) {
          ret(
            await qga.call(
              sock,
              {
                execute: "guest-file-write",
                arguments: {
                  handle: h,
                  "buf-b64": bytes
                    .subarray(off, off + CHUNK)
                    .toString("base64"),
                },
              },
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
      const bytes = await qga.readFile(sock, guestPath)
      return bytes === null ? null : new Uint8Array(bytes)
    },
  }
  return g
}

export function agentGuest(client: AgentClient): Guest {
  return {
    kind: "agent",
    session: "user",
    fastFiles: true,
    async run(argv, timeoutMs) {
      const verbatim = /\\cmd\.exe$/i.test(argv[0] ?? "")
      const r = await client.exec(argv, { timeoutMs, verbatim })
      return {
        exitcode: r.timedOut ? -1 : r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
      }
    },
    async launch(argv) {
      return (await client.launch(argv)).pid
    },
    async kill(pid) {
      await client.kill(pid).catch(() => undefined)
    },
    async put(guestPath, data) {
      await client.put(
        guestPath,
        typeof data === "string" ? new TextEncoder().encode(data) : data,
      )
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

export async function guestFor(instance: string): Promise<Guest> {
  const p = pathsFor(instance)
  if (process.env.WINVM_CHANNEL !== "qga") {
    const client = await connect(instance, { timeoutMs: 5000 })
    if (client !== null) return agentGuest(client)
  }
  return qgaGuest(p)
}
