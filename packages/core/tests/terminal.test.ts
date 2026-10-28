/**
 * Terminals: the protocol pieces (auth from a subprotocol, the query, control
 * messages, the frames to conpty.exe, the client URL), and GET /term end to end
 * with the REAL agent on the host and a stand-in for conpty.exe
 * (fakes/conpty.ts) that speaks the same frames. The pseudo-console itself only
 * exists in the guest.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { parseArgs } from "../src/args"
import {
  FrameReader,
  parseTermControl,
  parseTermQuery,
  resizePayload,
  startAgent,
  termFrame,
  termProtocols,
  termShellArgv,
} from "../src/guestagent"
import { shellFlag, termClientProtocols, termUrl } from "../src/termcmds"

const TOKEN = "t0k3n-for-terminals"
const SLOW_HOST_MS = 300_000

describe("the token as a subprotocol", () => {
  it("finds our protocol and the token, in any order", () => {
    expect(termProtocols("winvm-term, winvm-token.abc123")).toEqual({ offered: true, token: "abc123" })
    expect(termProtocols("winvm-token.abc123,winvm-term")).toEqual({ offered: true, token: "abc123" })
    expect(termProtocols("winvm-term")).toEqual({ offered: true, token: null })
    expect(termProtocols("chat, winvm-token.x")).toEqual({ offered: false, token: "x" })
    expect(termProtocols(null)).toEqual({ offered: false, token: null })
  })

  it("is what the client offers", () => {
    expect(termClientProtocols("abc")).toEqual(["winvm-term", "winvm-token.abc"])
  })
})

describe("GET /term's query", () => {
  const q = (s: string): ReturnType<typeof parseTermQuery> => parseTermQuery(new URLSearchParams(s))
  it("defaults to pwsh at 80x24 in the profile", () => {
    expect(q("")).toEqual({ shell: "pwsh", cwd: null, cols: 80, rows: 24 })
    expect(q("shell=cmd&cwd=C%3A%5CWindows&cols=132&rows=40")).toEqual({ shell: "cmd", cwd: "C:\\Windows", cols: 132, rows: 40 })
    expect(q("cwd=")).toEqual({ shell: "pwsh", cwd: null, cols: 80, rows: 24 })
  })
  it("refuses other shells and sizes out of range", () => {
    expect(q("shell=bash")).toHaveProperty("error")
    expect(q("cols=0")).toHaveProperty("error")
    expect(q("rows=1001")).toHaveProperty("error")
    expect(q("cols=8.5")).toHaveProperty("error")
  })
})

describe("control messages", () => {
  it("takes a resize, and nothing malformed", () => {
    expect(parseTermControl('{"type":"resize","cols":120,"rows":30}')).toEqual({ type: "resize", cols: 120, rows: 30 })
    expect(parseTermControl('{"type":"resize","cols":"120","rows":30}')).toBeNull()
    expect(parseTermControl('{"type":"resize","cols":0,"rows":30}')).toBeNull()
    expect(parseTermControl('{"type":"bell"}')).toBeNull()
    expect(parseTermControl("dir\r")).toBeNull()
  })
})

describe("frames to and from conpty.exe", () => {
  it("survive arriving a byte at a time, and several in one piece", () => {
    const a = termFrame("o", new TextEncoder().encode("héllo"))
    const b = termFrame("r", resizePayload(132, 40))
    const c = termFrame("x", new Uint8Array([255, 255, 255, 255]))
    const bytes = new Uint8Array([...a, ...b, ...c])
    const r = new FrameReader()
    const got = [...bytes].flatMap((byte) => r.push(new Uint8Array([byte])))
    expect(got.map((f) => f.type)).toEqual(["o", "r", "x"])
    expect(new TextDecoder().decode(got[0]?.payload)).toBe("héllo")
    expect([...(got[1]?.payload ?? [])]).toEqual([132, 0, 40, 0])
    expect(new FrameReader().push(bytes).length).toBe(3)
  })
})

describe("the shell's command line in the guest", () => {
  const PS7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
  const WINPS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  it("finds PowerShell 7, else says Windows PowerShell stands in", () => {
    const env = { ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows;C:\\Tools\\" }
    expect(termShellArgv("pwsh", { win: true, env, exists: (f) => f === PS7 })).toEqual({ argv: [PS7, "-NoLogo"], note: null })
    expect(termShellArgv("pwsh", { win: true, env, exists: (f) => f === "C:\\Tools\\pwsh.exe" }).argv[0]).toBe("C:\\Tools\\pwsh.exe")
    const none = termShellArgv("pwsh", { win: true, env, exists: () => false })
    expect(none.argv).toEqual([WINPS, "-NoLogo"])
    expect(none.note).toContain("Windows PowerShell")
    expect(termShellArgv("powershell", { win: true, env, exists: () => true })).toEqual({ argv: [WINPS, "-NoLogo"], note: null })
    expect(termShellArgv("cmd", { win: true, env })).toEqual({ argv: ["C:\\Windows\\System32\\cmd.exe"], note: null })
  })
})

describe("winvm terminal's arguments", () => {
  it("builds the URL the Mac app adds its size to", () => {
    expect(termUrl(4242, { shell: "pwsh" })).toBe("ws://127.0.0.1:4242/term?shell=pwsh")
    expect(termUrl(4242, { shell: "cmd", cwd: "C:\\Users\\Public" })).toBe("ws://127.0.0.1:4242/term?shell=cmd&cwd=C%3A%5CUsers%5CPublic")
    expect(termUrl(4242, { shell: "powershell", cwd: null, cols: 100, rows: 30 })).toBe("ws://127.0.0.1:4242/term?shell=powershell&cols=100&rows=30")
  })
  it("checks --shell", () => {
    expect(shellFlag(parseArgs([]))).toBe("pwsh")
    expect(shellFlag(parseArgs(["--shell", "cmd"]))).toBe("cmd")
    expect(() => shellFlag(parseArgs(["--shell", "bash"]))).toThrow("--shell")
  })
})

// --- over a real WebSocket ---------------------------------------------------

let dir: string
let server: ReturnType<typeof startAgent>
let base: string

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "winvm-term-"))
  const tokenFile = resolve(dir, "token")
  writeFileSync(tokenFile, TOKEN)
  server = startAgent({
    port: 0,
    hostname: "127.0.0.1",
    tokenFile,
    allowFrom: ["127.0.0.1", "::1"],
    termHelper: [process.execPath, resolve(import.meta.dir, "fakes", "conpty.ts")],
  })
  base = `ws://127.0.0.1:${String(server.port)}`
})
afterAll(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** A client that keeps everything it is sent. */
class Client {
  readonly ws: WebSocket
  out = ""
  readonly events: unknown[] = []
  readonly opened: Promise<boolean>
  readonly closed: Promise<number>
  constructor(url: string, init?: string[] | { headers: Record<string, string> }) {
    this.ws = init === undefined ? new WebSocket(url) : Array.isArray(init) ? new WebSocket(url, init) : new WebSocket(url, init)
    this.ws.binaryType = "arraybuffer"
    this.opened = new Promise((res) => {
      this.ws.addEventListener("open", () => res(true))
      this.ws.addEventListener("error", () => res(false))
    })
    this.closed = new Promise((res) => this.ws.addEventListener("close", (e) => res(e.code)))
    this.ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") this.events.push(JSON.parse(e.data))
      else this.out += new TextDecoder().decode(new Uint8Array(e.data as ArrayBuffer))
    })
  }
  type(s: string): void {
    this.ws.send(new TextEncoder().encode(s))
  }
  async until(re: RegExp): Promise<RegExpExecArray> {
    for (;;) {
      const m = re.exec(this.out)
      if (m !== null) return m
      await Bun.sleep(10)
    }
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("GET /term", () => {
  it("authenticates by subprotocol, answers winvm-term, relays both ways, resizes, and reports the exit code", async () => {
    const c = new Client(`${base}/term?shell=cmd&cwd=C%3A%5Cx&cols=100&rows=30`, termClientProtocols(TOKEN))
    expect(await c.opened).toBe(true)
    expect(c.ws.protocol).toBe("winvm-term")
    await c.until(/ready cmd 100x30 cwd=C:\\x/)
    c.type("dir")
    await c.until(/dir/)
    c.ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }))
    await c.until(/resized 132x40/)
    c.type("\rexit 3\r")
    expect(await c.closed).toBe(1000)
    expect(c.events).toEqual([{ type: "exit", code: 3 }])
  }, SLOW_HOST_MS)

  it("takes the bearer header too, and defaults to pwsh at 80x24", async () => {
    const c = new Client(`${base}/term`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(await c.opened).toBe(true)
    expect(c.ws.protocol).toBe("")
    await c.until(/ready pwsh 80x24 cwd=-/)
    c.type("exit 0\r")
    expect(await c.closed).toBe(1000)
    expect(c.events).toEqual([{ type: "exit", code: 0 }])
  }, SLOW_HOST_MS)

  it("refuses a wrong or missing token", async () => {
    expect(await new Client(`${base}/term`, termClientProtocols("nope")).opened).toBe(false)
    expect(await new Client(`${base}/term`).opened).toBe(false)
    expect(await new Client(`${base}/term`, ["winvm-term"]).opened).toBe(false)
  })

  it("answers a bad query over HTTP, before upgrading", async () => {
    const r = await fetch(`http://127.0.0.1:${String(server.port)}/term?shell=bash`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toContain("shell")
  })

  it("ends the helper when the client closes the socket", async () => {
    const c = new Client(`${base}/term?shell=cmd`, termClientProtocols(TOKEN))
    const pid = Number((await c.until(/pid=(\d+)/))[1])
    expect(alive(pid)).toBe(true)
    c.ws.close()
    await c.closed
    while (alive(pid)) await Bun.sleep(20)
  }, SLOW_HOST_MS)

  it("passes on the helper's error and closes", async () => {
    const c = new Client(`${base}/term?shell=cmd`, termClientProtocols(TOKEN))
    await c.until(/ready/)
    c.type("fail\r")
    expect(await c.closed).toBe(1011)
    expect(c.events).toEqual([{ type: "error", message: "it failed" }])
  }, SLOW_HOST_MS)

  it("keeps several sessions apart", async () => {
    const [a, b] = [new Client(`${base}/term?shell=cmd`, termClientProtocols(TOKEN)), new Client(`${base}/term?shell=powershell`, termClientProtocols(TOKEN))]
    await Promise.all([a.until(/ready cmd/), b.until(/ready powershell/)])
    a.type("only-a")
    b.type("only-b")
    await Promise.all([a.until(/only-a/), b.until(/only-b/)])
    expect(a.out).not.toContain("only-b")
    expect(b.out).not.toContain("only-a")
    a.type("\rexit 11\r")
    b.type("\rexit 22\r")
    await Promise.all([a.closed, b.closed])
    expect(a.events).toEqual([{ type: "exit", code: 11 }])
    expect(b.events).toEqual([{ type: "exit", code: 22 }])
  }, SLOW_HOST_MS)
})
