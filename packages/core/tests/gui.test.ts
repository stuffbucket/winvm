/**
 * The host side of GUI driving (ui.ts, uicmds.ts) and the agent's /ui route,
 * with the real agent served on the host — where there is no UI Automation,
 * so the route must say so cleanly. The helper itself (assets/winvm-ui.cs)
 * runs only in the guest; docs/gui.md has its measurements.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { AgentClient } from "../src/agent"
import { parseArgs } from "../src/args"
import { startAgent } from "../src/guestagent"
import { UI_HELPER_VERSION, Ui, UiError, formatElement, formatTree } from "../src/ui"
import { selectorFrom } from "../src/uicmds"

let dir: string
let server: ReturnType<typeof startAgent>
let ui: Ui

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "winvm-gui-"))
  const tokenFile = resolve(dir, "token")
  writeFileSync(tokenFile, "tok")
  server = startAgent({ port: 0, hostname: "127.0.0.1", tokenFile, allowFrom: null })
  ui = new Ui(new AgentClient(`http://127.0.0.1:${String(server.port)}`, "tok"))
})
afterAll(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe("the /ui route", () => {
  it("answers 501 'unavailable' off Windows, as a UiError", async () => {
    const err = await ui.ping().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UiError)
    expect((err as UiError).code).toBe("unavailable")
    expect((err as UiError).message).toContain("Windows")
  })

  it("wants an op", async () => {
    const r = await fetch(`${ui.agent.base}/ui`, { method: "POST", headers: { authorization: "Bearer tok" }, body: "{}" })
    expect(r.status).toBe(400)
  })
})

describe("the helper's version", () => {
  it("is the one ui.ts expects", () => {
    const cs = readFileSync(resolve(import.meta.dir, "../assets/winvm-ui.cs"), "utf8")
    expect(Number(/const int VERSION = (\d+);/.exec(cs)?.[1])).toBe(UI_HELPER_VERSION)
  })
})

describe("selectors from the command line", () => {
  it("maps flags, and takes a bare word as the name", () => {
    const a = parseArgs(["click", "Quit Maximal", "--window", "Maximal", "--type", "MenuItem", "--index", "1"])
    expect(selectorFrom(a, a.positional[1])).toEqual({ window: "Maximal", name: "Quit Maximal", controlType: "MenuItem", index: 1 })
  })

  it("knows the long names", () => {
    const a = parseArgs(["find", "--process", "maximal-shell", "--contains", "Sett", "--id", "Close", "--class", "btn", "--hwnd", "42"])
    expect(selectorFrom(a, undefined)).toEqual({ process: "maximal-shell", nameContains: "Sett", automationId: "Close", className: "btn", hwnd: 42 })
  })
})

describe("formatting", () => {
  it("prints one line per element", () => {
    const line = formatElement({ name: "Settings…", controlType: "MenuItem", automationId: "Item 1008", bounds: [569, 490, 228, 22], pid: 2800 })
    expect(line).toBe('MenuItem "Settings…" id="Item 1008" [569,490 228x22] pid 2800')
  })

  it("indents a tree, and tolerates synthetic nodes with no bounds or pid", () => {
    const text = formatTree({
      name: "",
      controlType: "List",
      children: [{ name: "Maximal", controlType: "Window", bounds: null, pid: 1, enabled: false, toggle: "On" }],
    } as never)
    expect(text).toBe('List ""\n  Window "Maximal" toggle=On disabled pid 1')
  })
})
