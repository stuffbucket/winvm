/**
 * `winvm mcp install|uninstall|status`: the command written, Claude Desktop's
 * config edited safely, and Claude Code driven through its CLI (a fake here).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { Launch, Ran } from "../src/mcpcmds"
import { codeConfigPath, codeInstall, codeUninstall, desktopInstall, desktopUninstall, entryMatches, findClaude, launchFor, serverName } from "../src/mcpcmds"

const APP = "/Applications/winvm.app/Contents/MacOS/winvm"
const L: Launch = { command: APP, args: ["mcp", "-i", "demo"], env: {}, from: "app" }

let dir = ""
beforeEach(() => {
  dir = realpathSync(mkdtempSync(resolve(tmpdir(), "winvm-mcpcmds-")))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const backups = (): string[] => readdirSync(dir).filter((f) => f.includes(".winvm-backup-"))

describe("the command a client runs", () => {
  it("is the app's own CLI when compiled into the app, else the CLI that runs", () => {
    expect(launchFor({ compiled: true, execPath: APP, entry: "", env: {}, instance: "demo" })).toEqual(L)
    expect(launchFor({ compiled: true, execPath: "/usr/local/bin/winvm-real", entry: "", env: {}, instance: "a" }).from).toBe("cli")
    expect(launchFor({ compiled: false, execPath: "/opt/bun", entry: "/repo/apps/cli/src/winvm.ts", env: {}, instance: "a" })).toEqual({
      command: "/opt/bun",
      args: ["/repo/apps/cli/src/winvm.ts", "mcp", "-i", "a"],
      env: {},
      from: "source",
    })
  })

  it("carries WINVM_HOME and WINVM_RUNTIME when they are set", () => {
    const l = launchFor({ compiled: true, execPath: APP, entry: "", env: { WINVM_HOME: "/s/home", WINVM_RUNTIME: "", OTHER: "x" }, instance: "a" })
    expect(l.env).toEqual({ WINVM_HOME: "/s/home" })
  })

  it("names the server after the instance", () => {
    expect(serverName("demo")).toBe("winvm-demo")
  })
})

describe("Claude Desktop's config", () => {
  const original = {
    globalShortcut: "Cmd+Space",
    mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/x"] } },
    preferences: { theme: "dark" },
  }

  it("gains the server, keeps everything else, and is backed up first", () => {
    const f = join(dir, "claude_desktop_config.json")
    writeFileSync(f, JSON.stringify(original))
    const r = desktopInstall(f, "winvm-demo", L, new Date(2026, 9, 28, 3, 4, 5))
    expect(r.changed).toBe(true)
    expect(r.backup).toBe(`${f}.winvm-backup-20261028-030405`)
    expect(JSON.parse(readFileSync(r.backup ?? "", "utf8"))).toEqual(original)
    const now = JSON.parse(readFileSync(f, "utf8")) as typeof original & { mcpServers: Record<string, unknown> }
    expect(now.globalShortcut).toBe("Cmd+Space")
    expect(now.preferences).toEqual({ theme: "dark" })
    expect(now.mcpServers["filesystem"]).toEqual(original.mcpServers.filesystem)
    expect(now.mcpServers["winvm-demo"]).toEqual({ command: APP, args: ["mcp", "-i", "demo"] })
    // Atomic replace leaves no temporary file behind.
    expect(readdirSync(dir).filter((x) => x.endsWith(".tmp"))).toEqual([])
  })

  it("does nothing the second time, and updates an entry that runs something else", () => {
    const f = join(dir, "claude_desktop_config.json")
    writeFileSync(f, JSON.stringify(original))
    desktopInstall(f, "winvm-demo", L)
    const after = readFileSync(f, "utf8")
    const again = desktopInstall(f, "winvm-demo", L)
    expect(again).toEqual({ changed: false, backup: null })
    expect(readFileSync(f, "utf8")).toBe(after)
    expect(backups().length).toBe(1)

    const moved: Launch = { ...L, command: "/Users/x/winvm", env: { WINVM_HOME: "/h" } }
    const upd = desktopInstall(f, "winvm-demo", moved, new Date(2026, 9, 28, 9, 0, 0))
    expect(upd.changed).toBe(true)
    expect((JSON.parse(readFileSync(f, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers["winvm-demo"]).toEqual({
      command: "/Users/x/winvm",
      args: ["mcp", "-i", "demo"],
      env: { WINVM_HOME: "/h" },
    })
  })

  it("is created when missing (nothing to back up), and the folder is made by Desktop, not us", () => {
    const f = join(dir, "claude_desktop_config.json")
    const r = desktopInstall(f, "winvm-demo", L)
    expect(r).toEqual({ changed: true, backup: null })
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ mcpServers: { "winvm-demo": { command: APP, args: ["mcp", "-i", "demo"] } } })
  })

  it("keeps the file's mode, and writes through a symlink to its target", () => {
    const real = join(dir, "real.json")
    writeFileSync(real, JSON.stringify(original), { mode: 0o600 })
    const link = join(dir, "claude_desktop_config.json")
    symlinkSync(real, link)
    desktopInstall(link, "winvm-demo", L)
    expect(statSync(link, { throwIfNoEntry: true }).isFile()).toBe(true)
    expect(existsSync(link)).toBe(true)
    expect((JSON.parse(readFileSync(real, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers["winvm-demo"]).toBeDefined()
    expect(statSync(real).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).some((x) => x.startsWith("real.json.winvm-backup-"))).toBe(true)
  })

  it("leaves a file that isn't valid JSON alone", () => {
    const f = join(dir, "claude_desktop_config.json")
    writeFileSync(f, "{ broken")
    expect(() => desktopInstall(f, "winvm-demo", L)).toThrow("isn't valid JSON")
    expect(readFileSync(f, "utf8")).toBe("{ broken")
    expect(backups()).toEqual([])
  })

  it("loses only the server on uninstall, and twice is harmless", () => {
    const f = join(dir, "claude_desktop_config.json")
    writeFileSync(f, JSON.stringify(original))
    desktopInstall(f, "winvm-demo", L)
    const r = desktopUninstall(f, "winvm-demo")
    expect(r.changed).toBe(true)
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual(original)
    expect(desktopUninstall(f, "winvm-demo")).toEqual({ changed: false, backup: null })
    expect(desktopUninstall(join(dir, "missing.json"), "winvm-demo")).toEqual({ changed: false, backup: null })
  })
})

describe("Claude Code", () => {
  /** A stand-in `claude` that edits the config file as the real one does. */
  function fakeClaude(config: string): { run: (argv: readonly string[]) => Ran; calls: string[][] } {
    const calls: string[][] = []
    const run = (argv: readonly string[]): Ran => {
      calls.push([...argv])
      const o = existsSync(config) ? (JSON.parse(readFileSync(config, "utf8")) as { mcpServers?: Record<string, unknown> }) : {}
      const servers = o.mcpServers ?? {}
      if (argv[1] === "add") {
        const name = argv[4] ?? ""
        if (name in servers) return { code: 1, stdout: "", stderr: `MCP server ${name} already exists in user config` }
        const dd = argv.indexOf("--")
        const env: Record<string, string> = {}
        for (let i = 5; i < dd; i += 2) {
          const [k, v] = (argv[i + 1] ?? "").split("=")
          env[k ?? ""] = v ?? ""
        }
        servers[name] = { type: "stdio", command: argv[dd + 1], args: argv.slice(dd + 2), env }
      } else if (argv[1] === "remove") {
        const name = argv[4] ?? ""
        if (!(name in servers)) return { code: 1, stdout: "", stderr: "No MCP server" }
        delete servers[name]
      }
      writeFileSync(config, JSON.stringify({ ...o, mcpServers: servers }))
      return { code: 0, stdout: "", stderr: "" }
    }
    return { run, calls }
  }

  it("adds the server in the user scope, once, and replaces one that runs something else", () => {
    const config = join(dir, ".claude.json")
    writeFileSync(config, JSON.stringify({ userID: "u", mcpServers: { other: { command: "x" } } }))
    const c = fakeClaude(config)
    const withEnv: Launch = { ...L, env: { WINVM_HOME: "/h" } }
    expect(codeInstall(c.run, config, "winvm-demo", withEnv)).toEqual({ changed: true })
    expect(c.calls).toEqual([["mcp", "add", "-s", "user", "winvm-demo", "-e", "WINVM_HOME=/h", "--", APP, "mcp", "-i", "demo"]])
    expect(codeInstall(c.run, config, "winvm-demo", withEnv)).toEqual({ changed: false })
    expect(c.calls.length).toBe(1)
    expect(codeInstall(c.run, config, "winvm-demo", L)).toEqual({ changed: true })
    expect(c.calls.slice(1).map((a) => a[1])).toEqual(["remove", "add"])
    const servers = (JSON.parse(readFileSync(config, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers
    expect(Object.keys(servers).sort()).toEqual(["other", "winvm-demo"])
    expect(entryMatches(servers["winvm-demo"] as never, L)).toBe(true)

    expect(codeUninstall(c.run, config, "winvm-demo")).toEqual({ changed: true })
    expect(codeUninstall(c.run, config, "winvm-demo")).toEqual({ changed: false })
  })

  it("surfaces what claude said when it fails", () => {
    const config = join(dir, ".claude.json")
    const run = (): Ran => ({ code: 1, stdout: "", stderr: "nope\n" })
    expect(() => codeInstall(run, config, "winvm-demo", L)).toThrow("claude mcp add failed: nope")
  })

  it("finds claude where its installers put it, and reads the config CLAUDE_CONFIG_DIR names", () => {
    const at = new Set(["/Users/x/.local/bin/claude"])
    expect(findClaude({ HOME: "/Users/x", PATH: "/usr/bin:/bin" }, (p) => at.has(p))).toBe("/Users/x/.local/bin/claude")
    expect(findClaude({ HOME: "/Users/y", PATH: "/usr/bin" }, (p) => at.has(p))).toBeNull()
    expect(findClaude({ WINVM_CLAUDE: "/c/claude" }, () => true)).toBe("/c/claude")
    expect(codeConfigPath({ HOME: "/Users/x" })).toBe("/Users/x/.claude.json")
    expect(codeConfigPath({ HOME: "/Users/x", CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/.claude.json")
  })
})
