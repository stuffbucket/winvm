/**
 * `winvm cua …`: Claude's computer-use tool against a guest (cua.ts executes).
 *
 *   winvm cua serve -i <inst> [--port N] [--size WxH]     (also `winvm cua-serve`)
 *   winvm cua run   -i <inst> "<task>" [--model M] [--max-steps N] [--effort E]
 *                   [--size WxH] [--extras] [--base-url URL] [--shots DIR]
 *
 * ## serve
 *
 * A localhost-only HTTP endpoint (127.0.0.1, never another interface) for a
 * harness that runs its own model loop. Every request needs
 * `Authorization: Bearer <token>`; the token is random per run, printed, and
 * written with the port to <instance>/cua.json (mode 0600), removed on exit.
 *
 *   GET  /v1/info       screen and screenshot sizes, scale, the tool entries to declare
 *   POST /v1/computer   {"action": "left_click", "coordinate": [x, y]} ->
 *                       {"content": [...tool_result content...], "is_error": bool, "ms": {...}}
 *   GET  /v1/extra      tool definitions for the non-standard actions below
 *   POST /v1/extra      {"action": "ui_find" | "ui_click" | "ocr_find", ...}
 *
 * `content` is what goes in the tool_result as is (an image block for
 * screenshot/zoom, text otherwise). Actions run one at a time, in arrival order.
 *
 * ## run
 *
 * A minimal agent loop: the Messages API with the computer toolset
 * (`computer_toolset_20260801`), each tool call executed here. API access:
 * ANTHROPIC_API_KEY when set (api.anthropic.com, or ANTHROPIC_BASE_URL);
 * otherwise Maximal on the host (http://localhost:4141, Anthropic-compatible),
 * or --base-url.
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type Anthropic from "@anthropic-ai/sdk"

import type { Args } from "./args"
import { instanceName } from "./args"
import type { Block, Result, Size } from "./cua"
import { ACTIONS, Computer, DEFAULT_BOX, toModel } from "./cua"
import * as ocr from "./ocr"
import type { Paths } from "./paths"
import { pathsFor, readMeta } from "./paths"
import * as qemu from "./qemu"
import type { Element, Selector, Ui } from "./ui"
import { forInstance } from "./ui"

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const USAGE =
  "usage: winvm cua serve [-i name] [--port N] [--size WxH]\n" +
  '       winvm cua run   [-i name] "<task>" [--model M] [--max-steps N] [--effort low|medium|high|xhigh|max]\n' +
  "                       [--size WxH] [--extras] [--base-url URL] [--shots DIR]"

export const DEFAULT_MODEL = "claude-opus-5-5"
export const MAXIMAL_URL = "http://localhost:4141"

/** "1280x800" -> a size; null if it isn't one. */
export function parseSize(s: string | undefined): Size | null {
  if (s === undefined) return DEFAULT_BOX
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(s.trim())
  if (m === null) return null
  const width = Number(m[1])
  const height = Number(m[2])
  return width >= 200 && height >= 200 && width <= 2576 && height <= 2576 ? { width, height } : null
}

function running(args: Args): { name: string; p: Paths } | null {
  const name = instanceName(args)
  if (readMeta(name) === null) {
    console.error(`::error::no instance "${name}"`)
    return null
  }
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running — \`winvm start -i ${name}\``)
    return null
  }
  return { name, p }
}

// ---------------------------------------------------------------------------
// Extra, non-standard actions: UI Automation by name, OCR by text

const selectorSchema = {
  name: { type: "string", description: "The element's exact accessible name" },
  nameContains: { type: "string", description: "Part of the element's accessible name" },
  window: { type: "string", description: "Part of the top-level window's title (or its class) to search in" },
  controlType: { type: "string", description: "UI Automation control type, e.g. Button, Edit, MenuItem, ListItem, Hyperlink" },
  automationId: { type: "string", description: "The element's AutomationId" },
} as const

/** Custom tool definitions a harness can declare beside the computer toolset. */
export const EXTRA_TOOLS = [
  {
    name: "ui_find",
    description:
      "Find elements on the Windows desktop by UI Automation (accessibility) properties instead of by pixels. " +
      "Returns up to 10 matches with their bounds and centre in screenshot coordinates. Give at least one of name/nameContains/automationId.",
    input_schema: { type: "object", properties: selectorSchema, additionalProperties: false },
  },
  {
    name: "ui_click",
    description:
      "Click the first element matching UI Automation properties (waits up to 5 s for it to appear). More reliable than a pixel click " +
      "for named buttons, menu items and links. Give at least one of name/nameContains/automationId.",
    input_schema: {
      type: "object",
      properties: { ...selectorSchema, button: { type: "string", enum: ["left", "right", "double"] } },
      additionalProperties: false,
    },
  },
  {
    name: "ocr_find",
    description: "Find text on the screen by OCR. Returns matching lines with their centre in screenshot coordinates (whole-line matches first).",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to look for (case-insensitive)" }, wait: { type: "number", description: "Seconds to keep looking, default 0" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
] as const

export const EXTRA_NAMES: readonly string[] = EXTRA_TOOLS.map((t) => t.name)

/** A UIA selector from tool input: only the known string keys. */
export function selectorFrom(input: Readonly<Record<string, unknown>>): Selector {
  const sel: Record<string, string> = {}
  for (const k of ["name", "nameContains", "window", "controlType", "automationId"] as const) {
    const v = input[k]
    if (typeof v === "string" && v !== "") sel[k] = v
  }
  return sel
}

const text = (t: string, isError = false): Result => ({ content: [{ type: "text", text: t }], isError, ms: {} })

class Extras {
  private ui: Ui | null = null
  private readonly name: string
  private readonly computer: Computer
  constructor(name: string, computer: Computer) {
    this.name = name
    this.computer = computer
  }

  private async getUi(): Promise<Ui> {
    this.ui ??= await forInstance(this.name)
    return this.ui
  }

  /** An element as one line, its bounds and centre in the model's coordinates. */
  private async describe(e: Element): Promise<string> {
    const { scale } = await this.computer.display()
    let where = "no bounds"
    if (e.bounds !== null) {
      const [x, y, w, h] = e.bounds
      const tl = toModel(x, y, scale)
      const c = toModel(x + w / 2, y + h / 2, scale)
      where = `box [${String(tl.x)}, ${String(tl.y)}, ${String(Math.round(w * scale))}x${String(Math.round(h * scale))}] centre [${String(c.x)}, ${String(c.y)}]`
    }
    const flags = [e.enabled === false ? "disabled" : "", e.offscreen === true ? "offscreen" : "", e.focused === true ? "focused" : ""].filter((f) => f !== "")
    const value = e.value !== undefined && e.value !== "" ? ` value=${JSON.stringify(e.value)}` : ""
    return `${e.controlType} ${JSON.stringify(e.name)}${e.automationId === undefined ? "" : ` id=${JSON.stringify(e.automationId)}`} ${where}${value}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`
  }

  async run(action: string, input: Readonly<Record<string, unknown>>): Promise<Result> {
    const t0 = performance.now()
    try {
      const r = await this.dispatch(action, input)
      return { ...r, ms: { total: performance.now() - t0 } }
    } catch (error) {
      return { ...text(errMsg(error), true), ms: { total: performance.now() - t0 } }
    }
  }

  private async dispatch(action: string, input: Readonly<Record<string, unknown>>): Promise<Result> {
    switch (action) {
      case "ui_find":
      case "ui_click": {
        const sel = selectorFrom(input)
        if (sel.name === undefined && sel.nameContains === undefined && sel.automationId === undefined) {
          return text("give at least one of name, nameContains, automationId", true)
        }
        const ui = await this.getUi()
        if (action === "ui_find") {
          const found = (await ui.findAll(sel, { timeoutMs: 1000 })).slice(0, 10)
          if (found.length === 0) return text("no matching element")
          return text((await Promise.all(found.map(async (e) => await this.describe(e)))).join("\n"))
        }
        const b = input["button"]
        const button = b === "right" || b === "double" ? b : "left"
        const acted = await ui.click(sel, { timeoutMs: 5000, button })
        return text(`clicked ${await this.describe(acted.element)}`)
      }
      case "ocr_find": {
        const needle = input["text"]
        if (typeof needle !== "string" || needle === "") return text("text must be a non-empty string", true)
        const wait = typeof input["wait"] === "number" ? Math.min(Math.max(input["wait"], 0), 30) : 0
        const { scale } = await this.computer.display()
        const { last } = await ocr.findOnScreen(this.computer.p, needle, { waitMs: wait * 1000 })
        if (last.boxes.length === 0) return text(`"${needle}" is not on the screen`)
        return text(
          last.boxes
            .slice(0, 10)
            .map((b) => {
              const c = ocr.centre(b)
              const m = toModel(c.x, c.y, scale)
              return `${JSON.stringify(b.text)} centre [${String(m.x)}, ${String(m.y)}] ${(b.confidence * 100).toFixed(0)}%`
            })
            .join("\n"),
        )
      }
      default:
        return text(`unknown extra action "${action}" (have ${EXTRA_NAMES.join(", ")})`, true)
    }
  }
}

/** Calls in arrival order, one at a time. */
function serializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn)
    tail = next.catch(() => undefined)
    return await next
  }
}

// ---------------------------------------------------------------------------
// serve

/** Constant-time bearer check. */
export function authorized(header: string | null, token: string): boolean {
  if (header === null) return false
  const m = /^Bearer\s+(\S+)$/.exec(header)
  if (m === null) return false
  const a = Buffer.from(m[1] ?? "")
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const wire = (r: Result): Record<string, unknown> => ({ content: r.content, is_error: r.isError, ms: r.ms })

export async function serve(args: Args): Promise<number> {
  const box = parseSize(args.flags.get("size"))
  if (box === null) {
    console.error(`::error::--size must be WIDTHxHEIGHT, 200..2576 a side\n${USAGE}`)
    return 2
  }
  const portFlag = args.flags.get("port")
  const port = portFlag === undefined ? 0 : Number(portFlag)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`::error::--port must be 0..65535\n${USAGE}`)
    return 2
  }
  const r = running(args)
  if (r === null) return 1

  const computer = new Computer(r.p, box)
  const extras = new Extras(r.name, computer)
  const one = serializer()
  const token = randomBytes(24).toString("base64url")

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: async (req): Promise<Response> => {
      if (!authorized(req.headers.get("authorization"), token)) return json({ error: "unauthorized" }, 401)
      const path = new URL(req.url).pathname
      try {
        if (req.method === "GET" && path === "/v1/info") {
          const d = await one(async () => await computer.display())
          return json({
            instance: r.name,
            native: d.native,
            scale: d.scale,
            size: d.size,
            actions: ACTIONS,
            tool: { type: "computer_toolset_20260801" },
            legacy_tool: { type: "computer_20251124", name: "computer", display_width_px: d.size.width, display_height_px: d.size.height },
          })
        }
        if (req.method === "GET" && path === "/v1/extra") return json({ tools: EXTRA_TOOLS })
        if (req.method === "POST" && (path === "/v1/computer" || path === "/v1/extra")) {
          const body = (await req.json().catch(() => null)) as unknown
          if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ error: "body must be a JSON object" }, 400)
          const b = body as Record<string, unknown>
          const result =
            path === "/v1/computer"
              ? await one(async () => await computer.run(b))
              : await one(async () => {
                  const { action, ...rest } = b
                  return await extras.run(typeof action === "string" ? action : "", rest)
                })
          return json(wire(result))
        }
        return json({ error: "not found" }, 404)
      } catch (error) {
        return json({ error: errMsg(error) }, 500)
      }
    },
  })

  const statePath = resolve(r.p.dir, "cua.json")
  const url = `http://127.0.0.1:${String(server.port)}`
  writeFileSync(statePath, `${JSON.stringify({ url, port: server.port, token, pid: process.pid }, null, 2)}\n`, { mode: 0o600 })
  const d = await computer.display().catch(() => null)
  console.log(`computer use for "${r.name}" on ${url}`)
  if (d !== null) console.log(`  screen ${String(d.native.width)}x${String(d.native.height)}, screenshots ${String(d.size.width)}x${String(d.size.height)} (scale ${d.scale.toFixed(4)})`)
  console.log(`  token ${token}`)
  console.log(`  (also in ${statePath})`)

  await new Promise<void>((done) => {
    const stop = (): void => {
      done()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  rmSync(statePath, { force: true })
  computer.close()
  await server.stop(true)
  return 0
}

// ---------------------------------------------------------------------------
// run

export function systemPrompt(size: Size, extras: boolean): string {
  return [
    `You are operating a Windows 11 (ARM64) desktop through the computer tools. Screenshots are ${String(size.width)}x${String(size.height)}; give coordinates in their pixels.`,
    "The keyboard is US-layout: the type action can only type ASCII characters. Keys use xdotool names (Return, ctrl+s, super, alt+F4).",
    "End each group of actions with a screenshot so you can check the result before continuing.",
    extras ? "ui_find, ui_click and ocr_find locate controls by accessible name or visible text; prefer them to guessing pixels for named controls." : "",
    "When the task is done, reply with a one-paragraph summary of what you did and what you saw, and make no further tool calls.",
  ]
    .filter((l) => l !== "")
    .join("\n")
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

const NOT_RUN = "Not executed: an earlier computer action in this turn failed."

export async function run(args: Args): Promise<number> {
  const task = (args.rest.length > 0 ? args.rest : args.positional).join(" ").trim()
  if (task === "") {
    console.error(USAGE)
    return 2
  }
  const box = parseSize(args.flags.get("size"))
  const maxSteps = Number(args.flags.get("max-steps") ?? 40)
  const effort = args.flags.get("effort") ?? "medium"
  if (box === null || !Number.isInteger(maxSteps) || maxSteps < 1 || !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    console.error(USAGE)
    return 2
  }
  const r = running(args)
  if (r === null) return 1

  const model = args.flags.get("model") ?? DEFAULT_MODEL
  const useExtras = args.flags.has("extras")
  const shots = args.flags.get("shots")
  if (shots !== undefined) mkdirSync(shots, { recursive: true })

  // The SDK only when a model loop runs, so the rest of the tool needs no install.
  const { default: AnthropicSdk } = await import("@anthropic-ai/sdk")
  const direct = (process.env["ANTHROPIC_API_KEY"] ?? "") !== "" && args.flags.get("base-url") === undefined
  const client: Anthropic = direct
    ? new AnthropicSdk()
    : new AnthropicSdk({ baseURL: args.flags.get("base-url") ?? MAXIMAL_URL, apiKey: "maximal" })
  const endpoint = direct ? (process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com") : (args.flags.get("base-url") ?? MAXIMAL_URL)

  const computer = new Computer(r.p, box)
  const extras = new Extras(r.name, computer)
  const { size } = await computer.display()
  const tools: Anthropic.ToolUnion[] = [{ type: "computer_toolset_20260801" }]
  if (useExtras) for (const t of EXTRA_TOOLS) tools.push(t as unknown as Anthropic.Tool)
  const system = systemPrompt(size, useExtras)
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }]

  console.log(`model ${model} via ${endpoint}; screenshots ${String(size.width)}x${String(size.height)}; effort ${effort}`)
  const modelMs: number[] = []
  const actionMs: Record<string, number[]> = {}
  const record = (name: string, ms: number): void => {
    ;(actionMs[name] ??= []).push(ms)
  }
  let usageIn = 0
  let usageOut = 0
  let shotN = 0
  let outcome = 1

  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      const t0 = performance.now()
      // Server-side refusal fallback where the API offers it (not through a proxy).
      const body = {
        model,
        max_tokens: 16000,
        system,
        tools,
        messages,
        output_config: { effort: effort as Anthropic.OutputConfig["effort"] },
        ...(direct ? { fallbacks: "default" } : {}),
      } as Anthropic.MessageCreateParamsNonStreaming
      const msg = await client.messages.create(body, direct ? { headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } } : {})
      const took = performance.now() - t0
      modelMs.push(took)
      usageIn += msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)
      usageOut += msg.usage.output_tokens
      // The whole content goes back unchanged: thinking blocks included.
      messages.push({ role: "assistant", content: msg.content })

      for (const b of msg.content) if (b.type === "text" && b.text.trim() !== "") console.log(`\n${b.text.trim()}\n`)
      const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      console.log(`[step ${String(step)}] model ${(took / 1000).toFixed(1)} s, ${String(calls.length)} action(s), stop ${String(msg.stop_reason)}`)

      if (msg.stop_reason === "refusal") {
        console.error(`::error::the model declined (${msg.stop_details?.category ?? "no category"})`)
        break
      }
      if (calls.length === 0) {
        outcome = msg.stop_reason === "end_turn" ? 0 : 1
        break
      }

      const results: Anthropic.ToolResultBlockParam[] = []
      let failed = false
      for (const call of calls) {
        const input = (call.input ?? {}) as Record<string, unknown>
        const isComputer = call.toolset_name === "computer"
        const base = { type: "tool_result" as const, tool_use_id: call.id, ...(isComputer ? { toolset_name: "computer" } : {}) }
        if (failed) {
          results.push({ ...base, is_error: true, content: NOT_RUN })
          continue
        }
        const res: Result = isComputer
          ? await computer.run(call.name, input)
          : EXTRA_NAMES.includes(call.name) && useExtras
            ? await extras.run(call.name, input)
            : text(`unknown tool "${call.name}"`, true)
        record(call.name, res.ms["total"] ?? 0)
        if (res.ms["capture"] !== undefined) record("screenshot:capture", res.ms["capture"])
        if (res.ms["encode"] !== undefined) record("screenshot:scale+encode", res.ms["encode"])
        const shown = JSON.stringify(input)
        console.log(`  ${call.name}${shown === "{}" ? "" : ` ${shown}`} -> ${res.isError ? `ERROR ${blockText(res.content)}` : summarize(res.content)} (${(res.ms["total"] ?? 0).toFixed(0)} ms)`)
        if (shots !== undefined) {
          for (const c of res.content) {
            if (c.type === "image") {
              shotN += 1
              writeFileSync(resolve(shots, `${String(step).padStart(2, "0")}-${String(shotN).padStart(3, "0")}-${call.name}.png`), Buffer.from(c.source.data, "base64"))
            }
          }
        }
        results.push({ ...base, content: [...res.content], ...(res.isError ? { is_error: true } : {}) })
        if (res.isError) failed = true
      }
      messages.push({ role: "user", content: results })
      if (step === maxSteps) console.error(`::error::stopped after --max-steps ${String(maxSteps)}`)
    }
  } catch (error) {
    console.error(`::error::${errMsg(error)}`)
    outcome = 1
  } finally {
    computer.close()
  }

  console.log(`\nlatency (median ms): model ${median(modelMs).toFixed(0)} over ${String(modelMs.length)} call(s)`)
  for (const [name, xs] of Object.entries(actionMs).sort()) console.log(`  ${name.padEnd(24)} ${median(xs).toFixed(1).padStart(8)}  (n=${String(xs.length)})`)
  console.log(`tokens: ${String(usageIn)} in, ${String(usageOut)} out`)
  return outcome
}

function blockText(content: readonly Block[]): string {
  return content.map((c) => (c.type === "text" ? c.text : "[image]")).join(" ")
}

function summarize(content: readonly Block[]): string {
  const t = blockText(content)
  return t.length > 120 ? `${t.slice(0, 117)}...` : t
}

export async function cua(args: Args, sub?: string): Promise<number> {
  const verb = sub ?? args.positional[0]
  const rest: Args = sub === undefined ? { ...args, positional: args.positional.slice(1) } : args
  if (verb === "serve") return await serve(rest)
  if (verb === "run") return await run(rest)
  console.error(USAGE)
  return 2
}
