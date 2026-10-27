/**
 * A stand-in for QEMU's QMP monitor on a Unix socket: greets, requires
 * qmp_capabilities first, then answers each command through `handler`
 * (null: never answer). Records every command it was sent, and can emit
 * asynchronous events.
 */
import { rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"

type Json = Record<string, unknown>
export type QmpHandler = (cmd: Json) => Json | null | Promise<Json | null>

export const GREETING = { QMP: { version: { qemu: { major: 11, minor: 0, micro: 3 } }, capabilities: [] } }

export class FakeQmp {
  handler: QmpHandler = (cmd) => (cmd["execute"] === "query-status" ? { return: { status: "running", running: true } } : { return: {} })
  connections = 0
  readonly commands: string[] = []
  private readonly sockets = new Set<Socket>()
  private readonly server: Server
  readonly path: string

  constructor(path: string) {
    this.path = path
    this.server = createServer((s) => this.serve(s))
  }

  async listen(): Promise<void> {
    rmSync(this.path, { force: true })
    await new Promise<void>((r) => this.server.listen(this.path, r))
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((r) => this.server.close(() => r()))
    rmSync(this.path, { force: true })
  }

  emit(event: Json): void {
    for (const s of this.sockets) s.write(`${JSON.stringify(event)}\n`)
  }

  private serve(s: Socket): void {
    this.connections += 1
    this.sockets.add(s)
    s.on("close", () => this.sockets.delete(s))
    s.on("error", () => undefined)
    s.write(`${JSON.stringify(GREETING)}\n`)
    let buf = ""
    let negotiated = false
    let inOrder: Promise<void> = Promise.resolve()
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      for (;;) {
        const nl = buf.indexOf("\n")
        if (nl < 0) return
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line === "") continue
        const cmd = JSON.parse(line) as Json
        const name = String(cmd["execute"])
        this.commands.push(name)
        if (name === "qmp_capabilities") {
          negotiated = true
          s.write(`${JSON.stringify({ return: {} })}\n`)
          continue
        }
        if (!negotiated) {
          s.write(`${JSON.stringify({ error: { class: "CommandNotFound", desc: "Expecting capabilities negotiation" } })}\n`)
          continue
        }
        // QEMU answers a monitor's commands strictly in order: a slow one
        // holds back every reply after it.
        inOrder = inOrder.then(async () => {
          const reply = await this.handler(cmd)
          if (reply !== null && !s.destroyed) s.write(`${JSON.stringify(reply)}\n`)
        })
      }
    })
  }
}
