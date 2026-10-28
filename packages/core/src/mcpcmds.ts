/**
 * `winvm mcp …`: serve the guest over MCP (mcp.ts), and add that server to
 * Claude Code and Claude Desktop.
 *
 *   winvm mcp [-i name]                                       the stdio server
 *   winvm mcp install   claude-code|claude-desktop [-i name] [--json]
 *   winvm mcp uninstall claude-code|claude-desktop [-i name] [--json]
 *   winvm mcp status    [-i name] [--json]
 *
 * The server is named `winvm-<instance>` in both clients.
 *
 * CLAUDE CODE: `claude mcp add -s user winvm-<instance> -- <winvm> mcp -i <instance>`,
 * so it is there in every project. Its user-scope servers live in ~/.claude.json
 * (or $CLAUDE_CONFIG_DIR/.claude.json), which `status` reads rather than asking
 * `claude mcp get`, which starts the server to check it.
 *
 * CLAUDE DESKTOP: its `mcpServers` in ~/Library/Application Support/Claude/
 * claude_desktop_config.json (WINVM_CLAUDE_DESKTOP_CONFIG overrides, for tests).
 * Edited in place: a timestamped backup first, every other key kept, written
 * to a temporary file and renamed over it. Desktop reads it at launch.
 *
 * THE COMMAND written is one that keeps working: the app's bundled CLI
 * (…/winvm.app/Contents/MacOS/winvm) when this runs from the app, else the
 * resolved path of the CLI that is running (with Bun, from a source checkout).
 * WINVM_HOME and WINVM_RUNTIME go along when they are set.
 */
import { copyFileSync, existsSync, fsyncSync, closeSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"

import type { Args } from "./args"
import { instanceName } from "./args"
import * as mcp from "./mcp"
import { cliEntry, readMeta } from "./paths"

export const USAGE =
  "usage: winvm mcp [-i name]                       the MCP server on stdio (what Claude starts)\n" +
  "       winvm mcp install claude-code|claude-desktop [-i name] [--json]\n" +
  "       winvm mcp uninstall claude-code|claude-desktop [-i name] [--json]\n" +
  "       winvm mcp status [-i name] [--json]"

export const CLIENTS = ["claude-code", "claude-desktop"] as const
export type ClientId = (typeof CLIENTS)[number]
const CLIENT_NAMES: Readonly<Record<ClientId, string>> = { "claude-code": "Claude Code", "claude-desktop": "Claude Desktop" }

export const serverName = (instance: string): string => `winvm-${instance}`

// ---------------------------------------------------------------------------
// The command the clients run

export type From = "app" | "cli" | "source"

export interface Launch {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly from: From
}

const realpath = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * The command line a client should run for `instance`. Compiled: the binary
 * itself (inside an app bundle, "app"). From source: Bun and the CLI script.
 */
export function launchFor(o: {
  readonly compiled: boolean
  readonly execPath: string
  readonly entry: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly instance: string
}): Launch {
  const env: Record<string, string> = {}
  for (const k of ["WINVM_HOME", "WINVM_RUNTIME"]) {
    const v = o.env[k]
    if (v !== undefined && v !== "") env[k] = resolve(v)
  }
  const tail = ["mcp", "-i", o.instance]
  if (o.compiled) {
    return { command: o.execPath, args: tail, env, from: /\.app\/Contents\/MacOS\/[^/]+$/.test(o.execPath) ? "app" : "cli" }
  }
  return { command: o.execPath, args: [o.entry, ...tail], env, from: "source" }
}

export function launch(instance: string): Launch {
  const compiled = import.meta.path.startsWith("/$bunfs/")
  return launchFor({ compiled, execPath: realpath(process.execPath), entry: compiled ? "" : realpath(cliEntry()), env: process.env, instance })
}

const FROM_NOTE: Readonly<Record<From, string>> = {
  app: "the winvm app's own CLI",
  cli: "this winvm CLI",
  source: "Bun running this source checkout",
}

const commandLine = (l: Launch): string => [l.command, ...l.args].map((a) => (/[\s"'\\$]/.test(a) ? JSON.stringify(a) : a)).join(" ")

// ---------------------------------------------------------------------------
// JSON files: read, edit, write safely

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v)

/** A JSON object file; {} when it is missing. Throws on anything that isn't a JSON object. */
export function readJsonObject(file: string): Json {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, "utf8")
  if (text.trim() === "") return {}
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error(`${file} isn't valid JSON, so winvm left it alone. Fix it (or move it aside) and try again.`)
  }
  if (!isObject(v)) throw new Error(`${file} doesn't hold a JSON object, so winvm left it alone.`)
  return v
}

const pad = (x: number): string => String(x).padStart(2, "0")
const stamp = (d: Date): string =>
  `${String(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/**
 * Change a JSON object file through `edit`, which returns false when there is
 * nothing to change. A changed file is backed up first (beside it, timestamped)
 * and replaced atomically; a symlinked file is written through to its target.
 */
export function editJsonFile(file: string, edit: (o: Json) => boolean, now = new Date()): { changed: boolean; backup: string | null } {
  const target = existsSync(file) ? realpath(file) : file
  const o = readJsonObject(target)
  if (!edit(o)) return { changed: false, backup: null }
  let backup: string | null = null
  let mode = 0o644
  if (existsSync(target)) {
    mode = statSync(target).mode & 0o777
    backup = `${target}.winvm-backup-${stamp(now)}`
    for (let i = 2; existsSync(backup); i += 1) backup = `${target}.winvm-backup-${stamp(now)}-${String(i)}`
    copyFileSync(target, backup)
  }
  const tmp = join(dirname(target), `.${basename(target)}.winvm-${String(process.pid)}.tmp`)
  try {
    const fd = openSync(tmp, "w", mode)
    try {
      writeSync(fd, `${JSON.stringify(o, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  return { changed: true, backup }
}

/** What a client's config holds for one server. */
export interface Entry {
  readonly command?: unknown
  readonly args?: unknown
  readonly env?: unknown
}

/** Does a client's entry run exactly `l`? */
export function entryMatches(e: Entry | undefined, l: Launch): boolean {
  if (e === undefined) return false
  const env = isObject(e.env) ? e.env : {}
  return (
    e.command === l.command &&
    JSON.stringify(e.args ?? []) === JSON.stringify(l.args) &&
    JSON.stringify(Object.entries(env).sort()) === JSON.stringify(Object.entries(l.env).sort())
  )
}

const servers = (o: Json): Json => (isObject(o["mcpServers"]) ? o["mcpServers"] : {})

// ---------------------------------------------------------------------------
// Claude Desktop

export const desktopConfigPath = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  env["WINVM_CLAUDE_DESKTOP_CONFIG"] ?? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")

const desktopAvailable = (config: string): boolean =>
  existsSync(dirname(config)) || existsSync("/Applications/Claude.app") || existsSync(join(homedir(), "Applications", "Claude.app"))

/** Add (or update) the server in Claude Desktop's config file. */
export function desktopInstall(config: string, name: string, l: Launch, now = new Date()): { changed: boolean; backup: string | null } {
  return editJsonFile(
    config,
    (o) => {
      const s = servers(o)
      if (entryMatches(s[name] as Entry | undefined, l)) return false
      s[name] = { command: l.command, args: [...l.args], ...(Object.keys(l.env).length > 0 ? { env: { ...l.env } } : {}) }
      o["mcpServers"] = s
      return true
    },
    now,
  )
}

export function desktopUninstall(config: string, name: string, now = new Date()): { changed: boolean; backup: string | null } {
  if (!existsSync(config)) return { changed: false, backup: null }
  return editJsonFile(
    config,
    (o) => {
      const s = servers(o)
      if (!Object.hasOwn(s, name)) return false
      delete s[name]
      o["mcpServers"] = s
      return true
    },
    now,
  )
}

// ---------------------------------------------------------------------------
// Claude Code

export const codeConfigPath = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const dir = env["CLAUDE_CONFIG_DIR"]
  return dir !== undefined && dir !== "" ? join(dir, ".claude.json") : join(env["HOME"] ?? homedir(), ".claude.json")
}

/**
 * The `claude` command: WINVM_CLAUDE, else on PATH, else where its installers
 * put it. The app's CLI runs with launchd's bare PATH, hence the list.
 */
export function findClaude(env: Readonly<Record<string, string | undefined>> = process.env, exists: (p: string) => boolean = isExecutable): string | null {
  const own = env["WINVM_CLAUDE"]
  if (own !== undefined && own !== "") return exists(own) ? own : null
  const home = env["HOME"] ?? homedir()
  const dirs = [
    ...(env["PATH"] ?? "").split(delimiter),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
  ]
  for (const d of dirs) {
    if (d === "") continue
    const p = join(d, "claude")
    if (exists(p)) return p
  }
  return null
}

function isExecutable(p: string): boolean {
  try {
    const s = statSync(p)
    return s.isFile() && (s.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type Runner = (argv: readonly string[]) => Ran

/** Run `claude …`, with its own folder and the usual tool folders on PATH (an npm install is a node script). */
export function runnerFor(claude: string, env: Readonly<Record<string, string | undefined>> = process.env): Runner {
  const path = [dirname(claude), ...(env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"].join(delimiter)
  return (argv) => {
    const r = Bun.spawnSync([claude, ...argv], { env: { ...env, PATH: path }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  }
}

export const entryIn = (config: string, name: string): Entry | undefined => {
  try {
    return servers(readJsonObject(config))[name] as Entry | undefined
  } catch {
    return undefined
  }
}

/** `claude mcp add` for the user scope; an entry that runs something else is replaced. */
export function codeInstall(run: Runner, config: string, name: string, l: Launch): { changed: boolean } {
  const have = entryIn(config, name)
  if (entryMatches(have, l)) return { changed: false }
  if (have !== undefined) {
    const r = run(["mcp", "remove", "-s", "user", name])
    if (r.code !== 0) throw new Error(`claude mcp remove failed: ${(r.stderr || r.stdout).trim()}`)
  }
  const env = Object.entries(l.env).flatMap(([k, v]) => ["-e", `${k}=${v}`])
  const r = run(["mcp", "add", "-s", "user", name, ...env, "--", l.command, ...l.args])
  if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim()}`)
  return { changed: true }
}

export function codeUninstall(run: Runner, config: string, name: string): { changed: boolean } {
  if (entryIn(config, name) === undefined) return { changed: false }
  const r = run(["mcp", "remove", "-s", "user", name])
  if (r.code !== 0) throw new Error(`claude mcp remove failed: ${(r.stderr || r.stdout).trim()}`)
  return { changed: true }
}

// ---------------------------------------------------------------------------
// Commands

export interface ClientStatus {
  readonly id: ClientId
  readonly name: string
  /** The client is on this Mac. */
  readonly available: boolean
  /** It has a server named winvm-<instance>. */
  readonly added: boolean
  /** …and that server runs what install would write now. */
  readonly current: boolean
  readonly config: string
}

export function clientStatus(id: ClientId, instance: string, l: Launch, env: Readonly<Record<string, string | undefined>> = process.env): ClientStatus {
  const name = serverName(instance)
  if (id === "claude-code") {
    const config = codeConfigPath(env)
    const e = entryIn(config, name)
    return { id, name: CLIENT_NAMES[id], available: findClaude(env) !== null, added: e !== undefined, current: entryMatches(e, l), config }
  }
  const config = desktopConfigPath(env)
  const e = entryIn(config, name)
  return { id, name: CLIENT_NAMES[id], available: desktopAvailable(config), added: e !== undefined, current: entryMatches(e, l), config }
}

/** Positional arguments, giving back one `--json` swallowed as its value. */
function positionals(args: Args): readonly string[] {
  const v = args.flags.get("json")
  return v !== undefined && v !== "true" ? [...args.positional, v] : args.positional
}

function report(json: boolean, body: Json, text: string): number {
  console.log(json ? JSON.stringify(body) : text)
  return 0
}

function failed(json: boolean, error: string): number {
  if (json) console.log(JSON.stringify({ ok: false, error }))
  else console.error(`::error::${error}`)
  return 1
}

async function change(args: Args, verb: "install" | "uninstall"): Promise<number> {
  const json = args.flags.has("json")
  const client = positionals(args)[1]
  if (client === undefined || !(CLIENTS as readonly string[]).includes(client)) return failed(json, `say which: winvm mcp ${verb} claude-code|claude-desktop [-i name]`)
  const id = client as ClientId
  const instance = instanceName(args)
  if (verb === "install" && readMeta(instance) === null) return failed(json, `there is no winvm instance named "${instance}"`)
  const name = serverName(instance)
  const l = launch(instance)
  try {
    let changed: boolean
    let backup: string | null = null
    let config: string
    if (id === "claude-code") {
      const claude = findClaude()
      config = codeConfigPath()
      if (claude === null) {
        if (verb === "uninstall" && entryIn(config, name) === undefined) return report(json, { ok: true, client: id, server: name, changed: false, config, backup: null, restart: false }, `${name} isn't in Claude Code`)
        return failed(json, "Claude Code's `claude` command wasn't found. Install Claude Code, or set WINVM_CLAUDE to its path.")
      }
      const run = runnerFor(claude)
      changed = (verb === "install" ? codeInstall(run, config, name, l) : codeUninstall(run, config, name)).changed
    } else {
      config = desktopConfigPath()
      const r = verb === "install" ? desktopInstall(config, name, l) : desktopUninstall(config, name)
      changed = r.changed
      backup = r.backup
    }
    const restart = id === "claude-desktop" && changed
    const body = { ok: true, client: id, server: name, changed, config, backup, restart, command: l.command, args: l.args, env: l.env, from: l.from }
    const who = CLIENT_NAMES[id]
    const lines: string[] = []
    if (verb === "install") {
      lines.push(changed ? `Added ${name} to ${who}${id === "claude-code" ? " (user scope, every project)" : ""}.` : `${name} is already in ${who}.`)
      lines.push(`  runs: ${commandLine(l)}`)
      lines.push(`  (${FROM_NOTE[l.from]}${Object.keys(l.env).length > 0 ? `; with ${Object.keys(l.env).join(", ")}` : ""})`)
    } else {
      lines.push(changed ? `Removed ${name} from ${who}.` : `${name} isn't in ${who}.`)
    }
    lines.push(`  config: ${config}`)
    if (backup !== null) lines.push(`  backup: ${backup}`)
    if (restart) lines.push("Restart Claude Desktop (quit it and open it again) to pick this up.")
    return report(json, body, lines.join("\n"))
  } catch (error) {
    return failed(json, error instanceof Error ? error.message : String(error))
  }
}

function status(args: Args): number {
  const instance = instanceName(args)
  const l = launch(instance)
  const clients = CLIENTS.map((id) => clientStatus(id, instance, l))
  const body = { instance, server: serverName(instance), command: l.command, args: l.args, env: l.env, from: l.from, clients }
  const lines = [`${serverName(instance)} runs: ${commandLine(l)}  (${FROM_NOTE[l.from]})`]
  for (const c of clients) {
    const state = !c.available
      ? "not installed on this Mac"
      : !c.added
        ? `not added; winvm mcp install ${c.id} -i ${instance}`
        : c.current
          ? "added"
          : `added, but runs another winvm; winvm mcp install ${c.id} -i ${instance} updates it`
    lines.push(`  ${c.name.padEnd(15)} ${state}`)
  }
  return report(args.flags.has("json"), body, lines.join("\n"))
}

export async function mcpCmd(args: Args): Promise<number> {
  const verb = positionals(args)[0]
  if (verb === undefined) return await mcp.serve(args)
  if (verb === "install" || verb === "uninstall") return await change(args, verb)
  if (verb === "status") return status(args)
  console.error(USAGE)
  return 2
}
