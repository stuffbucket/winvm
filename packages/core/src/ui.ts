import type { AgentClient } from "./agent"
import { AgentError, ensure, install } from "./agent"

export const UI_HELPER_VERSION = 7

export interface Selector {
  readonly window?: string
  readonly process?: string
  readonly hwnd?: number
  readonly name?: string
  readonly nameContains?: string
  readonly automationId?: string
  readonly controlType?: string
  readonly className?: string
  readonly index?: number
}

export const SELECTOR_KEYS = ["window", "process", "hwnd", "name", "nameContains", "automationId", "controlType", "className", "index"] as const

export interface Element {
  readonly name: string
  readonly controlType: string
  readonly automationId?: string
  readonly className?: string
  readonly framework?: string
  readonly bounds: readonly [number, number, number, number] | null
  readonly enabled?: false
  readonly offscreen?: true
  readonly focused?: true
  readonly hwnd?: number
  readonly pid: number
  readonly value?: string
  readonly toggle?: string
  readonly expanded?: string
  readonly selected?: boolean
  readonly process?: string | null
}

export interface TreeNode extends Element {
  readonly children?: readonly TreeNode[]
}

interface Timed {
  readonly ms: number
}

export type Action = "click" | "rightclick" | "doubleclick" | "middleclick" | "invoke" | "toggle" | "expand" | "collapse" | "select" | "setvalue" | "focus" | "type"
export const ACTIONS: readonly Action[] = ["click", "rightclick", "doubleclick", "middleclick", "invoke", "toggle", "expand", "collapse", "select", "setvalue", "focus", "type"]

export interface Ping extends Timed {
  readonly version: number
  readonly pid: number
  readonly session: number
  readonly arch: string
  readonly dpiAware: boolean
  readonly dpi: number
  readonly screen: readonly [number, number]
}
export interface Found extends Timed {
  readonly element: Element
}
export interface Waited extends Timed {
  readonly element?: Element
  readonly gone?: true
  readonly waitedMs: number
}
export interface Acted extends Timed {
  readonly did: string
  readonly element: Element
  readonly at?: readonly [number, number]
}
export interface Settled extends Timed {
  readonly settled: boolean
  readonly settledMs: number
  readonly polls: number
  readonly changes: number
  readonly elements: number
}
export interface Tree extends Timed {
  readonly count: number
  readonly truncated: boolean
  readonly tree: TreeNode
}
export interface TrayClicked extends Timed {
  readonly icon: Element
  readonly overflow: boolean
  readonly at: readonly [number, number]
  readonly clickedMs: number
  readonly menuItem?: Element
  readonly closedOverflow?: true
}

export class UiError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

const CODES: Readonly<Record<number, string>> = { 400: "bad", 404: "notfound", 408: "timeout", 409: "covered", 501: "unavailable" }

export const DEFAULT_TIMEOUT_MS = 10_000

export class Ui {
  readonly agent: AgentClient
  constructor(agent: AgentClient) {
    this.agent = agent
  }

  async call<T>(op: string, body: Readonly<Record<string, unknown>> = {}): Promise<T> {
    const t = typeof body["timeoutMs"] === "number" ? body["timeoutMs"] : 0
    try {
      return await this.agent.ui<T>({ ...body, op }, 2 * t + 60_000)
    } catch (error) {
      if (error instanceof AgentError) {
        const msg = error.message.replace(/^agent POST \/ui: \d+ /, "")
        throw new UiError(msg, CODES[error.status] ?? "fail")
      }
      throw error
    }
  }

  async ping(): Promise<Ping> {
    return await this.call<Ping>("ping")
  }

  async windows(): Promise<readonly Element[]> {
    return (await this.call<{ windows: Element[] }>("windows")).windows
  }

  async tree(sel: Selector = {}, o: { readonly depth?: number; readonly max?: number; readonly timeoutMs?: number } = {}): Promise<Tree> {
    return await this.call<Tree>("tree", { ...sel, ...o })
  }

  async find(sel: Selector, o: { readonly timeoutMs?: number } = {}): Promise<Element> {
    return (await this.call<Found>("find", { ...sel, timeoutMs: o.timeoutMs ?? 0 })).element
  }

  async findAll(sel: Selector, o: { readonly timeoutMs?: number } = {}): Promise<readonly Element[]> {
    return (await this.call<{ elements: Element[] }>("find", { ...sel, all: true, timeoutMs: o.timeoutMs ?? 0 })).elements
  }

  async wait(sel: Selector, o: { readonly timeoutMs?: number; readonly gone?: boolean } = {}): Promise<Waited> {
    return await this.call<Waited>("wait", { ...sel, timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, gone: o.gone === true })
  }

  async act(
    action: Action,
    sel: Selector,
    o: { readonly timeoutMs?: number; readonly value?: string; readonly settleMs?: number } = {},
  ): Promise<Acted> {
    return await this.call<Acted>("act", { ...sel, action, timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(o.value === undefined ? {} : { value: o.value }), settleMs: o.settleMs ?? 0 })
  }

  async click(sel: Selector, o: { readonly timeoutMs?: number; readonly settleMs?: number; readonly button?: "left" | "right" | "double" } = {}): Promise<Acted> {
    const action: Action = o.button === "right" ? "rightclick" : o.button === "double" ? "doubleclick" : "click"
    return await this.act(action, sel, o)
  }

  async invoke(sel: Selector, o: { readonly timeoutMs?: number } = {}): Promise<Acted> {
    return await this.act("invoke", sel, o)
  }

  async setValue(sel: Selector, value: string, o: { readonly timeoutMs?: number } = {}): Promise<Acted> {
    return await this.act("setvalue", sel, { ...o, value })
  }

  async type(sel: Selector, text: string, o: { readonly timeoutMs?: number } = {}): Promise<Acted> {
    return await this.act("type", sel, { ...o, value: text })
  }

  async focus(sel: Selector, o: { readonly timeoutMs?: number } = {}): Promise<{ readonly foreground: boolean; readonly window: Element }> {
    return await this.call("focus", { ...sel, timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  }

  async settle(sel: Selector = {}, o: { readonly quietMs?: number; readonly timeoutMs?: number; readonly intervalMs?: number } = {}): Promise<Settled> {
    return await this.call<Settled>("settle", { ...sel, ...o })
  }

  async tray(
    tooltip: string,
    o: { readonly menu?: string; readonly button?: "left" | "right" | "double"; readonly timeoutMs?: number } = {},
  ): Promise<TrayClicked> {
    return await this.call<TrayClicked>("tray", {
      name: tooltip,
      button: o.button ?? "right",
      timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(o.menu === undefined ? {} : { menu: o.menu }),
    })
  }

  async at(x: number, y: number): Promise<{ readonly window: string; readonly element?: Element }> {
    return await this.call("at", { x, y })
  }

  async menu(item: string, o: { readonly timeoutMs?: number; readonly invoke?: boolean } = {}): Promise<Found> {
    return await this.call<Found>("menu", { name: item, timeoutMs: o.timeoutMs ?? 5000, action: o.invoke === true ? "invoke" : "click" })
  }
}

export async function forInstance(name: string, o: { readonly log?: (line: string) => void } = {}): Promise<Ui> {
  const opts = o.log === undefined ? {} : { log: o.log }
  const ui = new Ui(await ensure(name, opts))
  const p = await ui.ping().catch((e: unknown) => {
    if (e instanceof UiError && e.code === "unavailable") return null
    throw e
  })
  if (p !== null && p.version === UI_HELPER_VERSION) return ui
  o.log?.(`the guest's UI helper is ${p === null ? "missing" : `v${String(p.version)}`}, want v${String(UI_HELPER_VERSION)}: reinstalling the agent`)
  const fresh = new Ui(await install(name, opts))
  await fresh.ping()
  return fresh
}

const q = (s: string): string => JSON.stringify(s.replace(/\s+/g, " "))

export function formatElement(e: Omit<Element, "bounds" | "pid"> & Partial<Pick<Element, "bounds" | "pid">>): string {
  const parts = [e.controlType, q(e.name)]
  if (e.automationId !== undefined) parts.push(`id=${q(e.automationId)}`)
  if (e.className !== undefined) parts.push(`class=${q(e.className)}`)
  if (e.bounds !== null && e.bounds !== undefined) parts.push(`[${String(e.bounds[0])},${String(e.bounds[1])} ${String(e.bounds[2])}x${String(e.bounds[3])}]`)
  if (e.value !== undefined && e.value !== "") parts.push(`value=${q(e.value)}`)
  if (e.toggle !== undefined) parts.push(`toggle=${e.toggle}`)
  if (e.expanded !== undefined) parts.push(`expanded=${e.expanded}`)
  if (e.selected === true) parts.push("selected")
  if (e.enabled === false) parts.push("disabled")
  if (e.offscreen === true) parts.push("offscreen")
  if (e.focused === true) parts.push("focused")
  if (e.process !== undefined && e.process !== null) parts.push(e.process)
  if (e.pid !== undefined) parts.push(`pid ${String(e.pid)}`)
  return parts.join(" ")
}

export function formatTree(t: TreeNode, indent = ""): string {
  const lines = [`${indent}${formatElement(t)}`]
  for (const c of t.children ?? []) lines.push(formatTree(c, `${indent}  `))
  return lines.join("\n")
}
