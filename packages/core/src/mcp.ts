/**
 * `winvm mcp [-i name]`: the guest as an MCP server on stdio, for Claude Code,
 * Claude Desktop and any other MCP client. mcpcmds.ts adds it to those clients.
 *
 * Tools: screenshot, click, double_click, right_click, move, drag, scroll,
 * type, key, find_and_click (UI Automation), find_text (OCR), run, list_files,
 * copy_to_windows, copy_from_windows, status. Every tool takes an optional
 * `instance`; the default is `-i`, else WINVM_INSTANCE, else "default".
 *
 * The screen tools are cua.ts's executor (QMP screendump and input events,
 * screenshots scaled into 1280x800, coordinates in screenshot pixels); the
 * UIA and OCR tools are cuacmds.ts's extras; run and the copies go through the
 * in-guest agent (agent.ts), installed on first use if need be.
 *
 * PROTOCOL. JSON-RPC 2.0, one message per line on stdin/stdout (the MCP stdio
 * transport). Handled: initialize, ping, tools/list, tools/call; notifications
 * are read and ignored. stdout carries protocol messages only: the server
 * sends console.log and friends to stderr while it runs, so nothing a module
 * prints can corrupt the stream.
 *
 * The server stays up whatever the guest does. A tool called on a stopped or
 * missing instance answers with a tool error that says how to start it, and
 * per-instance state is dropped when the instance's QEMU process changes.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { createInterface } from "node:readline"

import workspace from "../../../package.json" with { type: "json" }

import * as agent from "./agent"
import { folderOf, formatListing, getTree, putTree } from "./agentcmds"
import type { Args } from "./args"
import { instanceName } from "./args"
import type { Block, Result } from "./cua"
import { Computer, DEFAULT_BOX } from "./cua"
import { Extras, selectorSchema } from "./cuacmds"
import { listInstances, pathsFor, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as watcher from "./watch"

// ---------------------------------------------------------------------------
// What the tools need from a guest: real ones below, fakes in tests.

/** The executor's surface the tools use (cua.ts's Computer). */
export interface ScreenLike {
  run(action: string, params: Readonly<Record<string, unknown>>): Promise<Result>
  display(): Promise<{ native: { width: number; height: number }; scale: number; size: { width: number; height: number } }>
  close(): void
}

/** The extras' surface (cuacmds.ts's Extras): ui_click and ocr_find. */
export interface ExtrasLike {
  run(action: string, input: Readonly<Record<string, unknown>>): Promise<Result>
}

/** The agent client calls the tools make. */
export type AgentLike = Pick<agent.AgentClient, "exec" | "list" | "putFile" | "getFile" | "pwsh">

export interface Guest {
  readonly name: string
  readonly screen: ScreenLike
  readonly extras: ExtrasLike
  /** The in-guest agent, installed or started if need be. */
  agent(): Promise<AgentLike>
  /** The agent if one answers quickly, else null; never installs. */
  agentIfUp(): Promise<AgentLike | null>
}

export interface Deps {
  /** Why `name` can't be used right now (missing, stopped), or null when it is running. */
  check(name: string): string | null
  /** The guest's tools. Called only after check() said yes. */
  guest(name: string): Guest
  /** Tell the idle watcher the guest is in use for as long as `work` runs. */
  active<T>(name: string, work: Promise<T>): Promise<T>
}

/** Why an instance can't be used, as a sentence that says what to do. */
export function whyNot(name: string, o: { readonly exists: boolean; readonly running: boolean; readonly others: readonly string[] }): string | null {
  if (!o.exists) {
    const have = o.others.length === 0 ? "There are no instances yet." : `Instances: ${o.others.join(", ")}.`
    return `There is no winvm instance named "${name}". ${have} Pass one as \`instance\`.`
  }
  if (!o.running) return `Instance ${name} isn't running; start it with winvm start -i ${name}`
  return null
}

/** The real thing: QMP for the screen, the agent for the rest, one set per QEMU process. */
export function realDeps(): Deps {
  const guests = new Map<string, { pid: string; guest: Guest }>()
  const qemuPid = (name: string): string => {
    try {
      return readFileSync(pathsFor(name).pid, "utf8").trim()
    } catch {
      return ""
    }
  }
  return {
    check: (name) => whyNot(name, { exists: readMeta(name) !== null, running: qemu.isRunning(pathsFor(name)), others: listInstances() }),
    guest: (name) => {
      const pid = qemuPid(name)
      const have = guests.get(name)
      if (have !== undefined && have.pid === pid) return have.guest
      have?.guest.screen.close()
      const screen = new Computer(pathsFor(name), DEFAULT_BOX)
      const guest: Guest = {
        name,
        screen,
        extras: new Extras(name, screen),
        agent: async () => await agent.ensure(name),
        agentIfUp: async () => await agent.connect(name, { timeoutMs: 1500 }),
      }
      guests.set(name, { pid, guest })
      return guest
    },
    active: async (name, work) => await watcher.whileActive(name, work),
  }
}

// ---------------------------------------------------------------------------
// Tools

export type Content = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string }

export interface ToolResult {
  readonly content: readonly Content[]
  readonly isError?: boolean
}

type Schema = Readonly<Record<string, unknown>>

interface ToolDef {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Schema
  readonly annotations: Readonly<Record<string, boolean | string>>
}

const instanceProp = {
  instance: { type: "string", description: "The winvm instance (VM) to use. Leave it out for the one this server was started for." },
} as const

const xy = {
  x: { type: "number", description: "x in the latest screenshot's pixels" },
  y: { type: "number", description: "y in the latest screenshot's pixels" },
} as const

const modifiersProp = {
  modifiers: { type: "string", description: 'Keys to hold during the click, e.g. "shift" or "ctrl+shift"' },
} as const

const obj = (properties: Schema, required: readonly string[] = []): Schema => ({
  type: "object",
  properties: { ...properties, ...instanceProp },
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
})

const looks = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const acts = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const
const changes = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const

export const TOOLS: readonly ToolDef[] = [
  {
    name: "screenshot",
    title: "Take a screenshot",
    description:
      "Take a screenshot of the Windows desktop. Coordinates for click, move, drag and scroll are in this screenshot's pixels " +
      "(large screens are scaled down to fit 1280x800; the result says the scale). Take one first, and again after acting to check the result.",
    inputSchema: obj({}),
    annotations: { title: "Take a screenshot", ...looks },
  },
  {
    name: "click",
    title: "Click",
    description: "Left-click at x,y (screenshot pixels).",
    inputSchema: obj({ ...xy, ...modifiersProp }, ["x", "y"]),
    annotations: { title: "Click", ...acts },
  },
  {
    name: "double_click",
    title: "Double-click",
    description: "Double-click at x,y (screenshot pixels), e.g. to open a file or select a word.",
    inputSchema: obj({ ...xy, ...modifiersProp }, ["x", "y"]),
    annotations: { title: "Double-click", ...acts },
  },
  {
    name: "right_click",
    title: "Right-click",
    description: "Right-click at x,y (screenshot pixels), usually to open a context menu.",
    inputSchema: obj({ ...xy, ...modifiersProp }, ["x", "y"]),
    annotations: { title: "Right-click", ...acts },
  },
  {
    name: "move",
    title: "Move the pointer",
    description: "Move the mouse pointer to x,y (screenshot pixels) without clicking, e.g. to show a tooltip or a hover menu.",
    inputSchema: obj(xy, ["x", "y"]),
    annotations: { title: "Move the pointer", ...acts },
  },
  {
    name: "drag",
    title: "Drag",
    description: "Press the left button at x,y, move to to_x,to_y, and release (screenshot pixels). Drags windows, files, sliders and selections.",
    inputSchema: obj(
      {
        ...xy,
        to_x: { type: "number", description: "Where to release: x" },
        to_y: { type: "number", description: "Where to release: y" },
        ...modifiersProp,
      },
      ["x", "y", "to_x", "to_y"],
    ),
    annotations: { title: "Drag", ...acts },
  },
  {
    name: "scroll",
    title: "Scroll",
    description: "Turn the mouse wheel, over x,y when given (screenshot pixels), else wherever the pointer is.",
    inputSchema: obj(
      {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Wheel notches, 1-100; default 3" },
        x: { type: "number", description: "Optional: x to scroll over" },
        y: { type: "number", description: "Optional: y to scroll over" },
      },
      ["direction"],
    ),
    annotations: { title: "Scroll", ...acts },
  },
  {
    name: "type",
    title: "Type text",
    description:
      "Type text with the keyboard into whatever has focus. US layout, ASCII only. Use \\n for Enter. Click the field first if it might not have focus.",
    inputSchema: obj({ text: { type: "string" } }, ["text"]),
    annotations: { title: "Type text", ...acts },
  },
  {
    name: "key",
    title: "Press keys",
    description:
      'Press a key or a combination, e.g. "Return", "Escape", "Tab", "ctrl+s", "alt+F4", "win+r", "ctrl+alt+delete" ' +
      '("ctrl-alt-delete" works too). Key names follow xdotool: Return, BackSpace, Delete, Page_Down, Up, F5, super (the Windows key).',
    inputSchema: obj(
      { keys: { type: "string", description: 'The key or combination, e.g. "ctrl+c"' }, repeat: { type: "number", description: "Press it this many times, default 1" } },
      ["keys"],
    ),
    annotations: { title: "Press keys", ...acts },
  },
  {
    name: "find_and_click",
    title: "Find and click a control",
    description:
      "Click a button, menu item, link, tab or other control by its accessible name (Windows UI Automation), waiting up to 5 s for it. " +
      "More reliable than clicking pixels when the control has a name. Give at least one of name, nameContains or automationId; " +
      "window narrows the search to one window.",
    inputSchema: obj({ ...selectorSchema, button: { type: "string", enum: ["left", "right", "double"], description: "default left" } }),
    annotations: { title: "Find and click a control", ...acts },
  },
  {
    name: "find_text",
    title: "Find text on the screen",
    description:
      "Find text on the screen by OCR. Returns each matching line with its centre in screenshot pixels, ready to click. " +
      "wait keeps looking for up to that many seconds (max 30), for text that is about to appear.",
    inputSchema: obj(
      { text: { type: "string", description: "The text to find, case-insensitive" }, wait: { type: "number", description: "Seconds to keep looking, default 0" } },
      ["text"],
    ),
    annotations: { title: "Find text on the screen", ...looks },
  },
  {
    name: "run",
    title: "Run a command in Windows",
    description:
      "Run a command in Windows and return its exit code and output. It runs as the logged-on user, without a window; " +
      "use it for files, settings, installs and scripts rather than clicking through the UI. " +
      "shell: powershell (Windows PowerShell, the default), pwsh (PowerShell 7) or cmd. " +
      "A command still running at timeout_seconds (default 120, max 3600) is killed with its child processes.",
    inputSchema: obj(
      {
        command: { type: "string", description: "The command line or script" },
        shell: { type: "string", enum: ["powershell", "pwsh", "cmd"], description: "default powershell" },
        timeout_seconds: { type: "number", description: "Default 120, max 3600" },
        cwd: { type: "string", description: "Working folder in Windows, e.g. C:\\work" },
      },
      ["command"],
    ),
    annotations: { title: "Run a command in Windows", ...changes, openWorldHint: true },
  },
  {
    name: "list_files",
    title: "List a Windows folder",
    description: "List a folder in Windows: names, sizes and dates, folders first. With no path, the Desktop. Known folders are listed too.",
    inputSchema: obj({
      path: { type: "string", description: "A Windows path, e.g. C:\\Users\\Administrator\\Documents; default the Desktop" },
      hidden: { type: "boolean", description: "Include hidden and system files" },
    }),
    annotations: { title: "List a Windows folder", ...looks },
  },
  {
    name: "copy_to_windows",
    title: "Copy from the Mac into Windows",
    description: "Copy a file, or a folder and everything in it, from this Mac into Windows. Folders on the way are created; existing files are replaced.",
    inputSchema: obj(
      {
        mac_path: { type: "string", description: "An absolute path on the Mac (~ allowed)" },
        windows_path: { type: "string", description: "Where it goes in Windows, e.g. C:\\work\\report.docx" },
      },
      ["mac_path", "windows_path"],
    ),
    annotations: { title: "Copy from the Mac into Windows", ...changes },
  },
  {
    name: "copy_from_windows",
    title: "Copy from Windows to the Mac",
    description: "Copy a file, or a folder and everything in it, from Windows to this Mac. Existing files on the Mac are replaced.",
    inputSchema: obj(
      {
        windows_path: { type: "string", description: "A Windows path, e.g. C:\\Users\\Administrator\\Desktop\\notes.txt" },
        mac_path: { type: "string", description: "An absolute path on the Mac (~ allowed)" },
      },
      ["windows_path", "mac_path"],
    ),
    annotations: { title: "Copy from Windows to the Mac", ...changes },
  },
  {
    name: "status",
    title: "Status",
    description: "Whether the Windows VM is running, its screen size and the screenshot size, and its Windows version.",
    inputSchema: obj({}),
    annotations: { title: "Status", ...looks },
  },
]

export class ToolInputError extends Error {}

type Input = Readonly<Record<string, unknown>>

const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) })

function need<T extends "string" | "number" | "boolean">(input: Input, key: string, type: T, required: true): T extends "string" ? string : T extends "number" ? number : boolean
function need<T extends "string" | "number" | "boolean">(input: Input, key: string, type: T, required: false): (T extends "string" ? string : T extends "number" ? number : boolean) | undefined
function need(input: Input, key: string, type: "string" | "number" | "boolean", required: boolean): unknown {
  const v = input[key]
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`${key} is required`)
    return undefined
  }
  if (typeof v !== type || (type === "number" && !Number.isFinite(v))) throw new ToolInputError(`${key} must be a ${type}`)
  return v
}

/** "ctrl-alt-delete" as "ctrl+alt+delete"; anything with a + (or a lone "-") as given. */
export function normalizeKeys(keys: string): string {
  const k = keys.trim()
  if (k.includes("+") || k.length < 3 || !/[^-]-[^-]/.test(k)) return k
  return k.replace(/(?<=[^-])-(?=[^-])/g, "+")
}

/** Long output kept to its start and end, with a note of what was left out. */
export function clip(s: string, max = 40_000): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.25)
  const tail = max - head
  return `${s.slice(0, head)}\n… [${String(s.length - max)} characters left out] …\n${s.slice(s.length - tail)}`
}

/** A Mac path from a tool: absolute, `~` expanded. */
export function macPath(p: string): string {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p
  if (!isAbsolute(expanded)) throw new ToolInputError(`mac_path must be an absolute path (or start with ~), got "${p}"`)
  return resolve(expanded)
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const CMD = "C:\\Windows\\System32\\cmd.exe"

/**
 * The script `run` hands PowerShell. Errors come back as plain text on stderr:
 * with -EncodedCommand and redirected output, Windows PowerShell would write
 * them as CLIXML. A native command's exit code is the run's; an error the
 * script wrote, or threw, makes it 1.
 */
export function psScript(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$global:LASTEXITCODE = 0",
    "$__failed = $false",
    "try {",
    "  & {",
    command,
    "  } 2>&1 | ForEach-Object {",
    "    if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine($_.ToString()); if ($_.FullyQualifiedErrorId -notlike 'NativeCommandError*') { $__failed = $true } } else { $_ }",
    "  } | Out-String -Stream -Width 200",
    "} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "if ($__failed) { exit 1 }",
    "exit 0",
  ].join("\n")
}

/** The argv for `run`, and whether it must reach the program verbatim (cmd's quoting is its own). */
export function shellArgv(shell: string, command: string, pwsh = PWSH): { argv: string[]; verbatim: boolean } {
  if (shell === "cmd") return { argv: [CMD, "/d", "/s", "/c", `"${command}"`], verbatim: true }
  // Encoded, so no quoting can break it.
  const encoded = Buffer.from(psScript(command), "utf16le").toString("base64")
  return { argv: [shell === "pwsh" ? pwsh : POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], verbatim: false }
}

/** cua.ts's content blocks as MCP content. */
export function toContent(blocks: readonly Block[]): Content[] {
  return blocks.map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "image", data: b.source.data, mimeType: b.source.media_type }))
}

const fromResult = (r: Result): ToolResult => ({ content: toContent(r.content), ...(r.isError ? { isError: true } : {}) })

const n = (v: number): string => String(Math.round(v))

/**
 * The tools. One instance of this per server; `call` never throws: bad input,
 * a stopped guest and failures all come back as tool errors.
 */
export class Tools {
  private readonly deps: Deps
  private readonly defaultInstance: string
  /** The screen tools one at a time: QMP takes one client, and the pointer is shared. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(deps: Deps, defaultInstance: string) {
    this.deps = deps
    this.defaultInstance = defaultInstance
  }

  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return await next
  }

  async call(name: string, input: Input): Promise<ToolResult> {
    try {
      const inst = need(input, "instance", "string", false)
      const instance = inst === undefined || inst === "" ? this.defaultInstance : inst
      const why = this.deps.check(instance)
      if (name === "status") return await this.status(instance, why)
      if (why !== null) return textResult(why, true)
      const g = this.deps.guest(instance)
      return await this.deps.active(instance, this.dispatch(g, name, input))
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true)
    }
  }

  private async dispatch(g: Guest, name: string, input: Input): Promise<ToolResult> {
    const screen = async (action: string, params: Input, done: string): Promise<ToolResult> => {
      const r = await this.serial(async () => await g.screen.run(action, params))
      return r.isError ? fromResult(r) : textResult(done)
    }
    const mods = (): Input => {
      const m = need(input, "modifiers", "string", false)
      return m === undefined || m === "" ? {} : { text: m }
    }
    switch (name) {
      case "screenshot":
        return await this.serial(async () => {
          const r = await g.screen.run("screenshot", {})
          if (r.isError) return fromResult(r)
          const d = await g.screen.display()
          const how =
            d.scale < 1
              ? `the screen is ${n(d.native.width)}x${n(d.native.height)}, shown at ${(d.scale * 100).toFixed(0)}% (scale ${d.scale.toFixed(4)})`
              : "full size (scale 1)"
          return {
            content: [
              ...toContent(r.content),
              { type: "text", text: `Screenshot ${n(d.size.width)}x${n(d.size.height)} of ${g.name}: ${how}. Give x and y in this screenshot's pixels.` },
            ],
          }
        })
      case "click":
      case "double_click":
      case "right_click": {
        const x = need(input, "x", "number", true)
        const y = need(input, "y", "number", true)
        const action = name === "click" ? "left_click" : name
        const what = name === "click" ? "Clicked" : name === "double_click" ? "Double-clicked" : "Right-clicked"
        return await screen(action, { coordinate: [x, y], ...mods() }, `${what} at ${n(x)},${n(y)}.`)
      }
      case "move": {
        const x = need(input, "x", "number", true)
        const y = need(input, "y", "number", true)
        return await screen("mouse_move", { coordinate: [x, y] }, `Moved the pointer to ${n(x)},${n(y)}.`)
      }
      case "drag": {
        const from = [need(input, "x", "number", true), need(input, "y", "number", true)]
        const to = [need(input, "to_x", "number", true), need(input, "to_y", "number", true)]
        return await screen("left_click_drag", { start_coordinate: from, coordinate: to, ...mods() }, `Dragged from ${n(from[0] ?? 0)},${n(from[1] ?? 0)} to ${n(to[0] ?? 0)},${n(to[1] ?? 0)}.`)
      }
      case "scroll": {
        const direction = need(input, "direction", "string", true)
        const amount = need(input, "amount", "number", false) ?? 3
        const x = need(input, "x", "number", false)
        const y = need(input, "y", "number", false)
        if ((x === undefined) !== (y === undefined)) throw new ToolInputError("give both x and y, or neither")
        const at = x === undefined || y === undefined ? {} : { coordinate: [x, y] }
        return await screen("scroll", { scroll_direction: direction, scroll_amount: amount, ...at }, `Scrolled ${direction} ${n(amount)}.`)
      }
      case "type": {
        const text = need(input, "text", "string", true)
        return await screen("type", { text }, `Typed ${String(text.length)} character${text.length === 1 ? "" : "s"}.`)
      }
      case "key": {
        const keys = normalizeKeys(need(input, "keys", "string", true))
        const repeat = need(input, "repeat", "number", false)
        return await screen("key", { text: keys, ...(repeat === undefined ? {} : { repeat }) }, `Pressed ${keys}${repeat !== undefined && repeat > 1 ? ` ${n(repeat)} times` : ""}.`)
      }
      case "find_and_click": {
        const sel: Record<string, unknown> = {}
        for (const k of ["name", "nameContains", "window", "controlType", "automationId", "button"]) {
          const v = need(input, k, "string", false)
          if (v !== undefined && v !== "") sel[k] = v
        }
        return fromResult(await this.serial(async () => await g.extras.run("ui_click", sel)))
      }
      case "find_text": {
        const text = need(input, "text", "string", true)
        const wait = need(input, "wait", "number", false)
        return fromResult(await this.serial(async () => await g.extras.run("ocr_find", { text, ...(wait === undefined ? {} : { wait }) })))
      }
      case "run":
        return await this.run(g, input)
      case "list_files": {
        const path = need(input, "path", "string", false) ?? ""
        const hidden = need(input, "hidden", "boolean", false) ?? false
        const c = await g.agent()
        const l = await c.list(path, { hidden, limit: 1000 })
        const places = l.places.length === 0 ? "" : `\n\nKnown folders:\n${l.places.map((p) => `  ${p.kind}: ${p.path}`).join("\n")}`
        return textResult(`${formatListing(l).replace("(--limit N)", "(not shown)")}${places}`)
      }
      case "copy_to_windows": {
        const from = macPath(need(input, "mac_path", "string", true))
        const to = need(input, "windows_path", "string", true)
        if (!existsSync(from)) throw new ToolInputError(`${from} doesn't exist on the Mac`)
        const c = await g.agent()
        if (statSync(from).isDirectory()) {
          const got = await putTree(c, from, to)
          return textResult(`Copied ${from} to ${to} in Windows: ${String(got.files)} files, ${String(got.bytes)} bytes.`)
        }
        const got = await c.putFile(from, to)
        return textResult(`Copied ${from} to ${to} in Windows: ${String(got.bytes)} bytes.`)
      }
      case "copy_from_windows": {
        const from = need(input, "windows_path", "string", true)
        const to = macPath(need(input, "mac_path", "string", true))
        const c = await g.agent()
        const tree = await folderOf(c, from)
        if (tree !== null) {
          const got = await getTree(c, tree, to)
          return textResult(`Copied ${from} from Windows to ${to}: ${String(got.files)} files, ${String(got.bytes)} bytes.`)
        }
        const bytes = await c.getFile(from, to)
        return textResult(`Copied ${from} from Windows to ${to}: ${String(bytes)} bytes.`)
      }
      default:
        throw new ToolInputError(`unknown tool "${name}"`)
    }
  }

  private async run(g: Guest, input: Input): Promise<ToolResult> {
    const command = need(input, "command", "string", true)
    const shell = need(input, "shell", "string", false) ?? "powershell"
    if (!["powershell", "pwsh", "cmd"].includes(shell)) throw new ToolInputError('shell must be "powershell", "pwsh" or "cmd"')
    const seconds = need(input, "timeout_seconds", "number", false) ?? 120
    if (seconds <= 0 || seconds > 3600) throw new ToolInputError("timeout_seconds must be from 1 to 3600")
    const cwd = need(input, "cwd", "string", false)
    const c = await g.agent()
    const opts = { timeoutMs: seconds * 1000, ...(cwd === undefined || cwd === "" ? {} : { cwd }) }
    const missing = (e: unknown): boolean => e instanceof agent.AgentError && /ENOENT|not found|cannot find|no such file/i.test(e.message)
    let r: agent.ExecResponse | null = null
    // pwsh: where its installer puts it, else wherever PATH has it.
    for (const exe of shell === "pwsh" ? [PWSH, "pwsh.exe"] : [""]) {
      const { argv, verbatim } = shellArgv(shell, command, exe)
      try {
        r = await c.exec(argv, { ...opts, ...(verbatim ? { verbatim } : {}) })
        break
      } catch (error) {
        if (shell !== "pwsh" || !missing(error)) throw error
      }
    }
    if (r === null) throw new ToolInputError("PowerShell 7 (pwsh) isn't installed in this Windows; use shell powershell instead")
    const head = r.timedOut ? `Timed out after ${n(seconds)} s; the command was killed with its child processes.` : `Exit code ${String(r.code)}.`
    const parts = [head]
    const tidy = (s: string): string => clip(s.replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd())
    if (r.stdout !== "") parts.push(`stdout:\n${tidy(r.stdout)}`)
    if (r.stderr !== "") parts.push(`stderr:\n${tidy(r.stderr)}`)
    if (r.stdout === "" && r.stderr === "") parts.push("(no output)")
    return textResult(parts.join("\n\n"), r.timedOut)
  }

  private async status(instance: string, why: string | null): Promise<ToolResult> {
    if (why !== null) return textResult(why)
    const g = this.deps.guest(instance)
    const lines = [`Instance ${instance} is running.`]
    try {
      const d = await this.serial(async () => await g.screen.display())
      lines.push(
        `Screen ${n(d.native.width)}x${n(d.native.height)}; screenshots ${n(d.size.width)}x${n(d.size.height)}` +
          (d.scale < 1 ? ` (scale ${d.scale.toFixed(4)}).` : " (full size)."),
      )
    } catch (error) {
      lines.push(`Screen size unknown: ${error instanceof Error ? error.message : String(error)}`)
    }
    const c = await g.agentIfUp().catch(() => null)
    const version = c === null ? null : await windowsVersion(c)
    lines.push(version === null ? "Windows version unknown: the in-guest agent isn't answering yet (run, list_files and the copies start it)." : `Windows: ${version}.`)
    return textResult(lines.join("\n"))
  }
}

/** "Windows 11 Pro 24H2 (10.0.26100.4349)", from the guest's registry, or null. */
async function windowsVersion(c: AgentLike): Promise<string | null> {
  const script =
    "$k = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; " +
    "$name = if ([int]$k.CurrentBuildNumber -ge 22000) { $k.ProductName -replace 'Windows 10', 'Windows 11' } else { $k.ProductName }; " +
    '"$name $($k.DisplayVersion) ($($k.CurrentMajorVersionNumber).$($k.CurrentMinorVersionNumber).$($k.CurrentBuildNumber).$($k.UBR))"'
  try {
    const r = await c.pwsh(script, { timeoutMs: 10_000 })
    const v = r.output.trim()
    return r.code === 0 && v !== "" ? v.replace(/\s+/g, " ") : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio

/** Protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const

const INSTRUCTIONS =
  "These tools operate a Windows 11 virtual machine running on this Mac. " +
  "Take a screenshot first; give coordinates in the latest screenshot's pixels, and take another screenshot after acting to check what happened. " +
  "Prefer run for anything a command can do (files, settings, installs, scripts), find_and_click for named controls, and find_text to locate visible text. " +
  "If a tool says the instance isn't running, tell the user how to start it."

type Json = Record<string, unknown>
type Id = string | number | null

const rpcError = (id: Id, code: number, message: string): Json => ({ jsonrpc: "2.0", id, error: { code, message } })

export interface ServerInfo {
  readonly name: string
  readonly version: string
}

/**
 * One message in, the response out (null for a notification). Exported for
 * tests; `serve` wires it to stdin and stdout.
 */
export async function handle(tools: Tools, info: ServerInfo, msg: unknown): Promise<Json | null> {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "Invalid Request")
  const m = msg as Json
  const method = m["method"]
  const hasId = Object.hasOwn(m, "id")
  const id = (hasId ? m["id"] : null) as Id
  if (typeof method !== "string") {
    // A response to something we never send, or junk.
    return hasId && (Object.hasOwn(m, "result") || Object.hasOwn(m, "error")) ? null : rpcError(id, -32600, "Invalid Request")
  }
  if (!hasId) return null // notifications: initialized, cancelled, roots changed…
  const params = (m["params"] ?? {}) as Json
  switch (method) {
    case "initialize": {
      const asked = params["protocolVersion"]
      const protocolVersion = typeof asked === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0]
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, title: "winvm", version: info.version },
          instructions: INSTRUCTIONS,
        },
      }
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } }
    case "tools/call": {
      const name = params["name"]
      if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${String(name)}`)
      const args = params["arguments"]
      const input = args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Json) : {}
      return { jsonrpc: "2.0", id, result: await tools.call(name, input) }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}


/** `winvm mcp [-i name]`: serve until stdin closes. */
export async function serve(args: Args, deps: Deps = realDeps()): Promise<number> {
  // Protocol messages only on stdout, whatever any module prints.
  const toStderr = (...a: unknown[]): void => {
    console.error(...a)
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  const out = (m: Json): void => {
    process.stdout.write(`${JSON.stringify(m)}\n`)
  }

  const instance = instanceName(args)
  const tools = new Tools(deps, instance)
  const info: ServerInfo = { name: `winvm-${instance}`, version: workspace.version }
  console.error(`winvm mcp: serving instance "${instance}" on stdio`)

  const pending = new Set<Promise<void>>()
  const one = async (msg: unknown): Promise<void> => {
    const r = await handle(tools, info, msg).catch((error: unknown) => rpcError(null, -32603, error instanceof Error ? error.message : String(error)))
    if (r !== null) out(r)
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === "") continue
    let msg: unknown
    try {
      msg = JSON.parse(line) as unknown
    } catch {
      out(rpcError(null, -32700, "Parse error"))
      continue
    }
    // Each request on its own, so a ping is answered while a long `run` goes on.
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = one(m).finally(() => pending.delete(p))
      pending.add(p)
    }
  }
  await Promise.allSettled([...pending])
  return 0
}
