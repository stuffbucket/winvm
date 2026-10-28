/**
 * `winvm mcp`: the JSON-RPC handling, every tool against fake guests, the
 * screen tools through the real executor against a fake QMP, and the stdio
 * server itself (stdout carries protocol messages and nothing else).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { DirListing, ExecResponse } from "../src/agent"
import { AgentError } from "../src/agent"
import type { Result } from "../src/cua"
import { Computer } from "../src/cua"
import type { AgentLike, Content, Deps, Guest, ScreenLike, ToolResult } from "../src/mcp"
import { PROTOCOL_VERSIONS, TOOLS, Tools, clip, handle, macPath, normalizeKeys, shellArgv, whyNot } from "../src/mcp"
import type { Paths } from "../src/paths"
import { FakeQmp } from "./fakes/qmp"

const ok = (text = "OK"): Result => ({ content: [{ type: "text", text }], isError: false, ms: {} })
const PNG_B64 = Buffer.from("not really a png").toString("base64")

class FakeScreen implements ScreenLike {
  readonly calls: { action: string; params: Readonly<Record<string, unknown>> }[] = []
  native = { width: 1920, height: 1080 }
  async run(action: string, params: Readonly<Record<string, unknown>>): Promise<Result> {
    this.calls.push({ action, params })
    if (action === "screenshot") return { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }], isError: false, ms: {} }
    if (action === "key" && params["text"] === "nosuchkey") return { content: [{ type: "text", text: 'unknown key "nosuchkey"' }], isError: true, ms: {} }
    return await Promise.resolve(ok())
  }
  async display(): Promise<{ native: { width: number; height: number }; scale: number; size: { width: number; height: number } }> {
    const scale = Math.min(1, 1280 / this.native.width, 800 / this.native.height)
    return await Promise.resolve({ native: this.native, scale, size: { width: Math.round(this.native.width * scale), height: Math.round(this.native.height * scale) } })
  }
  close(): void {}
}

class FakeGuestAgent implements AgentLike {
  readonly execs: { argv: readonly string[]; o: Readonly<Record<string, unknown>> }[] = []
  readonly puts: [string, string][] = []
  readonly gets: [string, string][] = []
  reply: ExecResponse = { code: 0, stdout: "hello\r\n", stderr: "", ms: 5, timedOut: false }
  async exec(argv: readonly string[], o: Readonly<Record<string, unknown>> = {}): Promise<ExecResponse> {
    this.execs.push({ argv, o })
    return await Promise.resolve(this.reply)
  }
  async pwsh(): Promise<{ code: number; output: string; ms: number; timedOut: boolean }> {
    return await Promise.resolve({ code: 0, output: "Windows 11 Pro 24H2 (10.0.26100.4349)\r\n", ms: 3, timedOut: false })
  }
  async list(path = ""): Promise<DirListing> {
    if (path.endsWith(".txt")) throw new AgentError("agent GET /fs/list: 400 not a folder", 400, "notdir")
    return await Promise.resolve({
      path: path === "" ? "C:\\Users\\Administrator\\Desktop" : path,
      entries: [
        { name: "work", dir: true, size: null, modified: Date.UTC(2026, 9, 1, 12, 0) },
        { name: "notes.txt", dir: false, size: 1234, modified: Date.UTC(2026, 9, 2, 12, 0) },
      ],
      total: 2,
      places: [{ kind: "desktop", path: "C:\\Users\\Administrator\\Desktop" }],
    } as unknown as DirListing)
  }
  async putFile(host: string, guest: string): Promise<{ bytes: number; ms: number }> {
    this.puts.push([host, guest])
    return await Promise.resolve({ bytes: readFileSync(host).length, ms: 1 })
  }
  async getFile(guest: string, host: string): Promise<number> {
    this.gets.push([guest, host])
    writeFileSync(host, "from windows")
    return await Promise.resolve(12)
  }
}

function fakeDeps(o: { running?: Set<string>; screen?: FakeScreen; agent?: FakeGuestAgent; extras?: (a: string, i: Readonly<Record<string, unknown>>) => Result } = {}): {
  deps: Deps
  screen: FakeScreen
  agent: FakeGuestAgent
  active: string[]
  extrasCalls: [string, Readonly<Record<string, unknown>>][]
} {
  const running = o.running ?? new Set(["demo"])
  const screen = o.screen ?? new FakeScreen()
  const ag = o.agent ?? new FakeGuestAgent()
  const active: string[] = []
  const extrasCalls: [string, Readonly<Record<string, unknown>>][] = []
  const guest = (name: string): Guest => ({
    name,
    screen,
    extras: {
      run: async (a, i) => {
        extrasCalls.push([a, i])
        return await Promise.resolve(o.extras?.(a, i) ?? ok(`did ${a}`))
      },
    },
    agent: async () => await Promise.resolve(ag),
    agentIfUp: async () => await Promise.resolve(ag),
  })
  return {
    deps: {
      check: (name) => whyNot(name, { exists: name !== "ghost", running: running.has(name), others: ["demo", "ui"] }),
      guest,
      active: async (name, work) => {
        active.push(name)
        return await work
      },
    },
    screen,
    agent: ag,
    active,
    extrasCalls,
  }
}

const text = (r: ToolResult): string => r.content.map((c: Content) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n")

describe("the protocol", () => {
  const tools = new Tools(fakeDeps().deps, "demo")
  const info = { name: "winvm-demo", version: "1.2.3" }

  it("negotiates the client's revision when it knows it, else offers its newest", async () => {
    const r = (await handle(tools, info, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })) as {
      result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } }
    }
    expect(r.result.protocolVersion).toBe("2025-06-18")
    expect(r.result.capabilities.tools).toBeDefined()
    expect(r.result.serverInfo.name).toBe("winvm-demo")
    const later = (await handle(tools, info, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } })) as { result: { protocolVersion: string } }
    expect(later.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0])
  })

  it("answers ping, ignores notifications, and refuses unknown methods and tools", async () => {
    expect(await handle(tools, info, { jsonrpc: "2.0", id: "a", method: "ping" })).toEqual({ jsonrpc: "2.0", id: "a", result: {} })
    expect(await handle(tools, info, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull()
    expect(await handle(tools, info, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull()
    expect(((await handle(tools, info, { jsonrpc: "2.0", id: 3, method: "resources/list" })) as { error: { code: number } }).error.code).toBe(-32601)
    expect(((await handle(tools, info, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } })) as { error: { code: number } }).error.code).toBe(-32602)
    expect(((await handle(tools, info, [1, 2])) as { error: { code: number } }).error.code).toBe(-32600)
  })

  it("lists every tool, each with an object schema that takes an instance", async () => {
    const r = (await handle(tools, info, { jsonrpc: "2.0", id: 5, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { type: string; properties: Record<string, unknown> } }[] } }
    expect(r.result.tools.map((t) => t.name)).toEqual([
      "screenshot", "click", "double_click", "right_click", "move", "drag", "scroll", "type", "key",
      "find_and_click", "find_text", "run", "list_files", "copy_to_windows", "copy_from_windows", "status",
    ])
    for (const t of r.result.tools) {
      expect(t.inputSchema.type).toBe("object")
      expect(t.inputSchema.properties["instance"]).toBeDefined()
    }
    expect(TOOLS.every((t) => t.description.length > 20)).toBe(true)
  })
})

describe("the tools", () => {
  it("say how to start a stopped instance, and name the ones there are for a missing one", async () => {
    const f = fakeDeps()
    const tools = new Tools(f.deps, "demo")
    const stopped = await tools.call("click", { x: 1, y: 2, instance: "ui" })
    expect(stopped.isError).toBe(true)
    expect(text(stopped)).toBe("Instance ui isn't running; start it with winvm start -i ui")
    const missing = await tools.call("screenshot", { instance: "ghost" })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('no winvm instance named "ghost"')
    expect(text(missing)).toContain("demo, ui")
    expect(f.screen.calls).toEqual([])
    // status is not an error: it is the answer.
    const st = await tools.call("status", { instance: "ui" })
    expect(st.isError).toBeUndefined()
    expect(text(st)).toContain("winvm start -i ui")
  })

  it("returns a screenshot as an image, with its size and scale", async () => {
    const f = fakeDeps()
    const r = await new Tools(f.deps, "demo").call("screenshot", {})
    expect(r.content[0]).toEqual({ type: "image", data: PNG_B64, mimeType: "image/png" })
    expect(text(r)).toContain("Screenshot 1280x720 of demo: the screen is 1920x1080, shown at 67%")
    expect(f.active).toEqual(["demo"])
  })

  it("maps clicks, moves, drags, scrolls, typing and keys onto the executor's actions", async () => {
    const f = fakeDeps()
    const tools = new Tools(f.deps, "demo")
    expect(text(await tools.call("click", { x: 10, y: 20 }))).toBe("Clicked at 10,20.")
    await tools.call("double_click", { x: 1, y: 2, modifiers: "shift" })
    await tools.call("right_click", { x: 3, y: 4 })
    await tools.call("move", { x: 5, y: 6 })
    await tools.call("drag", { x: 1, y: 1, to_x: 9, to_y: 9 })
    await tools.call("scroll", { direction: "down", amount: 2, x: 7, y: 8 })
    await tools.call("scroll", { direction: "up" })
    await tools.call("type", { text: "hi\n" })
    expect(text(await tools.call("key", { keys: "ctrl-alt-delete" }))).toBe("Pressed ctrl+alt+delete.")
    await tools.call("key", { keys: "Tab", repeat: 3 })
    expect(f.screen.calls).toEqual([
      { action: "left_click", params: { coordinate: [10, 20] } },
      { action: "double_click", params: { coordinate: [1, 2], text: "shift" } },
      { action: "right_click", params: { coordinate: [3, 4] } },
      { action: "mouse_move", params: { coordinate: [5, 6] } },
      { action: "left_click_drag", params: { start_coordinate: [1, 1], coordinate: [9, 9] } },
      { action: "scroll", params: { scroll_direction: "down", scroll_amount: 2, coordinate: [7, 8] } },
      { action: "scroll", params: { scroll_direction: "up", scroll_amount: 3 } },
      { action: "type", params: { text: "hi\n" } },
      { action: "key", params: { text: "ctrl+alt+delete" } },
      { action: "key", params: { text: "Tab", repeat: 3 } },
    ])
  })

  it("turns bad input and executor errors into tool errors", async () => {
    const tools = new Tools(fakeDeps().deps, "demo")
    const noY = await tools.call("click", { x: 1 })
    expect(noY.isError).toBe(true)
    expect(text(noY)).toBe("y is required")
    expect(text(await tools.call("click", { x: "1", y: 2 }))).toBe("x must be a number")
    expect(text(await tools.call("scroll", { direction: "down", x: 1 }))).toBe("give both x and y, or neither")
    const bad = await tools.call("key", { keys: "nosuchkey" })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain("unknown key")
  })

  it("finds and clicks controls by name, and text by OCR, through the extras", async () => {
    const f = fakeDeps({ extras: (a) => ok(a === "ocr_find" ? '"Save" centre [100, 200] 99%' : 'clicked Button "OK"') })
    const tools = new Tools(f.deps, "demo")
    expect(text(await tools.call("find_and_click", { name: "OK", window: "Notepad", button: "double" }))).toBe('clicked Button "OK"')
    expect(text(await tools.call("find_text", { text: "Save", wait: 2 }))).toContain("centre [100, 200]")
    expect(f.extrasCalls).toEqual([
      ["ui_click", { name: "OK", window: "Notepad", button: "double" }],
      ["ocr_find", { text: "Save", wait: 2 }],
    ])
  })

  it("runs commands in the chosen shell, with the exit code, output and timeout", async () => {
    const f = fakeDeps()
    const tools = new Tools(f.deps, "demo")
    const r = await tools.call("run", { command: "Get-Date", timeout_seconds: 30, cwd: "C:\\work" })
    expect(text(r)).toBe("Exit code 0.\n\nstdout:\nhello")
    const first = f.agent.execs[0]
    expect(first?.argv[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(first?.argv).toContain("-EncodedCommand")
    const script = Buffer.from(first?.argv.at(-1) ?? "", "base64").toString("utf16le")
    expect(script).toContain("\nGet-Date\n")
    expect(script).toContain("2>&1")
    expect(first?.o).toEqual({ timeoutMs: 30_000, cwd: "C:\\work" })

    await tools.call("run", { command: 'echo "a b" & ver', shell: "cmd" })
    expect(f.agent.execs[1]?.argv).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", '"echo "a b" & ver"'])
    expect(f.agent.execs[1]?.o).toEqual({ timeoutMs: 120_000, verbatim: true })

    f.agent.reply = { code: 1, stdout: "", stderr: "boom", ms: 1, timedOut: false }
    const failedRun = await tools.call("run", { command: "x", shell: "pwsh" })
    expect(failedRun.isError).toBeUndefined()
    expect(text(failedRun)).toBe("Exit code 1.\n\nstderr:\nboom")
    expect(f.agent.execs[2]?.argv[0]).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")

    f.agent.reply = { code: -1, stdout: "partial", stderr: "", ms: 1, timedOut: true }
    const late = await tools.call("run", { command: "sleep 99", timeout_seconds: 2 })
    expect(late.isError).toBe(true)
    expect(text(late)).toContain("Timed out after 2 s")
    expect(text(late)).toContain("partial")

    expect(text(await tools.call("run", { command: "x", shell: "bash" }))).toContain("shell must be")
  })

  it("lists folders, copies both ways, and reports status", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "winvm-mcp-files-"))
    try {
      const f = fakeDeps()
      const tools = new Tools(f.deps, "demo")
      const l = text(await tools.call("list_files", {}))
      expect(l).toContain("C:\\Users\\Administrator\\Desktop")
      expect(l).toContain("<DIR>  work")
      expect(l).toContain("1,234  notes.txt")
      expect(l).toContain("desktop: C:\\Users\\Administrator\\Desktop")

      mkdirSync(join(dir, "up", "sub"), { recursive: true })
      writeFileSync(join(dir, "up", "a.txt"), "aa")
      writeFileSync(join(dir, "up", "sub", "b.txt"), "bbb")
      expect(text(await tools.call("copy_to_windows", { mac_path: join(dir, "up"), windows_path: "C:\\work\\up" }))).toContain("2 files, 5 bytes")
      expect(f.agent.puts.map(([, g]) => g).sort()).toEqual(["C:\\work\\up\\a.txt", "C:\\work\\up\\sub\\b.txt"])
      const missing = await tools.call("copy_to_windows", { mac_path: join(dir, "nope"), windows_path: "C:\\x" })
      expect(missing.isError).toBe(true)
      expect(text(await tools.call("copy_to_windows", { mac_path: "relative/path", windows_path: "C:\\x" }))).toContain("absolute")

      const got = await tools.call("copy_from_windows", { windows_path: "C:\\work\\notes.txt", mac_path: join(dir, "notes.txt") })
      expect(text(got)).toContain("12 bytes")
      expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("from windows")

      const st = text(await tools.call("status", {}))
      expect(st).toContain("Instance demo is running.")
      expect(st).toContain("Screen 1920x1080; screenshots 1280x720 (scale 0.6667).")
      expect(st).toContain("Windows: Windows 11 Pro 24H2 (10.0.26100.4349).")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses the instance a call names, else its default", async () => {
    const f = fakeDeps({ running: new Set(["demo", "ui"]) })
    const tools = new Tools(f.deps, "demo")
    await tools.call("click", { x: 1, y: 1, instance: "ui" })
    await tools.call("click", { x: 1, y: 1 })
    expect(f.active).toEqual(["ui", "demo"])
  })
})

describe("helpers", () => {
  it("reads dash-joined combos as plus-joined ones", () => {
    expect(normalizeKeys("ctrl-alt-delete")).toBe("ctrl+alt+delete")
    expect(normalizeKeys("win-r")).toBe("win+r")
    expect(normalizeKeys("ctrl+minus")).toBe("ctrl+minus")
    expect(normalizeKeys("-")).toBe("-")
    expect(normalizeKeys("Return")).toBe("Return")
  })

  it("keeps the start and end of long output", () => {
    const s = `${"a".repeat(100)}${"b".repeat(100)}`
    const c = clip(s, 40)
    expect(c.startsWith("a".repeat(10))).toBe(true)
    expect(c.endsWith("b".repeat(30))).toBe(true)
    expect(c).toContain("160 characters left out")
    expect(clip("short", 40)).toBe("short")
  })

  it("wants absolute Mac paths", () => {
    expect(macPath("/tmp/x")).toBe("/tmp/x")
    expect(macPath("~/x").endsWith("/x")).toBe(true)
    expect(() => macPath("x")).toThrow("absolute")
  })

  it("encodes PowerShell scripts so quoting can't break them", () => {
    const { argv, verbatim } = shellArgv("powershell", `Write-Output "it's" ; $env:PATH`)
    expect(verbatim).toBe(false)
    expect(Buffer.from(argv.at(-1) ?? "", "base64").toString("utf16le")).toContain(`Write-Output "it's" ; $env:PATH`)
  })
})

describe("the screen tools through the real executor", () => {
  let dir = ""
  let qmp: FakeQmp
  const sent: unknown[] = []

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "winvm-mcp-qmp-"))
    qmp = new FakeQmp(join(dir, "qmp.sock"))
    sent.length = 0
    qmp.handler = (cmd) => {
      const args = (cmd["arguments"] ?? {}) as Record<string, unknown>
      if (cmd["execute"] === "screendump") {
        // A 1920x1080 grey screen, as a PPM.
        const w = 1920
        const h = 1080
        const head = Buffer.from(`P6\n${String(w)} ${String(h)}\n255\n`, "latin1")
        writeFileSync(String(args["filename"]), Buffer.concat([head, Buffer.alloc(w * h * 3, 0x80)]))
      }
      if (cmd["execute"] === "input-send-event") sent.push(args["events"])
      return { return: {} }
    }
    await qmp.listen()
  })

  afterEach(async () => {
    await qmp.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("scales a 1920x1080 screen to 1280x720 and clicks in its coordinates", async () => {
    const screen = new Computer({ qmp: join(dir, "qmp.sock") } as Paths)
    const deps: Deps = {
      check: () => null,
      guest: (name) => ({
        name,
        screen,
        extras: { run: async () => await Promise.resolve(ok()) },
        agent: async () => await Promise.reject(new Error("no agent")),
        agentIfUp: async () => await Promise.resolve(null),
      }),
      active: async (_name, work) => await work,
    }
    const tools = new Tools(deps, "t")
    try {
      const shot = await tools.call("screenshot", {})
      const img = shot.content[0]
      expect(img?.type).toBe("image")
      const png = Buffer.from(img?.type === "image" ? img.data : "", "base64")
      expect(png.readUInt32BE(16)).toBe(1280)
      expect(png.readUInt32BE(20)).toBe(720)
      expect(text(shot)).toContain("scale 0.6667")

      expect(text(await tools.call("click", { x: 640, y: 360 }))).toBe("Clicked at 640,360.")
      // The pointer went to the middle of the screen: 960,540 of 1920x1080 on the 0..32767 axis.
      const abs = sent.flat() as { type: string; data: { axis?: string; value?: number } }[]
      expect(abs.find((e) => e.data.axis === "x")?.data.value).toBe(Math.round((960 * 32767) / 1919))
      expect(abs.some((e) => e.type === "btn")).toBe(true)

      const st = text(await tools.call("status", {}))
      expect(st).toContain("Screen 1920x1080; screenshots 1280x720")
      expect(st).toContain("Windows version unknown")
    } finally {
      screen.close()
    }
  })
})

describe("the stdio server", () => {
  it("speaks only JSON-RPC on stdout and stays up for a missing instance", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "winvm-mcp-home-"))
    try {
      const cli = resolve(import.meta.dir, "..", "..", "..", "apps", "cli", "src", "winvm.ts")
      const proc = Bun.spawn([process.execPath, cli, "mcp", "-i", "nothere"], {
        env: { ...process.env, WINVM_HOME: home },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      const msgs = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "screenshot", arguments: {} } },
      ]
      proc.stdin.write(`${msgs.map((m) => JSON.stringify(m)).join("\n")}\nnot json\n`)
      await proc.stdin.end()
      const out = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      const lines = out.trim().split("\n")
      const parsed = lines.map((l) => JSON.parse(l) as { id: unknown; result?: Record<string, unknown>; error?: { code: number } })
      // Requests are answered as they finish, so in no promised order.
      const byId = (id: unknown): (typeof parsed)[number] | undefined => parsed.find((m) => m.id === id)
      expect(parsed.map((m) => String(m.id)).sort()).toEqual(["1", "2", "3", "null"])
      expect((byId(1)?.result?.["serverInfo"] as { name: string }).name).toBe("winvm-nothere")
      expect((byId(2)?.result?.["tools"] as unknown[]).length).toBe(16)
      const call = byId(3)?.result as { isError: boolean; content: { text: string }[] }
      expect(call.isError).toBe(true)
      expect(call.content[0]?.text).toContain('no winvm instance named "nothere"')
      expect(byId(null)?.error?.code).toBe(-32700)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
