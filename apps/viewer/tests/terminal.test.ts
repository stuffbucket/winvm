import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { TerminalEvent } from "@winvm/terminal"

import en from "../ui/src/i18n/en.json"
import {
  connectArgs,
  defaultShell,
  failureText,
  fromList,
  type Installed,
  installedList,
  type MenuNode,
  parseEndpoint,
  parseInstalled,
  runnable,
  shellCache,
  shellMenu,
  shellsArgs,
  shellTitle,
  START_IN,
} from "../ui/src/features/terminal/shells"
import { createSocketTransport, type SessionStatus, sizedUrl } from "../ui/src/features/terminal/socket"
import { noTabs, tabName, type Tabs, tabsReducer } from "../ui/src/features/terminal/tabs"
import { type FakeTermServer, startFakeTermServer } from "./fake-term-server"

const until = async (ok: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (ok()) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("the socket transport, against a fake guest", () => {
  let fake: FakeTermServer
  beforeAll(() => {
    fake = startFakeTermServer()
  })
  afterAll(() => fake.stop())

  const open = (id: string, statuses: SessionStatus[] = [], endpoint = fake.endpoint()) => {
    const transport = createSocketTransport({ connect: async () => endpoint, onStatus: (_, s) => statuses.push(s) })
    const events: TerminalEvent[] = []
    transport.subscribe(id, (e) => events.push(e))
    const output = (): string => events.flatMap((e) => (e.type === "data" ? [e.data] : [])).join("")
    return { transport, events, output, statuses }
  }

  it("opens with the size in the URL and the token as a subprotocol, and carries bytes both ways", async () => {
    const t = open("a")
    await t.transport.spawn({ id: "a", shell: "pwsh", cols: 100, rows: 30 })
    const session = fake.sessions.at(-1)
    expect(session?.sizes[0]).toEqual({ cols: 100, rows: 30 })
    expect(session?.protocols).toEqual(["winvm-term", `winvm-token.${fake.token}`])
    expect(t.statuses).toEqual([{ kind: "open" }])
    await until(() => t.output().includes("PS C:\\"), "the prompt")

    await t.transport.write("a", "héllo ✓\r")
    await until(() => t.output().includes("héllo ✓\r\n"), "the echo")
    expect(session?.input).toBe("héllo ✓\r")
    await t.transport.terminate("a")
  })

  it("sends a resize as a control message, once per size", async () => {
    const t = open("b")
    await t.transport.spawn({ id: "b", cols: 80, rows: 24 })
    const session = fake.sessions.at(-1)
    await t.transport.resize("b", 80, 24)
    await t.transport.resize("b", 120, 40)
    await t.transport.resize("b", 120, 40)
    await t.transport.write("b", "size\r")
    await until(() => t.output().includes("120x40"), "the new size")
    expect(session?.sizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 120, rows: 40 },
    ])
    await t.transport.terminate("b")
  })

  it("reports the shell's exit code, and nothing lost after it", async () => {
    const t = open("c")
    await t.transport.spawn({ id: "c", cols: 80, rows: 24 })
    await t.transport.write("c", "exit 3\r")
    await until(() => t.events.some((e) => e.type === "exit"), "the exit")
    expect(t.events.find((e) => e.type === "exit")).toEqual({ type: "exit", exitCode: 3 })
    await Bun.sleep(30)
    expect(t.statuses).toEqual([{ kind: "open" }, { kind: "exit", code: 3 }])
  })

  it("shows an error the guest reports, and says the connection was lost if it closes without an exit", async () => {
    const t = open("d")
    await t.transport.spawn({ id: "d", cols: 80, rows: 24 })
    await t.transport.write("d", "error no such folder\r")
    await until(() => t.statuses.some((s) => s.kind === "error"), "the error")
    expect(t.output()).toContain("\x1b[31mno such folder\x1b[0m")
    fake.stop()
    await until(() => t.statuses.some((s) => s.kind === "lost"), "the loss")
    expect(t.statuses.at(-1)).toEqual({ kind: "lost", message: "no such folder" })
    fake = startFakeTermServer()
  })

  it("rejects a spawn the guest refuses", async () => {
    const t = open("e", [], { ...fake.endpoint(), protocols: ["winvm-term", "winvm-token.wrong"] })
    await expect(t.transport.spawn({ id: "e", cols: 80, rows: 24 })).rejects.toThrow()
  })

  it("does not open a socket for a session terminated while connecting", async () => {
    let release: () => void = () => undefined
    const before = fake.sessions.length
    const transport = createSocketTransport({
      connect: () =>
        new Promise((resolve) => {
          release = () => resolve(fake.endpoint())
        }),
    })
    const spawned = transport.spawn({ id: "f", cols: 80, rows: 24 })
    await transport.terminate("f")
    release()
    await spawned
    await Bun.sleep(20)
    expect(fake.sessions.length).toBe(before)
  })

  it("holds a character split across frames until it is whole", async () => {
    const t = open("g")
    await t.transport.spawn({ id: "g", cols: 80, rows: 24 })
    await t.transport.write("g", "split\r")
    await until(() => t.output().includes("é✓\r\n"), "the split characters")
    expect(t.output()).not.toContain("\uFFFD")
    await t.transport.terminate("g")
  })
})

describe("sizedUrl", () => {
  it("adds the size to the endpoint's query", () => {
    expect(sizedUrl("ws://127.0.0.1:5000/term?shell=pwsh&cwd=C%3A%5Cwork", 90, 25)).toBe("ws://127.0.0.1:5000/term?shell=pwsh&cwd=C%3A%5Cwork&cols=90&rows=25")
  })
})

describe("shells", () => {
  it("asks the sidecar for a shell, with a folder only when one is chosen", () => {
    expect(connectArgs({ instance: "default", shell: "pwsh", cwd: null })).toEqual(["terminal", "-i", "default", "--shell", "pwsh", "--connect", "--json"])
    expect(connectArgs({ instance: "ci", shell: "cmd", cwd: "C:\\work" })).toEqual(["terminal", "-i", "ci", "--shell", "cmd", "--cwd", "C:\\work", "--connect", "--json"])
  })

  it("reads the endpoint line, and nothing else", () => {
    const line = JSON.stringify({ url: "ws://127.0.0.1:6001/term?shell=pwsh", protocols: ["winvm-term", "winvm-token.abc"] })
    expect(parseEndpoint(`${line}\n`)).toEqual({ url: "ws://127.0.0.1:6001/term?shell=pwsh", protocols: ["winvm-term", "winvm-token.abc"] })
    expect(parseEndpoint("")).toBeNull()
    expect(parseEndpoint("::error::no agent")).toBeNull()
    expect(parseEndpoint(JSON.stringify({ url: "ws://example.com:80/term", protocols: [] }))).toBeNull()
  })

  it("reports a failure by its ::error:: lines", () => {
    expect(failureText("", "::error::the agent isn't answering\n")).toBe("the agent isn't answering")
    expect(failureText("something else\n", "")).toBe("something else")
  })

  it("titles a tab by what the shell says, not by its program path", () => {
    expect(shellTitle("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBeNull()
    expect(shellTitle("Administrator: C:\\Windows\\system32\\cmd.exe")).toBeNull()
    expect(shellTitle("Administrator: vim notes.txt")).toBe("vim notes.txt")
    expect(shellTitle("build")).toBe("build")
    expect(shellTitle("  ")).toBeNull()
  })

  const label = (key: string, values: Record<string, string> = {}): string =>
    ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "")

  it("offers each shell at home, then the same shells in each other place", () => {
    const menu = shellMenu(label, null)
    expect(menu.map((n) => (n.kind === "separator" ? "---" : n.label))).toEqual([
      "PowerShell 7",
      "Windows PowerShell",
      "Command Prompt",
      "---",
      "Start in Desktop",
      "Start in C:\\work",
    ])
    const desktop = menu[4]
    expect(desktop?.kind === "submenu" ? desktop.items.map((n) => (n.kind === "item" ? n.launch : null)) : null).toEqual([
      { shell: "pwsh", cwd: START_IN[1].cwd },
      { shell: "powershell", cwd: START_IN[1].cwd },
      { shell: "cmd", cwd: START_IN[1].cwd },
    ])
    expect(menu[0]?.kind === "item" ? menu[0].launch : null).toEqual({ shell: "pwsh", cwd: null })
    expect(menu.every((n) => n.kind !== "item" || n.enabled)).toBe(true)
  })

  const noPwsh = { pwsh: false, powershell: true, cmd: true }

  it("shows PowerShell 7 disabled where the guest lacks it, at home and in each place", () => {
    const menu = shellMenu(label, noPwsh)
    const items = (nodes: readonly MenuNode[]): { label: string; enabled: boolean }[] =>
      nodes.flatMap((n) => (n.kind === "item" ? [{ label: n.label, enabled: n.enabled }] : n.kind === "submenu" ? items(n.items) : []))
    const all = items(menu)
    expect(all.filter((i) => !i.enabled).map((i) => i.label)).toEqual(Array(3).fill("PowerShell 7 (not installed)"))
    expect(all.filter((i) => i.enabled)).toHaveLength(6)
  })

  it("opens PowerShell 7 by default only where the guest has it", () => {
    expect(defaultShell(null)).toBe("pwsh")
    expect(defaultShell({ ...noPwsh, pwsh: true })).toBe("pwsh")
    expect(defaultShell(noPwsh)).toBe("powershell")
    expect(runnable({ shell: "pwsh", cwd: "C:\\work" }, noPwsh)).toEqual({ shell: "powershell", cwd: "C:\\work" })
    expect(runnable({ shell: "cmd", cwd: null }, noPwsh)).toEqual({ shell: "cmd", cwd: null })
  })

  it("asks which shells there are, and reads the answer", () => {
    expect(shellsArgs("demo")).toEqual(["terminal", "-i", "demo", "--shells", "--json"])
    expect(parseInstalled('{"pwsh":false,"powershell":true,"cmd":true}\n')).toEqual(noPwsh)
    expect(parseInstalled("::error::no agent")).toBeNull()
    expect(parseInstalled("")).toBeNull()
    expect(fromList(installedList(noPwsh) ?? [])).toEqual(noPwsh)
  })

  it("asks once per instance until told to forget, and retries a failed ask", async () => {
    const asked: string[] = []
    let answer: Installed | null = null
    const cache = shellCache(async (instance) => {
      asked.push(instance)
      return answer
    })
    expect(await cache.get("demo")).toBeNull()
    answer = noPwsh
    const [a, b] = await Promise.all([cache.get("demo"), cache.get("demo")])
    expect(a).toEqual(noPwsh)
    expect(b).toEqual(noPwsh)
    expect(await cache.get("demo")).toEqual(noPwsh)
    expect(asked).toEqual(["demo", "demo"])
    cache.forget("demo")
    await cache.get("demo")
    expect(asked).toHaveLength(3)
    cache.seed("ci", noPwsh)
    expect(await cache.get("ci")).toEqual(noPwsh)
    expect(asked).toHaveLength(3)
  })
})

describe("tabs", () => {
  const req = { instance: "default", shell: "pwsh" as const, cwd: null }
  const three = [1, 2, 3].reduce<Tabs>((s, n) => tabsReducer(s, { type: "open", id: `t${String(n)}`, request: req }), noTabs)

  it("makes a new tab active", () => {
    expect(three.active).toBe("t3")
    expect(three.tabs.map((t) => t.state.kind)).toEqual(["connecting", "connecting", "connecting"])
  })

  it("activates the tab to the right when the active one closes, else the one to the left", () => {
    const middle = tabsReducer({ ...three, active: "t2" }, { type: "close", id: "t2" })
    expect(middle.active).toBe("t3")
    const last = tabsReducer(three, { type: "close", id: "t3" })
    expect(last.active).toBe("t2")
    const other = tabsReducer(three, { type: "close", id: "t1" })
    expect(other.active).toBe("t3")
  })

  it("closes a tab whose shell exits cleanly, and marks one that doesn't", () => {
    expect(tabsReducer(three, { type: "state", id: "t1", state: { kind: "exited", code: 0 } }).tabs.map((t) => t.id)).toEqual(["t2", "t3"])
    const marked = tabsReducer(three, { type: "state", id: "t1", state: { kind: "exited", code: 1 } })
    expect(marked.tabs[0]?.state).toEqual({ kind: "exited", code: 1 })
    const after = tabsReducer(marked, { type: "state", id: "t1", state: { kind: "lost", message: null } })
    expect(after.tabs[0]?.state).toEqual({ kind: "exited", code: 1 })
  })

  it("steps through tabs, wrapping", () => {
    expect(tabsReducer(three, { type: "step", by: 1 }).active).toBe("t1")
    expect(tabsReducer(three, { type: "step", by: -1 }).active).toBe("t2")
  })

  it("reopens a tab as a new session in the same place", () => {
    const ended = tabsReducer(tabsReducer(three, { type: "title", id: "t3", title: "vim" }), { type: "state", id: "t3", state: { kind: "lost", message: null } })
    const again = tabsReducer(ended, { type: "reopen", id: "t3", newId: "t4" })
    expect(again.active).toBe("t4")
    expect(again.tabs[2]).toEqual({ ...req, id: "t4", title: null, customTitle: null, state: { kind: "connecting" } })
  })

  it("names a tab by the user's name, else the shell's title, else the shell", () => {
    const t3 = (x: Tabs) => x.tabs[2]
    const shellName = "PowerShell 7"
    const plain = t3(three)
    expect(plain && tabName(plain, shellName)).toBe("PowerShell 7")
    const titled = tabsReducer(three, { type: "title", id: "t3", title: "vim notes.txt" })
    expect(t3(titled) && tabName(t3(titled)!, shellName)).toBe("vim notes.txt")
    const renamed = tabsReducer(titled, { type: "rename", id: "t3", title: "  build  " })
    expect(t3(renamed) && tabName(t3(renamed)!, shellName)).toBe("build")
    // The shell setting its title again doesn't take the user's name away.
    const retitled = tabsReducer(renamed, { type: "title", id: "t3", title: "less log.txt" })
    expect(tabName(t3(retitled)!, shellName)).toBe("build")
    // Nor does reopening it.
    const reopened = tabsReducer(retitled, { type: "reopen", id: "t3", newId: "t9" })
    expect(tabName(t3(reopened)!, shellName)).toBe("build")
    // An empty name goes back to automatic.
    const cleared = tabsReducer(retitled, { type: "rename", id: "t3", title: "   " })
    expect(t3(cleared)?.customTitle).toBeNull()
    expect(tabName(t3(cleared)!, shellName)).toBe("less log.txt")
  })

  it("closes the other tabs", () => {
    const only = tabsReducer(three, { type: "closeOthers", id: "t2" })
    expect(only.tabs.map((t) => t.id)).toEqual(["t2"])
    expect(only.active).toBe("t2")
    expect(tabsReducer(three, { type: "closeOthers", id: "nope" })).toBe(three)
  })
})
