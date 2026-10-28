/**
 * `winvm terminal`: a shell in the guest, in this terminal. The guest end is the
 * agent's GET /term WebSocket (guestagent.ts, assets/conpty.cs).
 *
 *   winvm terminal [-i name] [--shell pwsh|powershell|cmd] [--cwd PATH]
 *   winvm terminal [-i name] [--shell ..] [--cwd ..] --connect --json
 *   winvm terminal [-i name] --shells [--json]
 *
 * `--connect --json` makes sure the agent is current and answering, then
 * prints how to reach it, `{"url": "ws://…/term?shell=…", "protocols": [...]}`,
 * for a client that relays the terminal itself (the Mac app adds `cols` and
 * `rows` to the URL). The token rides as a subprotocol, which a browser's
 * WebSocket can send where it cannot send headers.
 *
 * `--shells` says which shells the guest has, with `--json` as
 * `{"pwsh":false,"powershell":true,"cmd":true}`, so a client offers only
 * those. It uses the agent's exec (no route of its own) and looks for pwsh
 * where the agent does.
 */
import * as agent from "./agent"
import type { Args } from "./args"
import { instanceName } from "./args"
import type { TermEvent, TermShell } from "./guestagent"
import { TERM_PROTOCOL, TERM_SHELLS, TERM_TOKEN_PREFIX } from "./guestagent"
import { pathsFor } from "./paths"
import * as qemu from "./qemu"

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const TERMINAL_USAGE = "usage: winvm terminal [-i name] [--shell pwsh|powershell|cmd] [--cwd PATH] [--connect --json] | --shells [--json]"

/**
 * One cmd.exe line that prints the name of each shell the guest has, a line
 * each. PowerShell 7 is looked for where termShellArgv (guestagent.ts) looks:
 * its install folder, then PATH.
 */
const SHELLS_PROBE = [
  '(if exist "%ProgramFiles%\\PowerShell\\7\\pwsh.exe" (echo pwsh) else (where /q pwsh.exe && echo pwsh))',
  '(if exist "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" echo powershell)',
  '(if exist "%SystemRoot%\\System32\\cmd.exe" echo cmd)',
].join(" & ")

/** The probe as the agent's exec runs it: verbatim, so cmd.exe sees its quotes as written. */
export const shellsProbeArgv = (): string[] => ["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", `"${SHELLS_PROBE}"`]

/** Which shells the probe found. */
export function parseShells(stdout: string): Record<TermShell, boolean> {
  const found = new Set(stdout.split(/\r?\n/).map((l) => l.trim()))
  return Object.fromEntries(TERM_SHELLS.map((s) => [s, found.has(s)])) as Record<TermShell, boolean>
}

/** The terminal's WebSocket URL on the host end of the agent's forward. */
export function termUrl(hostPort: number, o: { readonly shell: TermShell; readonly cwd?: string | null; readonly cols?: number; readonly rows?: number }): string {
  const q = new URLSearchParams({ shell: o.shell })
  if (o.cwd !== undefined && o.cwd !== null && o.cwd !== "") q.set("cwd", o.cwd)
  if (o.cols !== undefined) q.set("cols", String(o.cols))
  if (o.rows !== undefined) q.set("rows", String(o.rows))
  return `ws://127.0.0.1:${String(hostPort)}/term?${q.toString()}`
}

/** The subprotocols a client offers: ours, and the token. */
export const termClientProtocols = (token: string): string[] => [TERM_PROTOCOL, `${TERM_TOKEN_PREFIX}${token}`]

/** `--shell`, checked; pwsh when absent. */
export function shellFlag(args: Args): TermShell {
  const s = args.flags.get("shell") ?? "pwsh"
  if (!(TERM_SHELLS as readonly string[]).includes(s)) throw new Error(`--shell must be one of ${TERM_SHELLS.join(", ")}, got "${s}"`)
  return s as TermShell
}

/** A text frame from the agent, or null if it is not one we know. */
function termEvent(text: string): TermEvent | null {
  try {
    const m = JSON.parse(text) as Partial<{ type: string; code: number; message: string }>
    if (m.type === "exit" && typeof m.code === "number") return { type: "exit", code: m.code }
    if (m.type === "error" && typeof m.message === "string") return { type: "error", message: m.message }
  } catch {
    // not JSON
  }
  return null
}

export async function terminal(args: Args): Promise<number> {
  const name = instanceName(args)
  let shell: TermShell
  try {
    shell = shellFlag(args)
  } catch (error) {
    return fail(`${msg(error)}\n${TERMINAL_USAGE}`)
  }
  const cwd = args.flags.get("cwd") ?? null
  if (cwd === "true") return fail(`--cwd needs a path\n${TERMINAL_USAGE}`)
  if (!qemu.isRunning(pathsFor(name))) return fail(`instance "${name}" is not running — \`winvm start -i ${name}\``)
  let hostPort: number
  let token: string
  let client: agent.AgentClient
  try {
    // Current, not just answering: an image with an older agent baked in has no terminals.
    const c = await agent.ensure(name, { log: (l) => console.error(l) })
    await c.health()
    client = c
    const s = agent.readState(pathsFor(name))
    if (s === null || s.hostPort === null) throw new Error("the agent has no host port")
    hostPort = s.hostPort
    token = s.token
  } catch (error) {
    return fail(`could not reach the agent in "${name}": ${msg(error)}`)
  }

  if (args.flags.has("shells")) {
    let shells: Record<TermShell, boolean>
    try {
      const r = await client.exec(shellsProbeArgv(), { verbatim: true, timeoutMs: 15_000 })
      if (r.stdout.trim() === "") throw new Error(r.stderr.trim() || `the check exited with ${String(r.code)}`)
      shells = parseShells(r.stdout)
    } catch (error) {
      return fail(`could not check the shells in "${name}": ${msg(error)}`)
    }
    if (args.flags.has("json")) console.log(JSON.stringify(shells))
    else for (const s of TERM_SHELLS) console.log(`${s.padEnd(12)}${shells[s] ? "installed" : "not installed"}`)
    return 0
  }

  if (args.flags.has("connect")) {
    const info = { url: termUrl(hostPort, { shell, cwd }), protocols: termClientProtocols(token) }
    console.log(args.flags.has("json") ? JSON.stringify(info) : `${info.url}\nprotocols: ${info.protocols.join(", ")}`)
    return 0
  }
  return await relay(termUrl(hostPort, { shell, cwd, ...size() }), token)
}

/** This terminal's size, when it has one: a pty nobody sized reports 0x0, which the agent refuses. */
const size = (): { cols?: number; rows?: number } =>
  process.stdout.isTTY && process.stdout.columns > 0 && process.stdout.rows > 0 ? { cols: process.stdout.columns, rows: process.stdout.rows } : {}

/**
 * This terminal <-> the guest's, until the shell exits: raw mode on a TTY (every
 * key goes to the guest, Ctrl-C included), resizes on SIGWINCH, and the
 * terminal put back however it ends. Exits with the shell's exit code.
 */
async function relay(url: string, token: string): Promise<number> {
  const tty = process.stdin.isTTY
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  ws.binaryType = "arraybuffer"
  let code: number | null = null
  let error: string | null = null

  const onInput = (chunk: Buffer): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
  }
  const onResize = (): void => {
    const s = size()
    if (s.cols !== undefined && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", ...s }))
  }
  const restore = (): void => {
    process.stdin.off("data", onInput)
    process.off("SIGWINCH", onResize)
    for (const sig of ["SIGTERM", "SIGHUP"] as const) process.off(sig, onSignal)
    if (tty) process.stdin.setRawMode(false)
    process.stdin.pause()
  }
  // Killed rather than finished: still give the terminal back (closing the socket ends the guest's shell).
  function onSignal(): void {
    restore()
    ws.close()
    process.exit(1)
  }

  await new Promise<void>((done) => {
    ws.onopen = () => {
      if (tty) process.stdin.setRawMode(true)
      process.stdin.on("data", onInput)
      process.stdin.resume()
      process.on("SIGWINCH", onResize)
      for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, onSignal)
    }
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") {
        process.stdout.write(new Uint8Array(e.data as ArrayBuffer))
        return
      }
      const ev = termEvent(e.data)
      if (ev?.type === "exit") code = ev.code
      if (ev?.type === "error") error = ev.message
    }
    ws.onerror = () => {
      error ??= "the connection to the agent failed"
    }
    ws.onclose = () => {
      done()
    }
  })
  restore()
  if (code !== null) return code
  return fail(error ?? "the terminal closed")
}
