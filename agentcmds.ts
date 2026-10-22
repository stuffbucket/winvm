/**
 * The agent's verbs: `agent install|status`, `put`, `get`, `launch` — and the
 * agent-first `exec` that commands.ts calls. Each uses the in-guest agent when
 * one answers and falls back to qemu-ga, so they work on any running guest;
 * the agent only makes them fast (and puts launched programs on the desktop).
 *
 * Note the two channels run as different users: the agent as the logged-on
 * Administrator in session 1, qemu-ga as SYSTEM in session 0. `--qga` forces
 * the old path.
 */
import { statSync } from "node:fs"

import * as agent from "./agent"
import type { Args } from "./args"
import { instanceName } from "./args"
import { pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as watcher from "./watch"

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The agent, unless `--qga` or none answers quickly. */
async function preferred(name: string, args: Args): Promise<agent.AgentClient | null> {
  if (args.flags.has("qga") || process.env["WINVM_NO_AGENT"] === "1") return null
  return await agent.connect(name, { timeoutMs: 1500 })
}

/** `exec`'s engine: through the agent when there is one, else qemu-ga. Same result shape as qga.exec. */
export async function exec(name: string, args: Args, program: string, rest: readonly string[]): Promise<qga.ExecResult> {
  const c = await preferred(name, args)
  if (c === null) return await qga.exec(pathsFor(name).qga, program, rest)
  const r = await c.exec([program, ...rest], { timeoutMs: 900_000 })
  if (r.timedOut) throw new Error("guest command timed out")
  return { exitcode: r.code, stdout: r.stdout, stderr: r.stderr }
}

/** Read a guest file over qemu-ga, for when there is no agent. */
async function qgaReadFile(sock: string, guestPath: string): Promise<Uint8Array> {
  const open = await qga.call(sock, { execute: "guest-file-open", arguments: { path: guestPath, mode: "rb" } })
  const handle = open["return"]
  if (typeof handle !== "number") throw new Error(`guest-file-open ${guestPath}: ${JSON.stringify(open["error"] ?? open)}`)
  const parts: Buffer[] = []
  try {
    for (;;) {
      const r = (await qga.call(sock, { execute: "guest-file-read", arguments: { handle, count: 4 * 1024 * 1024 } }))["return"] as
        | { "buf-b64"?: string; eof?: boolean }
        | undefined
      if (r === undefined) throw new Error(`guest-file-read ${guestPath} failed`)
      parts.push(Buffer.from(r["buf-b64"] ?? "", "base64"))
      if (r.eof === true) break
    }
  } finally {
    await qga.call(sock, { execute: "guest-file-close", arguments: { handle } })
  }
  return new Uint8Array(Buffer.concat(parts))
}

/**
 * Positional arguments, giving back one `--qga` swallowed: the parser reads
 * `--qga C:\x` as a flag with a value.
 */
function positionals(args: Args): readonly string[] {
  const v = args.flags.get("qga")
  return v === undefined || v === "true" ? args.positional : [v, ...args.positional]
}

function running(name: string): string | null {
  return qemu.isRunning(pathsFor(name)) ? null : `instance "${name}" is not running — \`winvm start -i ${name}\``
}

export async function put(args: Args): Promise<number> {
  const name = instanceName(args)
  const [from, to] = positionals(args)
  if (from === undefined || to === undefined) return fail("usage: winvm put [-i name] <host file> <guest path>")
  const notUp = running(name)
  if (notUp !== null) return fail(notUp)
  const t0 = performance.now()
  try {
    const c = await preferred(name, args)
    const bytes = statSync(from).size
    await watcher.whileActive<unknown>(
      name,
      c === null ? agent.qgaWriteFile(pathsFor(name).qga, to, new Uint8Array(await Bun.file(from).arrayBuffer())) : c.putFile(from, to),
    )
    console.log(`${from} -> ${to}: ${String(bytes)} bytes in ${(performance.now() - t0).toFixed(0)} ms (${c === null ? "qemu-ga" : "agent"})`)
    return 0
  } catch (error) {
    return fail(msg(error))
  }
}

export async function get(args: Args): Promise<number> {
  const name = instanceName(args)
  const [from, to] = positionals(args)
  if (from === undefined || to === undefined) return fail("usage: winvm get [-i name] <guest path> <host file>")
  const notUp = running(name)
  if (notUp !== null) return fail(notUp)
  const t0 = performance.now()
  try {
    const c = await preferred(name, args)
    const bytes = await watcher.whileActive(
      name,
      c === null ? qgaReadFile(pathsFor(name).qga, from).then(async (b) => await Bun.write(to, b)) : c.getFile(from, to),
    )
    console.log(`${from} -> ${to}: ${String(bytes)} bytes in ${(performance.now() - t0).toFixed(0)} ms (${c === null ? "qemu-ga" : "agent"})`)
    return 0
  } catch (error) {
    return fail(msg(error))
  }
}

/** Start a program on the guest's desktop and return at once. */
export async function launch(args: Args): Promise<number> {
  const name = instanceName(args)
  const argv = args.rest.length > 0 ? args.rest : positionals(args)
  if (argv.length === 0) return fail("usage: winvm launch [-i name] -- <program> [args...]")
  const notUp = running(name)
  if (notUp !== null) return fail(notUp)
  watcher.touchActivity(name)
  try {
    const c = await preferred(name, args)
    if (c !== null) {
      console.log(`pid ${String((await c.launch(argv)).pid)}`)
      return 0
    }
    // No agent: the session launcher the install left behind, over qemu-ga.
    const r = await agent.qgaLaunch(name, argv)
    if (r.exitcode !== 0) return fail(`could not launch in the user's session: ${(r.stderr || r.stdout).trim()}`)
    console.log(r.stdout.trim())
    return 0
  } catch (error) {
    return fail(msg(error))
  }
}

/** `agent install|status`. */
export async function agentCmd(args: Args): Promise<number> {
  const name = instanceName(args)
  const sub = args.positional[0] ?? "status"
  const p = pathsFor(name)
  if (sub === "install") {
    const notUp = running(name)
    if (notUp !== null) return fail(notUp)
    try {
      await watcher.whileActive(name, agent.install(name, { log: (l) => console.log(l) }))
      return 0
    } catch (error) {
      return fail(msg(error))
    }
  }
  if (sub === "status") {
    const s = agent.readState(p)
    const c = s === null ? null : await agent.connect(name, { timeoutMs: 3000 })
    const health = c === null ? null : await c.health().catch(() => null)
    if (args.flags.has("json")) {
      console.log(JSON.stringify({ instance: name, installed: s !== null, hostPort: s?.hostPort ?? null, health }, null, 2))
      return health === null ? 1 : 0
    }
    if (s === null) {
      console.log(`instance "${name}": no agent — \`winvm agent install -i ${name}\``)
      return 1
    }
    if (health === null) {
      console.log(`instance "${name}": agent not answering on 127.0.0.1:${String(s.hostPort)}${qemu.isRunning(p) ? "" : " (instance not running)"}`)
      return 1
    }
    console.log(
      `instance "${name}": agent v${String(health.version)} pid ${String(health.pid)} ${health.arch} session ${String(health.session)}, ` +
        `127.0.0.1:${String(s.hostPort)} -> guest :${String(agent.GUEST_PORT)}, up ${(health.uptimeMs / 1000).toFixed(0)} s`,
    )
    return 0
  }
  return fail("usage: winvm agent [-i name] install | status [--json]")
}
