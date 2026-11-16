import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { resolve } from "node:path"

import { vncAuthResponse } from "@winvm/core/desktopsize"
import { requestSize } from "@winvm/core/guestdisplay"
import { pathsFor, readMeta } from "@winvm/core/paths"
import { passwordFor, vncPort } from "@winvm/core/vnc"
import type { Size } from "@winvm/displayfit"
import { HeldSizes } from "@winvm/viewer/held"
import { parseStatus, phase } from "@winvm/viewer/model"
import { StatusGuard, type Verb, phaseAfter } from "@winvm/viewer/statusGuard"

const REPO = resolve(import.meta.dir, "..", "..")
const CLI = resolve(REPO, "apps", "cli", "src", "winvm.ts")

export interface Ran {
  readonly args: readonly string[]
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly ms: number
}

export async function winvm(args: readonly string[], o: { readonly timeoutMs?: number; readonly stdin?: string } = {}): Promise<Ran> {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: REPO,
    env: process.env,
    stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => { proc.kill() }, o.timeoutMs ?? 600_000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { args, code, stdout, stderr, ms: Date.now() - started }
}

export async function must(args: readonly string[], o: { readonly timeoutMs?: number; readonly stdin?: string } = {}): Promise<Ran> {
  const r = await winvm(args, o)
  if (r.code !== 0) throw new Error(`winvm ${args.join(" ")} exited ${String(r.code)}:\n${(r.stderr + r.stdout).trim()}`)
  return r
}

export const json = (r: Ran): unknown => JSON.parse(r.stdout)

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface Status {
  readonly state: string
  readonly vmStatus: string | null
  readonly pid: number | null
  readonly watcher?: { readonly state?: string } | null
}

export interface Sample {
  readonly at: number
  readonly state: string | null
  readonly vmStatus: string | null
  readonly error?: string
}

export interface Call {
  readonly at: number
  readonly what: string
  readonly ok: boolean
  readonly detail: string
}

const FROZEN = new Set(["paused", "asleep"])

export class AppPoller {
  readonly samples: Sample[] = []
  readonly calls: Call[] = []
  private readonly name: string
  private stopped = true
  private loops: Promise<void>[] = []
  private link: { url: string; token: string } | null = null
  private connectFailedAt = 0
  private readonly held = new HeldSizes(true, { onRetry: (size) => { this.track(this.resize(size)) } })
  private readonly inflight = new Set<Promise<void>>()

  private track(p: Promise<void>): void {
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
  }
  private readonly guard = new StatusGuard()
  private shown: string | null = null
  busy = false
  autoResize = true
  sizes: readonly Size[] = [
    { width: 1600, height: 1000 },
    { width: 1440, height: 900 },
  ]
  private nextSize = 0

  constructor(name: string) {
    this.name = name
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.loops = [this.statusLoop(), this.statsLoop(), this.resizeLoop()]
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.all(this.loops)
    this.loops = []
    while (this.inflight.size > 0) await Promise.all([...this.inflight])
    this.held.cancel()
    const left = this.held.pending
    if (left === null) return
    const label = `${String(left.width)}x${String(left.height)}`
    if (!this.guestReady) {
      this.calls.push({ at: Date.now(), what: "resize-left", ok: true, detail: `${label} kept: the machine is ${this.state ?? "unknown"} at the end` })
      return
    }
    this.held.offer(left)
    await this.resize(left)
    this.held.cancel()
    if (this.held.pending !== null) this.calls.push({ at: Date.now(), what: "resize", ok: false, detail: `${label}: never taken` })
  }

  get state(): string | null {
    return this.guard.held ?? this.shown
  }

  get guestReady(): boolean {
    return this.state === "running" && !this.busy
  }

  async act(verb: Verb, ...extra: string[]): Promise<Ran> {
    this.busy = true
    this.follow()
    try {
      const r = await winvm([verb, "-i", this.name, ...extra])
      this.calls.push({ at: Date.now(), what: `verb ${verb}`, ok: r.code === 0, detail: `exit ${String(r.code)} in ${String(r.ms)} ms: ${(r.stdout + r.stderr).trim().split("\n").slice(-2).join(" / ").slice(0, 300)}` })
      this.guard.settle(r.code === 0 ? phaseAfter(verb) : null)
      this.follow()
      await this.readOnce()
      return r
    } finally {
      this.busy = false
      this.follow()
    }
  }

  settled(): void {
    this.guard.settle(null)
    this.follow()
  }

  async offerSize(size: Size): Promise<"sent" | "held"> {
    if (!this.held.offer(size)) {
      this.calls.push({ at: Date.now(), what: "resize-held", ok: true, detail: `${String(size.width)}x${String(size.height)}` })
      return "held"
    }
    await this.resize(size)
    return "sent"
  }

  private follow(): void {
    const s = this.state
    if (s === null) return
    const thawed = this.held.setFrozen(FROZEN.has(s) || !this.guestReady)
    if (thawed !== null) this.track(this.resize(thawed))
  }

  private async readOnce(): Promise<void> {
    const ticket = this.guard.begin()
    const at = Date.now()
    const one = await winvm(["status", "--json", "-i", this.name], { timeoutMs: 30_000 })
    let state: string | null = null
    if (one.code === 0) {
      const s = parseStatus(one.stdout)?.[0]
      if (s !== undefined) {
        state = phase(s)
        this.samples.push({ at, state: s.state, vmStatus: s.vmStatus })
      } else this.samples.push({ at, state: null, vmStatus: null, error: `unreadable status: ${one.stdout.slice(0, 200)}` })
    } else this.samples.push({ at, state: null, vmStatus: null, error: (one.stderr || one.stdout).trim().slice(0, 300) })
    if (state !== null && this.guard.land(ticket)) {
      this.shown = state
      this.follow()
    }
  }

  private async statusLoop(): Promise<void> {
    while (!this.stopped) {
      const [list] = await Promise.all([winvm(["status", "--json"], { timeoutMs: 30_000 }), this.readOnce()])
      if (list.code !== 0) this.calls.push({ at: Date.now(), what: "status-list", ok: false, detail: (list.stderr || list.stdout).trim().slice(0, 300) })
      await this.pause(this.busy ? 1500 : 4000)
    }
  }

  private async ensureLink(): Promise<{ url: string; token: string } | null> {
    if (this.link !== null) return this.link
    if (Date.now() - this.connectFailedAt < 10_000) return null
    const r = await winvm(["agent", "-i", this.name, "connect", "--json"], { timeoutMs: 120_000 })
    const at = Date.now()
    if (r.code === 0) {
      const l = json(r) as { url: string; token: string }
      this.link = { url: l.url, token: l.token }
      this.calls.push({ at, what: "agent-connect", ok: true, detail: `${l.url} in ${String(r.ms)} ms` })
      return this.link
    }
    if (r.code !== 3) this.connectFailedAt = at
    this.calls.push({ at, what: "agent-connect", ok: r.code === 3, detail: `exit ${String(r.code)} in ${String(r.ms)} ms: ${r.stderr.trim().slice(0, 200)}` })
    return null
  }

  async agent(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
    const cached = this.link !== null
    try {
      const r = await this.agentOnce(method, path, body, timeoutMs)
      if (r?.status === 401 && cached) return await this.agentOnce(method, path, body, timeoutMs)
      return r
    } catch (error) {
      if (!cached || error instanceof DOMException) throw error
      return await this.agentOnce(method, path, body, timeoutMs)
    }
  }

  private async agentOnce(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
    const link = await this.ensureLink()
    if (link === null) return null
    try {
      const res = await fetch(link.url + path, {
        method,
        headers: { authorization: `Bearer ${link.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
      }
      if (res.status === 401) this.link = null
      return { status: res.status, body: parsed }
    } catch (error) {
      this.link = null
      throw error
    }
  }

  private async statsLoop(): Promise<void> {
    while (!this.stopped) {
      if (this.guestReady) {
        const at = Date.now()
        try {
          const r = await this.agent("GET", "/stats", undefined, 1500)
          if (r !== null) this.calls.push({ at, what: "stats", ok: r.status === 200, detail: r.status === 200 ? JSON.stringify(r.body).slice(0, 160) : `status ${String(r.status)}` })
        } catch (error) {
          this.calls.push({ at, what: "stats", ok: false, detail: String(error).slice(0, 200) })
        }
      }
      await this.pause(2500)
    }
  }

  private async resizeLoop(): Promise<void> {
    await this.pause(5000)
    while (!this.stopped) {
      const size = this.sizes[this.nextSize % this.sizes.length]
      this.nextSize++
      if (this.autoResize && size !== undefined && this.state !== null && this.state !== "stopped" && this.state !== "stowed") await this.offerSize(size).catch(() => undefined)
      await this.pause(15_000)
    }
  }

  private async resize(size: Size): Promise<void> {
    const at = Date.now()
    const label = `${String(size.width)}x${String(size.height)}`
    const missed = (why: string): void => {
      this.calls.push({ at, what: "resize-missed", ok: true, detail: `${label}: ${why}; asked for again` })
      this.held.missed(size)
    }
    try {
      const meta = readMeta(this.name)
      if (meta === null) throw new Error(`no instance "${this.name}"`)
      await requestSize(pathsFor(this.name), meta, size)
    } catch (error) {
      missed(`SetDesktopSize: ${String(error).slice(0, 200)}`)
      return
    }
    if (!this.guestReady) {
      missed(`Windows not ready (${this.state ?? "unknown"})`)
      return
    }
    try {
      const r = await this.agent("POST", "/display", { op: "set", width: size.width, height: size.height, waitMs: 2000, scale: 100 }, 22_000)
      if (r !== null && (r.status === 200 || r.status === 202)) {
        this.held.took()
        this.calls.push({ at, what: "resize", ok: true, detail: `${label}: status ${String(r.status)}${r.status === 200 ? "" : ` ${JSON.stringify(r.body).slice(0, 200)}`}` })
      } else missed(r === null ? "no agent" : `status ${String(r.status)} ${JSON.stringify(r.body).slice(0, 200)}`)
    } catch (error) {
      missed(String(error).slice(0, 200))
    }
  }

  private async pause(ms: number): Promise<void> {
    const until = Date.now() + ms
    while (!this.stopped && Date.now() < until) await sleep(Math.min(250, until - Date.now()))
  }

  between(from: number, to: number): { samples: Sample[]; calls: Call[] } {
    return { samples: this.samples.filter((s) => s.at >= from && s.at <= to), calls: this.calls.filter((c) => c.at >= from && c.at <= to) }
  }
}

export function heldThroughout(
  samples: readonly Sample[],
  from: number,
  to: number,
  states: readonly string[],
  o: { readonly vm?: readonly string[]; readonly minSamples?: number } = {},
): { ok: boolean; count: number; bad: Sample[] } {
  const inside = samples.filter((s) => s.at >= from && s.at <= to)
  const bad = inside.filter((s) => s.state === null || !states.includes(s.state) || (o.vm !== undefined && !o.vm.includes(s.vmStatus ?? "")))
  return { ok: bad.length === 0 && inside.length >= (o.minSamples ?? 1), count: inside.length, bad }
}

export function path(samples: readonly Sample[], from: number, to: number): string {
  const out: string[] = []
  for (const s of samples) {
    if (s.at < from || s.at > to) continue
    const label = s.state === null ? `error` : s.vmStatus !== null && s.vmStatus !== s.state ? `${s.state}(${s.vmStatus})` : s.state
    if (out[out.length - 1] !== label) out.push(label)
  }
  return out.join(" > ")
}

export async function waitFor<T>(get: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, everyMs = 1000): Promise<{ ok: boolean; value: T; ms: number }> {
  const started = Date.now()
  let value = await get()
  while (!ok(value) && Date.now() - started < timeoutMs) {
    await sleep(everyMs)
    value = await get()
  }
  return { ok: ok(value), value, ms: Date.now() - started }
}

export interface VncKeys {
  send(keysym: number, code: string, down: boolean): void
  readonly sent: string[]
  close(): void
}

const XT_SCANCODES: Readonly<Record<string, number>> = { MetaLeft: 0xe05b, MetaRight: 0xe05c, ControlLeft: 0x1d, AltLeft: 0x38, KeyR: 0x13, Tab: 0x0f, Escape: 0x01 }

export function rfbKeycode(code: string): number {
  const xt = XT_SCANCODES[code] ?? 0
  const upper = xt >> 8
  const lower = xt & 0xff
  return upper === 0xe0 && lower < 0x7f ? lower | 0x80 : xt
}

export async function vncKeys(name: string, timeoutMs = 5000): Promise<VncKeys> {
  const meta = readMeta(name)
  if (meta === null) throw new Error(`no instance "${name}"`)
  const sock = connect(vncPort(meta.vnc), "127.0.0.1")
  let buf = Buffer.alloc(0)
  let wake: (() => void) | null = null
  let failed: Error | null = null
  let handshaking = true
  sock.on("data", (d: Buffer) => {
    if (!handshaking) return
    buf = Buffer.concat([buf, d])
    wake?.()
  })
  sock.on("error", (e) => {
    failed = e
    wake?.()
  })
  const need = async (n: number): Promise<Buffer> => {
    while (buf.length < n) {
      if (failed !== null) throw failed
      await new Promise<void>((r) => (wake = r))
    }
    const out = buf.subarray(0, n)
    buf = buf.subarray(n)
    return out
  }
  const timer = setTimeout(() => {
    failed = new Error("no answer from the VNC server")
    sock.destroy()
    wake?.()
  }, timeoutMs)
  try {
    await need(12)
    sock.write("RFB 003.008\n")
    const types = [...(await need((await need(1))[0] ?? 0))]
    if (types.includes(2)) {
      sock.write(Buffer.from([2]))
      sock.write(vncAuthResponse(passwordFor(pathsFor(name)), await need(16)))
    } else sock.write(Buffer.from([1]))
    if ((await need(4)).readUInt32BE(0) !== 0) throw new Error("VNC authentication failed")
    sock.write(Buffer.from([1]))
    const init = await need(24)
    await need(init.readUInt32BE(20))
  } finally {
    clearTimeout(timer)
  }
  handshaking = false
  const enc = Buffer.alloc(8)
  enc[0] = 2
  enc.writeUInt16BE(1, 2)
  enc.writeInt32BE(-258, 4)
  sock.write(enc)
  const sent: string[] = []
  return {
    sent,
    send(keysym, code, down) {
      const m = Buffer.alloc(12)
      m[0] = 255
      m[1] = 0
      m.writeUInt16BE(down ? 1 : 0, 2)
      m.writeUInt32BE(keysym, 4)
      m.writeUInt32BE(rfbKeycode(code), 8)
      sock.write(m)
      sent.push(`${code} ${down ? "down" : "up"}`)
    },
    close() {
      sock.end()
    },
  }
}

export async function smbMounts(instance: string): Promise<string[]> {
  const out = await new Response(Bun.spawn(["mount"], { stdout: "pipe" }).stdout).text()
  const dir = resolve(process.env["HOME"] ?? "", "winvm", instance)
  return out
    .split("\n")
    .filter((l) => l.includes("(smbfs") && l.includes(` on ${dir}/`))
    .map((l) => l.slice(l.indexOf(" on ") + 4, l.indexOf(" (smbfs")))
}

export async function virtiofsds(instance: string): Promise<string[]> {
  const out = await new Response(Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe" }).stdout).text()
  const needle = `/instances/${instance}/`
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /(^|\/)virtiofsd /.test(l.replace(/^\d+\s+/, "")) && l.includes(needle))
}

export function pngSize(file: string): { width: number; height: number } | null {
  if (!existsSync(file)) return null
  const b = readFileSync(file)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly evidence: string
}

export class Scenario {
  readonly checks: Check[] = []
  readonly notes: string[] = []
  readonly title: string
  readonly out: string
  skipped: string | null = null

  constructor(title: string, out: string) {
    this.title = title
    this.out = out
    mkdirSync(out, { recursive: true })
  }

  check(name: string, ok: boolean, evidence: string): boolean {
    this.checks.push({ name, ok, evidence })
    console.log(`    ${ok ? "ok  " : "FAIL"} ${name} — ${evidence}`)
    return ok
  }

  note(text: string): void {
    this.notes.push(text)
    console.log(`    .    ${text}`)
  }

  skip(why: string): void {
    this.skipped = why
    console.log(`    skip ${why}`)
  }

  get ok(): boolean {
    return this.checks.every((c) => c.ok)
  }

  saveTrace(poller: AppPoller, from: number, to: number, file: string): string {
    const t = poller.between(from, to)
    const rel = (at: number): string => `+${((at - from) / 1000).toFixed(1)}s`
    const lines = [
      ...t.samples.map((s) => `${rel(s.at)} status ${s.state ?? "?"} vm=${s.vmStatus ?? "-"}${s.error === undefined ? "" : ` error=${s.error}`}`),
      ...t.calls.map((c) => `${rel(c.at)} ${c.what} ${c.ok ? "ok" : "FAILED"} ${c.detail}`),
    ].sort((a, b) => Number.parseFloat(a.slice(1)) - Number.parseFloat(b.slice(1)))
    const path_ = resolve(this.out, file)
    writeFileSync(path_, `${lines.join("\n")}\n`)
    return path_
  }
}
