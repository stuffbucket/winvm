import type { Server, Socket } from "node:net"
import { createServer } from "node:net"

export type Handler = (req: Record<string, unknown>) => Record<string, unknown> | null

export class FakeAgent {
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
