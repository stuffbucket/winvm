/**
 * The guest-agent client against a fake agent on a Unix socket — no VM.
 *
 * The fake reproduces the property that matters: the agent answers every
 * request it was sent, and a reply nobody waited for is delivered to whoever
 * connects next.
 */
import { mkdtempSync, rmSync } from "node:fs"
import type { Server, Socket } from "node:net"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { READ_CHUNK, call, readFile, untilNewBoot, untilReady, waitFor } from "../src/qga"

type Handler = (req: Record<string, unknown>) => Record<string, unknown> | null

class FakeAgent {
  /** Replies owed to callers that hung up first; the next connection receives them. */
  owed: Buffer[] = []
  handler: Handler = () => ({ return: {} })
  readonly files = new Map<string, Buffer>()
  /**
   * The largest guest-file-read the agent will answer. Above it the real one
   * sends nothing at all, though its file position still moves on.
   */
  readCeiling = 1_900_000
  readonly reads: number[] = []
  private readonly handles = new Map<number, { data: Buffer; pos: number }>()
  private nextHandle = 1000
  /** Connections accepted so far: what waitFor must not make too early. */
  connections = 0
  readonly path: string
  private readonly server: Server

  constructor(path: string) {
    this.path = path
    this.server = createServer((sock) => {
      this.serve(sock)
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(this.path, r))
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  /** The guest-file-* commands; undefined for anything else, null for "no reply". */
  private file(req: Record<string, unknown>): Record<string, unknown> | null | undefined {
    const a = (req["arguments"] ?? {}) as Record<string, unknown>
    switch (req["execute"]) {
      case "guest-file-open": {
        const data = this.files.get(a["path"] as string)
        if (data === undefined) return { error: { class: "GenericError", desc: "not found" } }
        this.nextHandle += 1
        this.handles.set(this.nextHandle, { data, pos: 0 })
        return { return: this.nextHandle }
      }
      case "guest-file-read": {
        const h = this.handles.get(a["handle"] as number)
        if (h === undefined) return { error: { class: "GenericError", desc: "bad handle" } }
        const count = a["count"] as number
        this.reads.push(count)
        const bytes = h.data.subarray(h.pos, h.pos + count)
        h.pos += bytes.length
        if (count > this.readCeiling) return null
        return { return: { count: bytes.length, "buf-b64": bytes.toString("base64"), eof: h.pos >= h.data.length } }
      }
      case "guest-file-seek": {
        const h = this.handles.get(a["handle"] as number)
        if (h === undefined || a["whence"] !== "set") return { error: { class: "GenericError", desc: "bad seek" } }
        h.pos = a["offset"] as number
        return { return: { position: h.pos, eof: h.pos >= h.data.length } }
      }
      case "guest-file-close":
        this.handles.delete(a["handle"] as number)
        return { return: {} }
      default:
        return undefined
    }
  }

  private serve(sock: Socket): void {
    this.connections += 1
    let open = true
    sock.on("close", () => {
      open = false
    })
    sock.on("error", () => undefined)
    const send = (b: Buffer): void => {
      if (open) sock.write(b)
      else this.owed.push(b)
    }
    for (const b of this.owed.splice(0)) sock.write(b)
    let buf = Buffer.alloc(0)
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        // 0xFF resets the agent's parser, as qemu-ga's does.
        const ff = buf.lastIndexOf(0xff)
        if (ff >= 0) buf = buf.subarray(ff + 1)
        const nl = buf.indexOf(0x0a)
        if (nl < 0) return
        const req = JSON.parse(buf.subarray(0, nl).toString("utf8")) as Record<string, unknown>
        buf = buf.subarray(nl + 1)
        if (req["execute"] === "guest-sync-delimited") {
          const id = (req["arguments"] as { id: number }).id
          send(Buffer.concat([Buffer.from([0xff]), Buffer.from(`${JSON.stringify({ return: id })}\n`)]))
          continue
        }
        const fileReply = this.file(req)
        if (fileReply !== undefined) {
          if (fileReply !== null) send(Buffer.from(`${JSON.stringify(fileReply)}\n`))
          continue
        }
        const reply = this.handler(req)
        if (reply === null) {
          // Slow: answer only after the caller has given up.
          const late = Buffer.from(`${JSON.stringify({ return: `late reply to ${String(req["execute"])}` })}\n`)
          setTimeout(() => {
            send(late)
          }, 150)
          continue
        }
        // Written in pieces, as a large reply arrives over the real channel.
        const bytes = Buffer.from(`${JSON.stringify(reply)}\n`)
        for (let off = 0; off < bytes.length; off += 7) send(bytes.subarray(off, off + 7))
      }
    })
  }
}

let dir: string
let agent: FakeAgent

beforeAll(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "winvm-qga-"))
  agent = new FakeAgent(resolve(dir, "qga.sock"))
  await agent.listen()
})

afterAll(async () => {
  await agent.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("qga.call", () => {
  it("answers a plain request", async () => {
    agent.handler = (req) => ({ return: { echoed: req["execute"] } })
    expect(await call(agent.path, { execute: "guest-ping" })).toEqual({ return: { echoed: "guest-ping" } })
  })

  it("does not hand a timed-out call's reply to the next call", async () => {
    agent.handler = (req) => (req["execute"] === "slow" ? null : { return: "fresh" })
    await expect(call(agent.path, { execute: "slow" }, 50)).rejects.toThrow("guest agent timed out: slow after 0.05 s")
    // Let the late reply land, so the next connection is handed it first.
    await new Promise((r) => setTimeout(r, 250))
    expect(agent.owed.length).toBeGreaterThan(0)
    expect(await call(agent.path, { execute: "guest-ping" })).toEqual({ return: "fresh" })
  })

  it("skips a sync reply that belongs to another caller", async () => {
    agent.handler = () => ({ return: "mine" })
    agent.owed.push(Buffer.concat([Buffer.from([0xff]), Buffer.from('{"return": 12345}\n')]))
    agent.owed.push(Buffer.from('{"return": "someone else\'s"}\n'))
    expect(await call(agent.path, { execute: "guest-ping" })).toEqual({ return: "mine" })
  })
})

describe("qga.readFile", () => {
  const big = Buffer.alloc(6 * 1024 * 1024)
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 7919) % 251

  it("reads a file far larger than one reply, in chunks the agent answers", async () => {
    agent.files.set("C:\\big.bin", big)
    agent.reads.length = 0
    const got = await readFile(agent.path, "C:\\big.bin")
    expect(got?.equals(big)).toBe(true)
    expect(Math.max(...agent.reads)).toBe(READ_CHUNK)
  })

  it("recovers from a chunk the agent never answers, without losing its bytes", async () => {
    agent.files.set("C:\\big.bin", big)
    agent.readCeiling = 300_000
    try {
      const got = await readFile(agent.path, "C:\\big.bin", { chunk: 4 * 1024 * 1024, chunkTimeoutMs: 100 })
      expect(got?.equals(big)).toBe(true)
    } finally {
      agent.readCeiling = 1_900_000
    }
  })

  it("is null for a file that cannot be opened", async () => {
    expect(await readFile(agent.path, "C:\\missing")).toBeNull()
  })
})

describe("qga.waitFor", () => {
  it("does not connect until the guest has opened its port", async () => {
    agent.handler = () => ({ return: {} })
    const before = agent.connections
    let asked = 0
    // QEMU reports the port closed three times, then open.
    const portOpen = async (): Promise<boolean> => {
      asked += 1
      if (asked <= 3) expect(agent.connections).toBe(before)
      return asked > 3
    }
    expect(await waitFor(agent.path, 5000, { portOpen })).toBe(true)
    expect(asked).toBe(4)
    expect(agent.connections).toBe(before + 1)
  })

  it("still tries the agent when QEMU's view is unknown", async () => {
    const before = agent.connections
    expect(await waitFor(agent.path, 5000, { portOpen: async () => null })).toBe(true)
    expect(agent.connections).toBe(before + 1)
  })

  it("gives up at the deadline if the port never opens, without connecting", async () => {
    const before = agent.connections
    expect(await waitFor(agent.path, 600, { portOpen: async () => false })).toBe(false)
    expect(agent.connections).toBe(before)
  })
})

describe("qga.untilReady", () => {
  const fast = { waitFor: async (): Promise<boolean> => true, pollMs: 5, repairAfterMs: 30 }

  it("repairs an interrupted audit-mode logon once, then waits for the logon", async () => {
    let repaired = 0
    const logs: string[] = []
    // No one logged on until the repair's restart; then Administrator.
    const loggedOnUser = async (): Promise<string | null> => (repaired === 0 ? "" : "WINVM\\Administrator")
    const repairAudit = async (): Promise<boolean> => {
      repaired += 1
      return true
    }
    expect(await untilReady("unused", 5000, { ...fast, loggedOnUser, repairAudit, noLogonMs: 2000, log: (l) => logs.push(l) })).toBe("ready")
    expect(repaired).toBe(1)
    expect(logs.join("\n")).toContain("restarted the guest")
  })

  it("gives up with no-logon, not at the timeout, when nothing is there to repair", async () => {
    let checks = 0
    const repairAudit = async (): Promise<boolean> => {
      checks += 1
      return false
    }
    const t0 = Date.now()
    expect(await untilReady("unused", 5000, { ...fast, loggedOnUser: async () => "", repairAudit, noLogonMs: 120 })).toBe("no-logon")
    expect(Date.now() - t0).toBeLessThan(2000)
    // Asked once per spell of no one logged on, not on every poll.
    expect(checks).toBe(1)
  })

  it("does not count OOBE's own account, or an unreachable guest, as no one logged on", async () => {
    let n = 0
    const loggedOnUser = async (): Promise<string | null> => {
      n += 1
      return n < 20 ? (n % 2 === 0 ? null : "WINVM\\defaultuser0") : "WINVM\\Administrator"
    }
    const repairAudit = async (): Promise<boolean> => {
      throw new Error("must not be asked")
    }
    expect(await untilReady("unused", 5000, { ...fast, loggedOnUser, repairAudit, noLogonMs: 20 })).toBe("ready")
  })
})

describe("qga.untilNewBoot", () => {
  const BEFORE = "2026-10-27T10:00:00.0000000-07:00"
  const AFTER = "2026-10-27T10:01:30.0000000-07:00"
  const ready = async (): Promise<"ready"> => "ready"

  it("waits out the old boot, which stays ready for a while, until a new one is ready", async () => {
    // Old boot, old boot, unreachable on the way down, then the new boot.
    const seen = [BEFORE, BEFORE, null, AFTER]
    let asked = 0
    const bootTime = async (): Promise<string | null> => seen[Math.min(asked++, seen.length - 1)] ?? null
    expect(await untilNewBoot("unused", BEFORE, 5000, { untilReady: ready, bootTime, settleMs: 1 })).toBe("ready")
    expect(asked).toBe(4)
  })

  it("times out when the boot never changes", async () => {
    const bootTime = async (): Promise<string | null> => BEFORE
    expect(await untilNewBoot("unused", BEFORE, 50, { untilReady: ready, bootTime, settleMs: 5 })).toBe("timeout")
  })

  it("passes on no-logon from the new boot rather than waiting for a change it cannot see", async () => {
    let asked = 0
    const bootTime = async (): Promise<string | null> => {
      asked += 1
      return AFTER
    }
    expect(await untilNewBoot("unused", BEFORE, 5000, { untilReady: async () => "no-logon", bootTime })).toBe("no-logon")
    expect(asked).toBe(0)
  })
})
