/**
 * `winvm ui …`: drive the guest's GUI by UI Automation element names (ui.ts).
 *
 *   winvm ui [-i name] windows                          top-level windows
 *   winvm ui tree   [selector] [--depth N] [--max N]    the element tree
 *   winvm ui find   [selector] [--all]                  the matching element(s)
 *   winvm ui wait   [selector] [--gone]                 until it appears (or goes)
 *   winvm ui click | rightclick | doubleclick | invoke | toggle | expand
 *          | collapse | select | focus  [selector] [--settle ms]
 *   winvm ui set    [selector] --value text             ValuePattern.SetValue
 *   winvm ui type   [selector] --value text             focus, then key events
 *   winvm ui settle [selector] [--quiet ms]             until the UI is idle
 *   winvm ui tray   <tooltip> [--menu item] [--button left|right|double]
 *   winvm ui menu   <item>                              click an open menu's item
 *   winvm ui at     <x> <y>                             what a click there would hit
 *   winvm ui ping                                       the helper's arch, DPI, screen
 *
 * Selector flags: --window <title part|class> --process <name> --hwnd <n>
 * --name <exact> --contains <part> --id <automationId> --type <controlType>
 * --class <className> --index <n>. A bare positional is --name. --timeout
 * (seconds, or "500ms") is how long to wait for the element; --json prints the
 * helper's answer as is.
 */
import type { Args } from "./args"
import { instanceName } from "./args"
import { parseDuration } from "./job"
import { pathsFor } from "./paths"
import * as qemu from "./qemu"
import type { Action, Selector } from "./ui"
import { ACTIONS, UiError, forInstance, formatElement, formatTree } from "./ui"

const USAGE = `usage: winvm ui [-i name] <verb> [selector] [options]
  verbs:    windows | tree | find | wait | click | rightclick | doubleclick | invoke | toggle
            | expand | collapse | select | focus | set | type | settle | tray <tooltip> | menu <item> | at <x> <y> | ping
  selector: --window <title part|class> --process <name> --hwnd <n>
            --name <exact> (or a bare word) --contains <part> --id <automationId>
            --type <controlType> --class <className> --index <n>
  options:  --timeout <s|ms> --json --depth <n> --max <n> --all --gone --settle <ms>
            --value <text> --quiet <ms> --menu <item> --button left|right|double`

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}

/** A duration flag: a bare number is in `unit`; "500ms", "2s" are explicit. */
const dur = (args: Args, flag: string, unit: "s" | "ms"): number | undefined => {
  const v = args.flags.get(flag)
  if (v === undefined) return undefined
  return parseDuration(/^\d+(\.\d+)?$/.test(v) ? `${v}${unit}` : v, `--${flag}`) ?? undefined
}

const int = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number.parseInt(v, 10))

export function selectorFrom(args: Args, positional: string | undefined): Selector {
  const f = args.flags
  const s: Record<string, string | number> = {}
  const set = (k: keyof Selector, v: string | number | undefined): void => {
    if (v !== undefined && !(typeof v === "number" && Number.isNaN(v))) s[k] = v
  }
  set("window", f.get("window"))
  set("process", f.get("process"))
  set("hwnd", int(f.get("hwnd")))
  set("name", f.get("name") ?? positional)
  set("nameContains", f.get("contains"))
  set("automationId", f.get("id"))
  set("controlType", f.get("type"))
  set("className", f.get("class"))
  set("index", int(f.get("index")))
  return s as Selector
}

export async function uiCmd(args: Args): Promise<number> {
  const name = instanceName(args)
  const [verb, arg] = args.positional
  if (verb === undefined || verb === "help" || args.flags.has("help")) {
    console.log(USAGE)
    return verb === undefined ? 1 : 0
  }
  if (!qemu.isRunning(pathsFor(name))) return fail(`instance "${name}" is not running — \`winvm start -i ${name}\``)
  const json = args.flags.has("json")
  const timeoutMs = dur(args, "timeout", "s")
  const t0 = performance.now()
  const took = (): string => `${(performance.now() - t0).toFixed(0)} ms`
  const out = (v: unknown, human: string): void => console.log(json ? JSON.stringify(v, null, 2) : human)
  try {
    const ui = await forInstance(name, { log: (l) => console.error(l) })
    const sel = selectorFrom(args, arg)
    const t = timeoutMs === undefined ? {} : { timeoutMs }
    switch (verb) {
      case "ping": {
        const p = await ui.ping()
        out(p, `winvm-ui v${String(p.version)} pid ${String(p.pid)} session ${String(p.session)} ${p.arch}, ${String(p.screen[0])}x${String(p.screen[1])} @ ${String(p.dpi)} dpi`)
        return 0
      }
      case "windows": {
        const w = await ui.windows()
        out(w, w.map(formatElement).join("\n"))
        return 0
      }
      case "tree": {
        const depth = int(args.flags.get("depth"))
        const max = int(args.flags.get("max"))
        const r = await ui.tree(sel, { ...t, ...(depth === undefined ? {} : { depth }), ...(max === undefined ? {} : { max }) })
        out(r, `${formatTree(r.tree)}\n(${String(r.count)} elements${r.truncated ? ", truncated" : ""}, helper ${String(r.ms)} ms, ${took()})`)
        return 0
      }
      case "find": {
        if (args.flags.has("all")) {
          const all = await ui.findAll(sel, t)
          out(all, all.length === 0 ? "(none)" : all.map(formatElement).join("\n"))
          return all.length === 0 ? 1 : 0
        }
        const e = await ui.find(sel, t)
        out(e, `${formatElement(e)}  (${took()})`)
        return 0
      }
      case "wait": {
        const r = await ui.wait(sel, { ...t, gone: args.flags.has("gone") })
        out(r, `${r.element === undefined ? "gone" : formatElement(r.element)}  (waited ${String(r.waitedMs)} ms)`)
        return 0
      }
      case "settle": {
        const quietMs = dur(args, "quiet", "ms")
        const r = await ui.settle(sel, { ...t, ...(quietMs === undefined ? {} : { quietMs }) })
        out(r, `${r.settled ? "settled" : "NOT settled"} after ${String(r.settledMs)} ms (${String(r.polls)} polls, ${String(r.changes)} changes, ${String(r.elements)} elements)`)
        return r.settled ? 0 : 1
      }
      case "tray": {
        if (arg === undefined) return fail("usage: winvm ui tray <tooltip> [--menu item] [--button left|right|double]")
        const button = args.flags.get("button") as "left" | "right" | "double" | undefined
        const menu = args.flags.get("menu")
        const r = await ui.tray(arg, { ...t, ...(button === undefined ? {} : { button }), ...(menu === undefined ? {} : { menu }) })
        out(
          r,
          `tray: ${formatElement(r.icon)}${r.overflow ? " (in the overflow)" : ""}` +
            (r.menuItem === undefined ? "" : `\nmenu: ${formatElement(r.menuItem)}`) +
            `  (${took()})`,
        )
        return 0
      }
      case "menu": {
        if (arg === undefined) return fail("usage: winvm ui menu <item>")
        const r = await ui.menu(arg, t)
        out(r, `${formatElement(r.element)}  (${took()})`)
        return 0
      }
      case "at": {
        const [x, y] = [Number(args.positional[1]), Number(args.positional[2])]
        if (!Number.isInteger(x) || !Number.isInteger(y)) return fail("usage: winvm ui at <x> <y>")
        const r = await ui.at(x, y)
        out(r, `window: ${r.window}${r.element === undefined ? "" : `\nelement: ${formatElement(r.element)}`}`)
        return 0
      }
      case "focus": {
        const r = await ui.focus(sel, t)
        out(r, `${formatElement(r.window)}${r.foreground ? "" : "  (NOT foreground)"}`)
        return r.foreground ? 0 : 1
      }
      default: {
        const action: Action | undefined = verb === "set" ? "setvalue" : ACTIONS.find((a) => a === verb)
        if (action === undefined) return fail(`unknown verb "${verb}"\n${USAGE}`)
        const value = args.flags.get("value")
        if ((action === "setvalue" || action === "type") && value === undefined) return fail(`${verb} needs --value <text>`)
        const settleMs = dur(args, "settle", "ms")
        const r = await ui.act(action, sel, { ...t, ...(value === undefined ? {} : { value }), ...(settleMs === undefined ? {} : { settleMs }) })
        out(r, `${r.did}: ${formatElement(r.element)}${r.at === undefined ? "" : ` at ${String(r.at[0])},${String(r.at[1])}`}  (${took()})`)
        return 0
      }
    }
  } catch (error) {
    if (error instanceof UiError) return fail(`${error.code}: ${error.message}`)
    return fail(error instanceof Error ? error.message : String(error))
  }
}
