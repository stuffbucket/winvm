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

import { call } from "../qga"

type Handler = (req: Record<string, unknown>) => Record<string, unknown> | null

class FakeAgent {
  /** Replies owed to callers that hung up first; the next connection receives them. */
  owed: Buffer[] = []
  handler: Handler = () => ({ return: {} })
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

  private serve(sock: Socket): void {
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
    await expect(call(agent.path, { execute: "slow" }, 50)).rejects.toThrow("timed out")
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
