import { rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"

type Json = Record<string, unknown>
export type QmpHandler = (cmd: Json) => Json | null | Promise<Json | null>

export const GREETING = { QMP: { version: { qemu: { major: 11, minor: 0, micro: 3 } }, capabilities: [] } }

export class FakeQmp {
  handler: QmpHandler = (cmd) => {
    if (cmd["execute"] === "query-status") return { return: { status: "running", running: true } }
    if (cmd["execute"] === "query-chardev") return { return: [{ label: "qga0", "frontend-open": true }] }
    return { return: {} }
  }
  greets = true
  connections = 0
  readonly commands: string[] = []
  private readonly sockets = new Set<Socket>()
  private readonly backlog: Socket[] = []
  private active: Socket | null = null
  private readonly server: Server
  readonly path: string

  constructor(path: string) {
    this.path = path
    this.server = createServer((s) => this.accept(s))
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
    this.active?.write(`${JSON.stringify(event)}\n`)
  }

  private accept(s: Socket): void {
    this.connections += 1
    this.sockets.add(s)
    s.on("error", () => undefined)
    s.on("close", () => {
      this.sockets.delete(s)
      const i = this.backlog.indexOf(s)
      if (i >= 0) this.backlog.splice(i, 1)
      if (this.active === s) {
        this.active = null
        const next = this.backlog.shift()
        if (next !== undefined) this.serve(next)
      }
    })
    if (this.active === null) this.serve(s)
    else this.backlog.push(s)
  }

  private serve(s: Socket): void {
    this.active = s
    if (this.greets) s.write(`${JSON.stringify(GREETING)}\n`)
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
        const id = cmd["id"]
        this.commands.push(name)
        if (name === "qmp_capabilities") {
          negotiated = true
          s.write(`${JSON.stringify({ return: {}, ...(id === undefined ? {} : { id }) })}\n`)
          continue
        }
        if (!negotiated) {
          s.write(`${JSON.stringify({ error: { class: "CommandNotFound", desc: "Expecting capabilities negotiation" } })}\n`)
          continue
        }
        inOrder = inOrder.then(async () => {
          const reply = await this.handler(cmd)
          if (reply !== null && !s.destroyed) s.write(`${JSON.stringify(id === undefined ? reply : { ...reply, id })}\n`)
        })
      }
    })
  }
}
