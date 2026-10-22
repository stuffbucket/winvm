/**
 * Driving the guest's GUI by UI Automation element names — the host side of
 * the agent's `/ui` route, which hands each request to winvm-ui.exe
 * (assets/winvm-ui.cs), a long-lived UIA helper in the logged-on session.
 *
 *   const ui = await forInstance(name)                // agent.ensure + helper warm-up
 *   await ui.tray("Maximal", { menu: "Settings" })     // tray icon, then its menu item
 *   await ui.wait({ window: "Maximal", name: "Account" })
 *   await ui.click({ window: "Maximal", name: "Models" }, { settleMs: 200 })
 *   await ui.settle({ process: "maximal-shell" })
 *   const t = await ui.tree({ window: "Maximal" }, { depth: 3 })
 *
 * A Selector scopes to top-level windows (`window`: title contains or class
 * equals; `process`: process name; `hwnd`), then picks an element by `name`
 * (exact, case-insensitive), `nameContains`, `automationId`, `controlType`,
 * `className` and `index`. Without a scope the whole desktop is searched,
 * which is correct but slower. Element-finding ops take `timeoutMs` and keep
 * looking until then. Clicks are real input (SendInput) at the element's
 * centre; `invoke` and friends use UIA patterns and need nothing on screen.
 *
 * Errors are UiError with a `code`: notfound, timeout, covered (another window
 * is on top of the element where it would be clicked), bad, unavailable, fail.
 */
import type { AgentClient } from "./agent"
import { AgentError, ensure, install } from "./agent"

/** assets/winvm-ui.cs VERSION: an older helper in the guest is replaced by reinstalling the agent. */
export const UI_HELPER_VERSION = 6

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
  /** [x, y, width, height] in physical screen pixels; null when it has none. */
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
  /** Top-level windows only (`windows()`). */
  readonly process?: string | null
}

export interface TreeNode extends Element {
  readonly children?: readonly TreeNode[]
}

/** Every answer carries the helper's own time for it. */
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
  /** The overflow flyout was closed again after the menu item. */
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

/** Defaults: element ops wait this long for their element to appear. */
export const DEFAULT_TIMEOUT_MS = 10_000

export class Ui {
  readonly agent: AgentClient
  constructor(agent: AgentClient) {
    this.agent = agent
  }

  /** One raw request. */
  async call<T>(op: string, body: Readonly<Record<string, unknown>> = {}): Promise<T> {
    const t = typeof body["timeoutMs"] === "number" ? body["timeoutMs"] : 0
    try {
      // Past the helper's own watchdog (2 x timeout + 25 s), so a hang comes back as a UiError.
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

  /** Top-level windows, with their process names. */
  async windows(): Promise<readonly Element[]> {
    return (await this.call<{ windows: Element[] }>("windows")).windows
  }

  /**
   * The element tree under a selector: its windows (to `depth`, default all),
   * one element and its subtree, or with an empty selector the desktop's
   * windows (depth 1 unless given). Capped at `max` nodes (5000).
   */
  async tree(sel: Selector = {}, o: { readonly depth?: number; readonly max?: number; readonly timeoutMs?: number } = {}): Promise<Tree> {
    return await this.call<Tree>("tree", { ...sel, ...o })
  }

  /** The first match (or `index`th), waiting up to `timeoutMs` (default: no wait). */
  async find(sel: Selector, o: { readonly timeoutMs?: number } = {}): Promise<Element> {
    return (await this.call<Found>("find", { ...sel, timeoutMs: o.timeoutMs ?? 0 })).element
  }

  /** Every match; empty when none appears within `timeoutMs`. */
  async findAll(sel: Selector, o: { readonly timeoutMs?: number } = {}): Promise<readonly Element[]> {
    return (await this.call<{ elements: Element[] }>("find", { ...sel, all: true, timeoutMs: o.timeoutMs ?? 0 })).elements
  }

  /** Until it exists (or, `gone`, until it does not). UiError notfound/timeout after `timeoutMs`. */
  async wait(sel: Selector, o: { readonly timeoutMs?: number; readonly gone?: boolean } = {}): Promise<Waited> {
    return await this.call<Waited>("wait", { ...sel, timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, gone: o.gone === true })
  }

  /**
   * Do something to an element, waiting up to `timeoutMs` for it to appear.
   * `settleMs`: first wait until its window has not changed for that long.
   */
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

  /** Focus the element, then type `text` as Unicode key events. */
  async type(sel: Selector, text: string, o: { readonly timeoutMs?: number } = {}): Promise<Acted> {
    return await this.act("type", sel, { ...o, value: text })
  }

  /** Bring a top-level window to the foreground. */
  async focus(sel: Selector, o: { readonly timeoutMs?: number } = {}): Promise<{ readonly foreground: boolean; readonly window: Element }> {
    return await this.call("focus", { ...sel, timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS })
  }

  /**
   * Wait until the UI is idle: no change in the element tree (names, types,
   * bounds, states) for `quietMs` (300). Scope: the selector's windows, else
   * every top-level window plus the foreground window's subtree. Returns
   * `settled: false` (does not throw) at `timeoutMs` (10 s).
   */
  async settle(sel: Selector = {}, o: { readonly quietMs?: number; readonly timeoutMs?: number; readonly intervalMs?: number } = {}): Promise<Settled> {
    return await this.call<Settled>("settle", { ...sel, ...o })
  }

  /**
   * Click a notification-area icon by tooltip (substring), opening the
   * overflow flyout if it is hidden there — right-click by default — and then,
   * with `menu`, the context-menu item of that name.
   */
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

  /** What is at a screen point: the top-level window a click there would reach, and the UIA element. */
  async at(x: number, y: number): Promise<{ readonly window: string; readonly element?: Element }> {
    return await this.call("at", { x, y })
  }

  /** Click an item of an open context menu (exact text, else prefix; "…" and accelerators ignored). */
  async menu(item: string, o: { readonly timeoutMs?: number; readonly invoke?: boolean } = {}): Promise<Found> {
    return await this.call<Found>("menu", { name: item, timeoutMs: o.timeoutMs ?? 5000, action: o.invoke === true ? "invoke" : "click" })
  }
}

/**
 * A Ui for a running instance: its agent (installed or upgraded if need be,
 * and again if its helper is older than this host's), helper warmed up.
 */
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

// --- formatting, for the CLI and job logs -----------------------------------

const q = (s: string): string => JSON.stringify(s.replace(/\s+/g, " "))

/** One line: `Button "Settings…" id=Item 1008 [569,490 228x22] pid 2800`. */
export function formatElement(e: Element): string {
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
