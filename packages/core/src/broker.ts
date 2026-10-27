import { rmSync } from "node:fs"
import { connect, createServer, type Server, type Socket } from "node:net"

type Json = Record<string, unknown>

function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = ""
  return (chunk) => {
    buf += chunk.toString("utf8")
    for (;;) {
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line !== "") onLine(line)
    }
  }
}

function parse(line: string): Json | null {
  try {
    return JSON.parse(line) as Json
  } catch {
    return null
  }
}

async function listenOn(path: string, onConnection: (c: Socket) => void): Promise<Server> {
  rmSync(path, { force: true })
  const server = createServer(onConnection)
  await new Promise<void>((r) => server.listen(path, r))
  return server
}

async function closeServer(server: Server | null, path: string): Promise<void> {
  if (server !== null) await new Promise<void>((r) => server.close(() => r()))
  rmSync(path, { force: true })
}

export interface QmpChannelOptions {
  readonly listen: string
  readonly upstream: string
  readonly onEvent?: (event: Json) => void
  readonly drainTimeoutMs?: number
}

export class QmpChannel {
  private readonly o: QmpChannelOptions
  private server: Server | null = null
  private upstream: Socket | null = null
  private greeting: string | null = null
  private ready = false
  private readonly queue: Socket[] = []
  private readonly sockets = new Set<Socket>()
  private readonly pending = new WeakMap<Socket, string[]>()
  private active: Socket | null = null
  private owed = 0
  private draining = false
  private drainTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(o: QmpChannelOptions) {
    this.o = o
  }

  get connected(): boolean {
    return this.ready
  }

  async start(): Promise<void> {
    this.server = await listenOn(this.o.listen, (c) => this.accept(c))
    this.connectUpstream()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.drainTimer)
    this.queue.length = 0
    for (const c of this.sockets) c.destroy()
    this.active?.destroy()
    this.upstream?.destroy()
    await closeServer(this.server, this.o.listen)
  }

  private connectUpstream(): void {
    if (this.stopped) return
    const s = connect(this.o.upstream)
    let negotiating = false
    s.on("error", () => undefined)
    s.on("close", () => {
      if (this.upstream === s) this.upstreamLost()
      if (!this.stopped) setTimeout(() => this.connectUpstream(), 200)
    })
    s.on(
      "data",
      lineReader((line) => {
        const msg = parse(line)
        if (msg === null) return
        if ("QMP" in msg) {
          this.greeting = line
          negotiating = true
          s.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\n`)
          return
        }
        if (negotiating && !("event" in msg)) {
          negotiating = false
          this.upstream = s
          this.ready = true
          this.pump()
          return
        }
        if (this.upstream === s) this.fromUpstream(line, msg)
      }),
    )
  }

  private upstreamLost(): void {
    this.upstream = null
    this.ready = false
    this.active?.destroy()
    this.active = null
    this.owed = 0
    this.draining = false
    clearTimeout(this.drainTimer)
  }

  private fromUpstream(line: string, msg: Json): void {
    if ("event" in msg) {
      this.o.onEvent?.(msg)
      if (this.active !== null && !this.draining) this.active.write(`${line}\n`)
      return
    }
    if (this.owed > 0) this.owed -= 1
    if (this.draining) {
      if (this.owed === 0) this.endDrain()
      return
    }
    this.active?.write(`${line}\n`)
  }

  private accept(c: Socket): void {
    this.sockets.add(c)
    this.pending.set(c, [])
    c.on("error", () => undefined)
    c.on("close", () => {
      this.sockets.delete(c)
      if (this.active === c) this.callerLeft()
      else {
        const i = this.queue.indexOf(c)
        if (i >= 0) this.queue.splice(i, 1)
      }
    })
    c.on(
      "data",
      lineReader((line) => {
        if (this.active === c) this.fromCaller(c, line)
        else this.pending.get(c)?.push(line)
      }),
    )
    this.queue.push(c)
    this.pump()
  }

  private pump(): void {
    if (this.active !== null || this.draining || !this.ready || this.greeting === null) return
    for (;;) {
      const next = this.queue.shift()
      if (next === undefined) return
      if (next.destroyed) continue
      this.active = next
      next.write(`${this.greeting}\n`)
      for (const line of this.pending.get(next)?.splice(0) ?? []) this.fromCaller(next, line)
      return
    }
  }

  private fromCaller(c: Socket, line: string): void {
    const msg = parse(line)
    if (msg === null) return
    if (msg["execute"] === "qmp_capabilities") {
      c.write(`${JSON.stringify({ return: {} })}\n`)
      return
    }
    if (this.upstream === null) return
    if ("execute" in msg || "exec-oob" in msg) this.owed += 1
    this.upstream.write(`${line}\n`)
  }

  private callerLeft(): void {
    this.active = null
    if (this.owed > 0 && this.upstream !== null) {
      this.draining = true
      this.drainTimer = setTimeout(() => this.endDrain(), this.o.drainTimeoutMs ?? 200_000)
      return
    }
    this.owed = 0
    this.pump()
  }

  private endDrain(): void {
    clearTimeout(this.drainTimer)
    this.draining = false
    this.owed = 0
    this.pump()
  }
}

export interface QgaChannelOptions {
  readonly listen: string
  readonly upstream: string
  readonly portOpen: () => Promise<boolean | null>
  readonly pollMs?: number
}

export class QgaChannel {
  private readonly o: QgaChannelOptions
  private server: Server | null = null
  private readonly queue: Socket[] = []
  private readonly sockets = new Set<Socket>()
  private readonly pending = new WeakMap<Socket, Buffer[]>()
  private active: Socket | null = null
  private upstream: Socket | null = null
  private stopped = false

  constructor(o: QgaChannelOptions) {
    this.o = o
  }

  async start(): Promise<void> {
    this.server = await listenOn(this.o.listen, (c) => this.accept(c))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.queue.length = 0
    for (const c of this.sockets) c.destroy()
    this.active?.destroy()
    this.upstream?.destroy()
    await closeServer(this.server, this.o.listen)
  }

  private accept(c: Socket): void {
    this.sockets.add(c)
    this.pending.set(c, [])
    c.on("error", () => undefined)
    c.on("data", (chunk: Buffer) => {
      if (this.active === c && this.upstream !== null) this.upstream.write(chunk)
      else this.pending.get(c)?.push(chunk)
    })
    c.on("close", () => {
      this.sockets.delete(c)
      if (this.active === c) {
        this.upstream?.destroy()
        this.upstream = null
        this.active = null
        void this.pump()
      } else {
        const i = this.queue.indexOf(c)
        if (i >= 0) this.queue.splice(i, 1)
      }
    })
    this.queue.push(c)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.active !== null || this.stopped) return
    const next = this.queue.shift()
    if (next === undefined) return
    if (next.destroyed) {
      void this.pump()
      return
    }
    this.active = next
    while (!next.destroyed && !this.stopped && (await this.o.portOpen().catch(() => null)) !== true) {
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 250))
    }
    if (next.destroyed || this.stopped) return
    const up = connect(this.o.upstream)
    up.on("error", () => undefined)
    up.on("close", () => {
      if (this.upstream === up) next.destroy()
    })
    up.on("data", (chunk: Buffer) => next.write(chunk))
    up.on("connect", () => {
      this.upstream = up
      for (const chunk of this.pending.get(next)?.splice(0) ?? []) up.write(chunk)
    })
  }
}
