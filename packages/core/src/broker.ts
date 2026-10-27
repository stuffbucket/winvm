/**
 * The control service's channel broker: one owner for an instance's QMP and
 * qemu-ga sockets.
 *
 * WHY. Both sockets serve a single client at a time, and every winvm process
 * used to connect on its own: a status poll, the idle watcher and an agent
 * install could meet on qemu-ga, and a client that gave up mid-request left
 * its reply for whoever connected next (winvm#5 was one such collision).
 *
 * HOW. QEMU binds private sockets beside the usual ones (paths.qmpQemu,
 * paths.qgaQemu). The service listens on the usual paths, which every caller
 * already uses, and lets callers through one at a time, in arrival order, per
 * connection. A connection is one caller's turn, so a 15-minute `exec` (many
 * short connections) lets others in between its polls.
 *
 * QMP keeps one negotiated upstream connection. Each caller is handed the
 * stored greeting and its `qmp_capabilities` is answered here. A caller that
 * leaves with replies still owed holds the queue until they have arrived and
 * been discarded, so no late reply reaches the next caller.
 *
 * qemu-ga is piped per caller over a fresh upstream connection, as qga.call
 * makes today; its own guest-sync handles anything a previous caller left.
 */
import { rmSync } from "node:fs"
import { connect, createServer, type Server, type Socket } from "node:net"

type Json = Record<string, unknown>

/** Feed chunks in, get whole non-empty lines out. */
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

export interface QmpChannelOptions {
  /** Where callers connect (paths.qmp). */
  readonly listen: string
  /** QEMU's own monitor socket (paths.qmpQemu). */
  readonly upstream: string
  /** Every asynchronous QMP event, whoever is connected. */
  readonly onEvent?: (event: Json) => void
  /** How long a departed caller's owed replies may hold the queue; default 200 s (savevm's 180 s, and some). */
  readonly drainTimeoutMs?: number
}

export class QmpChannel {
  private server: Server | null = null
  private upstream: Socket | null = null
  private greeting: string | null = null
  private ready = false
  private readonly queue: Socket[] = []
  private readonly pending = new WeakMap<Socket, string[]>()
  private active: Socket | null = null
  /** Replies the current caller (or a departed one being drained) is still owed. */
  private owed = 0
  private draining = false
  private drainTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private readonly o: QmpChannelOptions

  constructor(o: QmpChannelOptions) {
    this.o = o
  }

  get connected(): boolean {
    return this.ready
  }

  async start(): Promise<void> {
    rmSync(this.o.listen, { force: true })
    const server = createServer((c) => this.accept(c))
    this.server = server
    await new Promise<void>((r) => server.listen(this.o.listen, r))
    this.connectUpstream()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.drainTimer)
    for (const c of this.queue.splice(0)) c.destroy()
    this.active?.destroy()
    this.upstream?.destroy()
    const server = this.server
    if (server !== null) await new Promise<void>((r) => server.close(() => r()))
    rmSync(this.o.listen, { force: true })
  }

  // --- upstream (QEMU) -------------------------------------------------------

  private connectUpstream(): void {
    if (this.stopped) return
    const s = connect(this.o.upstream)
    let negotiating = false
    s.on("error", () => undefined) // "close" follows and retries
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
    // The caller's monitor is gone, as it is when QEMU exits; say so by closing.
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
    // A reply: owed to the current caller, or to a departed one being drained.
    if (this.owed > 0) this.owed -= 1
    if (this.draining) {
      if (this.owed === 0) this.endDrain()
      return
    }
    this.active?.write(`${line}\n`)
  }

  // --- callers ---------------------------------------------------------------

  private accept(c: Socket): void {
    this.pending.set(c, [])
    c.on("error", () => undefined)
    c.on("close", () => {
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
      // Negotiated once, upstream; each caller is answered here.
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
