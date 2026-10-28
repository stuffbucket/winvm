/**
 * What the scenarios share: running the worktree's winvm CLI as the app does,
 * the app's background polling, and assertions held over time.
 *
 * THE POLLER IS THE APP'S, NOT A STAND-IN. While a scenario runs, it does what
 * the open app does to a machine, on the app's own timers:
 *
 *   - `winvm status --json` (the list) and `winvm status --json -i NAME`, every
 *     1.5 s while something is happening and 4 s otherwise (useWinvm.ts);
 *   - `winvm agent -i NAME connect --json` when it has no address for the agent
 *     yet, or its last call failed, at most every 10 s after a failure
 *     (src-tauri/src/agent.rs), and GET /stats every 2.5 s while Windows is up
 *     (useUsage.ts);
 *   - a live resize, SetDesktopSize over VNC and then POST /display {op:"set"}
 *     (guestdisplay.ts), through the app's own HeldSizes
 *     (features/screen/held.ts): held while the machine is paused or asleep and
 *     asked for once it runs again;
 *   - verbs run as useWinvm's `act` runs them, the shown state settled through
 *     the app's own StatusGuard (features/winvm/statusGuard.ts), so a read that
 *     raced a verb is dropped as the app drops it.
 *
 * Every answer is kept with its time, so a scenario can assert what the app
 * would have shown at every moment, not only at the end.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { resolve } from "node:path"

import type { Size } from "@winvm/displayfit"

import { HeldSizes } from "../../apps/viewer/ui/src/features/screen/held"
import { StatusGuard, type Verb, phaseAfter } from "../../apps/viewer/ui/src/features/winvm/statusGuard"
import { requestSize } from "../../packages/core/src/guestdisplay"
import { pathsFor, readMeta } from "../../packages/core/src/paths"
import { vncAuthResponse } from "../../packages/core/src/desktopsize"
import { passwordFor, vncPort } from "../../packages/core/src/vnc"

export const REPO = resolve(import.meta.dir, "..", "..")
const CLI = resolve(REPO, "apps", "cli", "src", "winvm.ts")

export interface Ran {
  readonly args: readonly string[]
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly ms: number
}

/** The worktree's winvm, as the app's sidecar runs it: a process per call. */
export async function winvm(args: readonly string[], o: { readonly timeoutMs?: number; readonly stdin?: string } = {}): Promise<Ran> {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: REPO,
    env: process.env,
    stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 600_000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { args, code, stdout, stderr, ms: Date.now() - started }
}

/** Runs winvm and throws, with what it said, unless it exits 0. */
export async function must(args: readonly string[], o: { readonly timeoutMs?: number; readonly stdin?: string } = {}): Promise<Ran> {
  const r = await winvm(args, o)
  if (r.code !== 0) throw new Error(`winvm ${args.join(" ")} exited ${String(r.code)}:\n${(r.stderr + r.stdout).trim()}`)
  return r
}

export const json = <T>(r: Ran): T => JSON.parse(r.stdout) as T

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** What `winvm status --json -i NAME` says, the parts the app reads. */
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

/** The app's background polling of one machine (see the top of this file). */
export class AppPoller {
  readonly samples: Sample[] = []
  readonly calls: Call[] = []
  private readonly name: string
  private stopped = true
  private loops: Promise<void>[] = []
  private link: { url: string; token: string } | null = null
  private connectFailedAt = 0
  private readonly held = new HeldSizes(false)
  private readonly guard = new StatusGuard()
  /** The state the window shows: what the last verb left until a fresh read lands, else the newest read. */
  private shown: string | null = null
  /** The scenario says something is happening: poll fast, as the app does while busy. */
  busy = false
  /** The window is resized now and then on its own; off when a scenario resizes it itself. */
  autoResize = true
  /** Sizes the resize loop alternates between. */
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
  }

  /** The state the app shows now. */
  get state(): string | null {
    return this.guard.held ?? this.shown
  }

  /** Windows is up and nothing is under way: when the app calls the agent (App.tsx guestReady). */
  get guestReady(): boolean {
    return this.state === "running" && !this.busy
  }

  /**
   * A verb as the app's buttons run it (useWinvm's `act`): `winvm VERB -i NAME`,
   * polling fast meanwhile, then what it did shown at once and a fresh read.
   */
  async act(verb: Verb, ...extra: string[]): Promise<Ran> {
    this.busy = true
    try {
      const r = await winvm([verb, "-i", this.name, ...extra])
      this.calls.push({ at: Date.now(), what: `verb ${verb}`, ok: r.code === 0, detail: `exit ${String(r.code)} in ${String(r.ms)} ms: ${(r.stdout + r.stderr).trim().split("\n").slice(-2).join(" / ").slice(0, 300)}` })
      this.guard.settle(r.code === 0 ? phaseAfter(verb) : null)
      this.follow()
      await this.readOnce()
      return r
    } finally {
      this.busy = false
      this.flushPending()
    }
  }

  /** Something other than a verb changed the machine (the scenario ran the CLI itself): reads already out are stale. */
  settled(): void {
    this.guard.settle(null)
    this.follow()
  }

  /** The window was resized: ask for its size, or keep it while the machine is held (Screen.tsx). */
  async offerSize(size: Size): Promise<"sent" | "held"> {
    if (!this.held.offer(size)) {
      this.calls.push({ at: Date.now(), what: "resize-held", ok: true, detail: `${String(size.width)}x${String(size.height)}` })
      return "held"
    }
    await this.resize(size)
    return "sent"
  }

  /** The held sizes follow the state shown; a size kept while held is asked for once it runs again. */
  private follow(): void {
    const s = this.state
    if (s === null) return
    const thawed = this.held.setFrozen(FROZEN.has(s))
    if (thawed !== null) void this.resize(thawed)
    this.flushPending()
  }

  /** A size the agent could not be asked for yet (App.tsx pendingSize): asked once Windows is ready. */
  private pending: Size | null = null

  private flushPending(): void {
    const size = this.pending
    if (size === null || !this.guestReady) return
    this.pending = null
    void this.setMode(size, Date.now())
  }

  /** One `winvm status --json -i NAME`: kept as the machine's truth, and shown if the guard lets it land. */
  private async readOnce(): Promise<void> {
    const ticket = this.guard.begin()
    // A read describes the machine when it was asked: it is kept at its start.
    const at = Date.now()
    const one = await winvm(["status", "--json", "-i", this.name], { timeoutMs: 30_000 })
    let state: string | null = null
    if (one.code === 0) {
      try {
        const s = json<Status>(one)
        state = s.state
        this.samples.push({ at, state, vmStatus: s.vmStatus ?? null })
      } catch (error) {
        this.samples.push({ at, state: null, vmStatus: null, error: `unreadable status: ${String(error)}` })
      }
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

  /** Connects as agent.rs does: once, again after a failure, never more often than every 10 s after one. */
  private async ensureLink(): Promise<{ url: string; token: string } | null> {
    if (this.link !== null) return this.link
    if (Date.now() - this.connectFailedAt < 10_000) return null
    const r = await winvm(["agent", "-i", this.name, "connect", "--json"], { timeoutMs: 120_000 })
    const at = Date.now()
    if (r.code === 0) {
      const l = json<{ url: string; token: string }>(r)
      this.link = { url: l.url, token: l.token }
      this.calls.push({ at, what: "agent-connect", ok: true, detail: `${l.url} in ${String(r.ms)} ms` })
      return this.link
    }
    // Exit 3: paused or asleep, said at once and not kept (agent.rs).
    if (r.code !== 3) this.connectFailedAt = at
    this.calls.push({ at, what: "agent-connect", ok: r.code === 3, detail: `exit ${String(r.code)} in ${String(r.ms)} ms: ${r.stderr.trim().slice(0, 200)}` })
    return null
  }

  /**
   * One call to the agent, as agent.rs makes it: one that cannot reach the
   * agent, or is refused its token, forgets the address and connects again,
   * once (the machine restarted, or the agent was reinstalled).
   */
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
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // text it is
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
      // GET /stats only while Windows is up and nothing is under way (guestReady), as useUsage does.
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

  /**
   * The app's two steps (guestdisplay.ts): SetDesktopSize over VNC, as its
   * noVNC does, then the agent sets the mode, or keeps the size until Windows
   * is ready (App.tsx resizeGuest).
   */
  private async resize(size: Size): Promise<void> {
    const at = Date.now()
    const label = `${String(size.width)}x${String(size.height)}`
    try {
      const meta = readMeta(this.name)
      if (meta === null) throw new Error(`no instance "${this.name}"`)
      await requestSize(pathsFor(this.name), meta, size)
    } catch (error) {
      this.calls.push({ at, what: "resize", ok: false, detail: `${label}: SetDesktopSize: ${String(error).slice(0, 200)}` })
      return
    }
    if (!this.guestReady) {
      this.pending = size
      this.calls.push({ at, what: "resize-pending", ok: true, detail: `${label} until Windows is ready` })
      return
    }
    await this.setMode(size, at)
  }

  private async setMode(size: Size, at: number): Promise<void> {
    const label = `${String(size.width)}x${String(size.height)}`
    try {
      const r = await this.agent("POST", "/display", { op: "set", width: size.width, height: size.height, waitMs: 2000, scale: 100 }, 22_000)
      // 202: Windows is at its lock screen; the agent sets the size at sign-in (App.tsx takes it as done).
      const why = r === null || r.status === 200 ? "" : ` ${JSON.stringify(r.body).slice(0, 200)}`
      this.calls.push({ at, what: "resize", ok: r !== null && (r.status === 200 || r.status === 202), detail: `${label}: ${r === null ? "no agent" : `status ${String(r.status)}`}${why}` })
    } catch (error) {
      this.calls.push({ at, what: "resize", ok: false, detail: `${label}: ${String(error).slice(0, 200)}` })
    }
  }

  private async pause(ms: number): Promise<void> {
    const until = Date.now() + ms
    while (!this.stopped && Date.now() < until) await sleep(Math.min(250, until - Date.now()))
  }

  /** Samples and calls in [from, to]. */
  between(from: number, to: number): { samples: Sample[]; calls: Call[] } {
    return { samples: this.samples.filter((s) => s.at >= from && s.at <= to), calls: this.calls.filter((c) => c.at >= from && c.at <= to) }
  }
}

// ---- assertions over time ---------------------------------------------------------------------

/**
 * That every status read in [from, to] showed one of `states` (and, when given,
 * QEMU's run state one of `vm`), with enough reads to mean something. Pure.
 */
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

/** The states the reads in [from, to] went through, each run of the same state once: "running > paused > running". */
export function path(samples: readonly Sample[], from: number, to: number): string {
  const out: string[] = []
  for (const s of samples) {
    if (s.at < from || s.at > to) continue
    const label = s.state === null ? `error` : s.vmStatus !== null && s.vmStatus !== s.state ? `${s.state}(${s.vmStatus})` : s.state
    if (out[out.length - 1] !== label) out.push(label)
  }
  return out.join(" > ")
}

/** Polls `get` until `ok` says yes, up to `timeoutMs`; the last value either way. */
export async function waitFor<T>(get: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, everyMs = 1000): Promise<{ ok: boolean; value: T; ms: number }> {
  const started = Date.now()
  let value = await get()
  while (!ok(value) && Date.now() - started < timeoutMs) {
    await sleep(everyMs)
    value = await get()
  }
  return { ok: ok(value), value, ms: Date.now() - started }
}

// ---- keys over VNC, as the app's noVNC sends them ----------------------------------------------

/** A key sender over the machine's VNC server: QEMU extended key events, as noVNC sends them (rfb.js). */
export interface VncKeys {
  send(keysym: number, code: string, down: boolean): void
  /** What was sent, in order: "MetaLeft down", ... */
  readonly sent: string[]
  close(): void
}

/** The XT scancodes of the keys the scenarios press, from noVNC's table (core/input/xtscancodes.js). */
const XT_SCANCODES: Readonly<Record<string, number>> = { MetaLeft: 0xe05b, MetaRight: 0xe05c, ControlLeft: 0x1d, AltLeft: 0x38, KeyR: 0x13, Tab: 0x0f, Escape: 0x01 }

/** noVNC's getRFBkeycode: an 0xE0-prefixed XT scancode goes as its low byte with the top bit set. */
export function rfbKeycode(code: string): number {
  const xt = XT_SCANCODES[code] ?? 0
  const upper = xt >> 8
  const lower = xt & 0xff
  return upper === 0xe0 && lower < 0x7f ? lower | 0x80 : xt
}

/** Connects to the machine's VNC server as a second, shared client, and sends keys. */
export async function vncKeys(name: string, timeoutMs = 5000): Promise<VncKeys> {
  const meta = readMeta(name)
  if (meta === null) throw new Error(`no instance "${name}"`)
  const sock = connect(vncPort(meta.vnc), "127.0.0.1")
  let buf = Buffer.alloc(0)
  let wake: (() => void) | null = null
  let failed: Error | null = null
  let handshaking = true
  sock.on("data", (d: Buffer) => {
    // After the handshake, what QEMU says (the extended key event's ack) is not needed.
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
    sock.write(Buffer.from([1])) // shared, so the app's own connection stays
    const init = await need(24)
    await need(init.readUInt32BE(20))
  } finally {
    clearTimeout(timer)
  }
  handshaking = false
  // SetEncodings: QEMU's extended key event (-258), which noVNC uses with QEMU.
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

// ---- the Mac side, looked at and never touched -------------------------------------------------

/** This instance's smbfs mounts in the mount table: the folders. Never reads through a mount. */
export async function smbMounts(instance: string): Promise<string[]> {
  const out = await new Response(Bun.spawn(["mount"], { stdout: "pipe" }).stdout).text()
  const dir = resolve(process.env["HOME"] ?? "", "winvm", instance)
  return out
    .split("\n")
    .filter((l) => l.includes("(smbfs") && l.includes(` on ${dir}/`))
    .map((l) => l.slice(l.indexOf(" on ") + 4, l.indexOf(" (smbfs")))
}

/** virtiofsd processes serving this instance (found by their socket in its directory, as share.ts does). */
export async function virtiofsds(instance: string): Promise<string[]> {
  const out = await new Response(Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe" }).stdout).text()
  const needle = `/instances/${instance}/`
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /(^|\/)virtiofsd /.test(l.replace(/^\d+\s+/, "")) && l.includes(needle))
}

/** Whether a file is a PNG, and its size, from its header. */
export function pngSize(file: string): { width: number; height: number } | null {
  if (!existsSync(file)) return null
  const b = readFileSync(file)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

// ---- results ----------------------------------------------------------------------------------

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

  /** The poller's record for this scenario, for whoever reads the evidence later. */
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
