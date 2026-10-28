/**
 * The agent's verbs: `agent install|status`, `put`, `get`, `dir`, `launch` — and the
 * agent-first `exec` that commands.ts calls. Each uses the in-guest agent when
 * one answers and falls back to qemu-ga, so they work on any running guest;
 * the agent only makes them fast (and puts launched programs on the desktop).
 *
 * Note the two channels run as different users: the agent as the logged-on
 * Administrator in session 1, qemu-ga as SYSTEM in session 0. `--qga` forces
 * the old path.
 */
import { mkdirSync, readdirSync, statSync } from "node:fs"
import { join, win32 } from "node:path"

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

/** `exec`'s deadline: `--timeout S`, default 15 minutes. */
export function execTimeoutMs(args: Args): number {
  const s = Number(args.flags.get("timeout") ?? 900)
  if (!Number.isFinite(s) || s <= 0) throw new Error(`--timeout wants seconds, got "${args.flags.get("timeout") ?? ""}"`)
  return s * 1000
}

/** Exit code for a command killed at its deadline, as timeout(1) uses. */
export const TIMED_OUT = 124

/** `exec`'s engine: through the agent when there is one, else qemu-ga. Same result shape as qga.exec. */
export async function exec(name: string, args: Args, program: string, rest: readonly string[]): Promise<qga.ExecResult> {
  const timeoutMs = execTimeoutMs(args)
  const c = await preferred(name, args)
  if (c === null) return await qga.exec(pathsFor(name).qga, program, rest, timeoutMs)
  return execResult(await c.exec([program, ...rest], { timeoutMs }), timeoutMs)
}

/**
 * The agent's answer as qga.exec's result. A command the agent killed at its
 * deadline (with its tree) exits TIMED_OUT, and what it printed until then
 * still comes back: it is often the only clue to why it hung.
 */
export function execResult(r: agent.ExecResponse, timeoutMs: number): qga.ExecResult {
  if (!r.timedOut) return { exitcode: r.code, stdout: r.stdout, stderr: r.stderr }
  const sep = r.stderr === "" || r.stderr.endsWith("\n") ? "" : "\n"
  return {
    exitcode: TIMED_OUT,
    stdout: r.stdout,
    stderr: `${r.stderr}${sep}::error::guest command timed out after ${String(timeoutMs / 1000)} s and was killed with its process tree\n`,
  }
}

/** Read a guest file over qemu-ga, for when there is no agent. */
async function qgaReadFile(sock: string, guestPath: string): Promise<Uint8Array> {
  // Chunked to fit what the agent can answer — see qga.READ_CHUNK.
  const bytes = await qga.readFile(sock, guestPath)
  if (bytes === null) throw new Error(`guest-file-open ${guestPath} failed`)
  return new Uint8Array(bytes)
}

/**
 * Positional arguments, giving back what a value-less flag swallowed: the
 * parser reads `--qga C:\x` as a flag with a value.
 */
function positionals(args: Args, bare: readonly string[] = ["qga"]): readonly string[] {
  const swallowed = bare.map((f) => args.flags.get(f)).filter((v) => v !== undefined && v !== "true") as string[]
  return [...swallowed, ...args.positional]
}

function running(name: string): string | null {
  return qemu.isRunning(pathsFor(name)) ? null : `instance "${name}" is not running — \`winvm start -i ${name}\``
}

export async function put(args: Args): Promise<number> {
  const name = instanceName(args)
  const [from, to] = positionals(args)
  if (from === undefined || to === undefined) return fail("usage: winvm put [-i name] <host file or folder> <guest path>")
  const notUp = running(name)
  if (notUp !== null) return fail(notUp)
  const t0 = performance.now()
  try {
    const c = await preferred(name, args)
    if (statSync(from).isDirectory()) {
      if (c === null) return fail("copying a folder needs the in-guest agent — `winvm agent install`")
      const got = await watcher.whileActive(name, putTree(c, from, to))
      console.log(`${from} -> ${to}: ${String(got.files)} files, ${String(got.bytes)} bytes in ${(performance.now() - t0).toFixed(0)} ms (agent)`)
      return 0
    }
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

/** Copy a host folder's files, at any depth, under the guest folder `to` (the agent creates folders as it writes). */
export async function putTree(c: Pick<agent.AgentClient, "putFile">, from: string, to: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const rel of readdirSync(from, { recursive: true, encoding: "utf8" })) {
    const src = join(from, rel)
    if (!statSync(src).isFile()) continue
    bytes += (await c.putFile(src, win32.join(to, ...rel.split("/")))).bytes
    files += 1
  }
  return { files, bytes }
}

export async function get(args: Args): Promise<number> {
  const name = instanceName(args)
  const [from, to] = positionals(args)
  if (from === undefined || to === undefined) return fail("usage: winvm get [-i name] <guest file or folder> <host path>")
  const notUp = running(name)
  if (notUp !== null) return fail(notUp)
  const t0 = performance.now()
  try {
    const c = await preferred(name, args)
    const tree = c === null ? null : await folderOf(c, from)
    if (c !== null && tree !== null) {
      const got = await watcher.whileActive(name, getTree(c, tree, to))
      console.log(`${from} -> ${to}: ${String(got.files)} files, ${String(got.bytes)} bytes in ${(performance.now() - t0).toFixed(0)} ms (agent)`)
      return 0
    }
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

/** A guest folder's listing (everything in it), or null when `path` is not a folder or this agent cannot list. */
export async function folderOf(c: Pick<agent.AgentClient, "list">, path: string): Promise<agent.DirListing | null> {
  try {
    return await c.list(path, { hidden: true, limit: FOLDER_LIMIT })
  } catch (error) {
    if (error instanceof agent.AgentError && error.code !== "denied") return null
    throw error
  }
}

/** The most entries one folder may have for `get` to copy it. */
const FOLDER_LIMIT = 100_000

/** Copy a guest folder and everything in it to the host folder `to`, which it creates. */
export async function getTree(c: Pick<agent.AgentClient, "list" | "getFile">, l: agent.DirListing, to: string): Promise<{ files: number; bytes: number }> {
  if (l.total > l.entries.length) throw new Error(`${l.path} holds more than ${String(FOLDER_LIMIT)} entries`)
  mkdirSync(to, { recursive: true })
  let files = 0
  let bytes = 0
  for (const e of l.entries) {
    const from = win32.join(l.path, e.name)
    if (e.dir) {
      const sub = await getTree(c, await c.list(from, { hidden: true, limit: FOLDER_LIMIT }), join(to, e.name))
      files += sub.files
      bytes += sub.bytes
    } else {
      bytes += await c.getFile(from, join(to, e.name))
      files += 1
    }
  }
  return { files, bytes }
}

const pad2 = (n: number): string => String(n).padStart(2, "0")
const stamp = (ms: number | null): string => {
  if (ms === null) return "                "
  const d = new Date(ms)
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `dir`'s text: the folder, then a line per entry as Windows' own `dir` lays them out. */
export function formatListing(l: agent.DirListing): string {
  const lines = [l.path]
  for (const e of l.entries) {
    const size = e.dir ? "<DIR>" : e.size === null ? "?" : e.size.toLocaleString("en-US")
    lines.push(`  ${stamp(e.modified)}  ${size.padStart(15)}  ${e.name}`)
  }
  if (l.entries.length === 0) lines.push("  (empty)")
  if (l.total > l.entries.length) lines.push(`  … ${String(l.total - l.entries.length)} more (--limit N)`)
  return lines.join("\n")
}

/** `dir --places`: the known folders. */
export const formatPlaces = (l: agent.DirListing): string => l.places.map((p) => `  ${p.kind.padEnd(10)} ${p.path}`).join("\n")

/**
 * `dir [-i name] [path] [--all] [--places] [--limit N] [--json]`: a guest
 * folder (default the Desktop) through the agent. With `--json`, a failure is
 * `{error, code}` on stdout too (code: notfound, denied, notdir, notrunning).
 */
export async function dir(args: Args): Promise<number> {
  const name = instanceName(args)
  const json = args.flags.has("json")
  const [path] = positionals(args, ["json", "all", "places"])
  const failed = (error: string, code: string | null): number => {
    if (!json) return fail(error)
    console.log(JSON.stringify({ error, code }))
    return 1
  }
  const notUp = running(name)
  if (notUp !== null) return failed(notUp, "notrunning")
  const limit = args.flags.get("limit")
  try {
    // ensure, not connect: an image with an older agent baked in gets this one, which lists.
    const c = await agent.ensure(name)
    const l = await c.list(path ?? "", { hidden: args.flags.has("all"), ...(limit === undefined ? {} : { limit: Number(limit) }) })
    console.log(json ? JSON.stringify(l) : args.flags.has("places") ? formatPlaces(l) : formatListing(l))
    return 0
  } catch (error) {
    return failed(msg(error), error instanceof agent.AgentError ? error.code : null)
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
