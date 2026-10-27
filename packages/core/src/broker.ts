import { readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs"
import { basename } from "node:path"
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

let listeners = 0

class Listener {
  private server: Server | null = null
  private readonly path: string
  private readonly own: string

  constructor(path: string) {
    this.path = path
    listeners += 1
    this.own = `${path}.${process.pid.toString(36)}${listeners.toString(36)}`
  }

  async start(onConnection: (c: Socket) => void): Promise<void> {
    rmSync(this.own, { force: true })
    const server = createServer(onConnection)
    this.server = server
    await new Promise<void>((r) => server.listen(this.own, r))
    const link = `${this.own}.link`
    rmSync(link, { force: true })
    symlinkSync(basename(this.own), link)
    renameSync(link, this.path)
  }

  async stop(): Promise<void> {
    let ours = false
    try {
      ours = readlinkSync(this.path) === basename(this.own)
    } catch {
      ours = false
    }
    if (ours) rmSync(this.path, { force: true })
    const server = this.server
    if (server !== null) await new Promise<void>((r) => server.close(() => r()))
    rmSync(this.own, { force: true })
  }
}

const REQUEST_ID = "winvm-service-"

export interface QmpChannelOptions {
  readonly listen: string
  readonly upstream: string
  readonly onEvent?: (event: Json) => void
  readonly onConnect?: () => void
  readonly drainTimeoutMs?: number
  readonly negotiateTimeoutMs?: number
}

export class QmpChannel {
  private readonly o: QmpChannelOptions
  private readonly listener: Listener
  private upstream: Socket | null = null
  private connecting: Socket | null = null
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
  private nextId = 0
  private readonly requests = new Map<string, (reply: Json) => void>()

  constructor(o: QmpChannelOptions) {
    this.o = o
    this.listener = new Listener(o.listen)
  }

  get connected(): boolean {
    return this.ready
  }

  async start(): Promise<void> {
    await this.listener.start((c) => this.accept(c))
    this.connectUpstream()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.drainTimer)
    this.queue.length = 0
    for (const c of this.sockets) c.destroy()
    this.active?.destroy()
    this.upstream?.destroy()
    this.connecting?.destroy()
    await this.listener.stop()
  }

  async request(execute: string, args?: Json, timeoutMs = 5000): Promise<Json> {
    const up = this.upstream
    if (up === null || !this.ready) throw new Error("not connected to QEMU")
    this.nextId += 1
    const id = `${REQUEST_ID}${String(this.nextId)}`
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<Json>((res, rej) => {
        this.requests.set(id, (reply) => {
          const { id: _id, ...rest } = reply
          res(rest)
        })
        timer = setTimeout(() => rej(new Error(`${execute}: no answer in ${String(timeoutMs)} ms`)), timeoutMs)
        up.write(`${JSON.stringify(args === undefined ? { execute, id } : { execute, arguments: args, id })}\n`)
      })
    } finally {
      clearTimeout(timer)
      this.requests.delete(id)
    }
  }

  private connectUpstream(): void {
    if (this.stopped) return
    const s = connect(this.o.upstream)
    this.connecting = s
    let negotiating = false
    const negotiation = setTimeout(() => s.destroy(), this.o.negotiateTimeoutMs ?? 10_000)
    s.on("error", () => undefined)
    s.on("close", () => {
      clearTimeout(negotiation)
      if (this.connecting === s) this.connecting = null
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
          clearTimeout(negotiation)
          negotiating = false
          this.connecting = null
          this.upstream = s
          this.ready = true
          this.o.onConnect?.()
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
    const id = msg["id"]
    if (typeof id === "string" && id.startsWith(REQUEST_ID)) {
      this.requests.get(id)?.(msg)
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
      this.drainTimer = setTimeout(() => this.upstream?.destroy(), this.o.drainTimeoutMs ?? 200_000)
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
  readonly onRefused?: () => void
  readonly pollMs?: number
}

export class QgaChannel {
  private readonly o: QgaChannelOptions
  private readonly listener: Listener
  private readonly queue: Socket[] = []
  private readonly sockets = new Set<Socket>()
  private readonly pending = new WeakMap<Socket, Buffer[]>()
  private active: Socket | null = null
  private upstream: Socket | null = null
  private stopped = false

  constructor(o: QgaChannelOptions) {
    this.o = o
    this.listener = new Listener(o.listen)
  }

  async start(): Promise<void> {
    await this.listener.start((c) => this.accept(c))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.queue.length = 0
    for (const c of this.sockets) c.destroy()
    this.active?.destroy()
    this.upstream?.destroy()
    await this.listener.stop()
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
    if (next.destroyed || this.stopped || this.active !== next) return
    const up = connect(this.o.upstream)
    this.upstream = up
    let connected = false
    up.on("error", () => undefined)
    up.on("close", () => {
      if (!connected) this.o.onRefused?.()
      if (this.upstream === up) next.destroy()
    })
    up.on("data", (chunk: Buffer) => {
      if (this.active === next) next.write(chunk)
      else up.destroy()
    })
    up.on("connect", () => {
      connected = true
      if (this.active !== next) {
        up.destroy()
        return
      }
      for (const chunk of this.pending.get(next)?.splice(0) ?? []) up.write(chunk)
    })
  }
}
