/**
 * The in-guest agent and its host client, with the REAL agent served on the
 * host (it is plain Bun) — no VM. Windows-only parts (PowerShell, tasklist,
 * sessions) are covered by their parsers.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { AgentClient, AgentError, ensureState, forwardedPorts, hostfwdRule, readState } from "../agent"
import type { Paths } from "../paths"
import { AGENT_VERSION, parseTasklist, startAgent } from "../guestagent"

let dir: string
let tokenFile: string
let server: ReturnType<typeof startAgent>
let client: AgentClient
const TOKEN = "t0k3n-for-tests"

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "winvm-agent-"))
  tokenFile = resolve(dir, "token")
  writeFileSync(tokenFile, `${TOKEN}\n`)
  server = startAgent({ port: 0, hostname: "127.0.0.1", tokenFile, allowFrom: ["127.0.0.1", "::1"] })
  client = new AgentClient(`http://127.0.0.1:${String(server.port)}`, TOKEN)
})
afterAll(() => {
  void server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe("agent over HTTP", () => {
  it("answers health with its version and the peer address", async () => {
    const h = await client.health()
    expect(h.ok).toBe(true)
    expect(h.version).toBe(AGENT_VERSION)
    expect(h.pid).toBe(process.pid)
    expect(h.from).toContain("127.0.0.1")
  })

  it("refuses a wrong token, and follows the token file when it changes", async () => {
    const bad = new AgentClient(client.base, "nope")
    const err = await bad.health().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).status).toBe(401)
    writeFileSync(tokenFile, "rotated")
    await Bun.sleep(5)
    expect((await new AgentClient(client.base, "rotated").health()).ok).toBe(true)
    expect(((await client.health().catch((e: unknown) => e)) as AgentError).status).toBe(401)
    writeFileSync(tokenFile, TOKEN)
  })

  it("refuses everything while there is no token", async () => {
    writeFileSync(tokenFile, "")
    expect(((await client.health().catch((e: unknown) => e)) as AgentError).status).toBe(401)
    writeFileSync(tokenFile, TOKEN)
  })

  it("execs argv with cwd, env and stdin, returning code and both streams", async () => {
    const r = await client.exec(["sh", "-c", 'echo "$X:$(pwd)"; cat; echo err >&2; exit 3'], {
      cwd: dir,
      env: { X: "hello" },
      stdin: "piped",
    })
    expect(r.code).toBe(3)
    expect(r.stdout).toBe(`hello:${realpathSync(dir)}\npiped`)
    expect(r.stderr).toBe("err\n")
    expect(r.timedOut).toBe(false)
  })

  it("kills a command that overruns its timeout", async () => {
    const t = performance.now()
    const r = await client.exec(["sleep", "10"], { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(performance.now() - t).toBeLessThan(3000)
  })

  it("puts and gets binary files, creating directories", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) & 0xff
    const target = resolve(dir, "sub", "deep", "blob.bin")
    expect((await client.put(target, bytes)).bytes).toBe(bytes.length)
    expect(Buffer.compare(Buffer.from(await client.get(target)), Buffer.from(bytes))).toBe(0)
    const out = resolve(dir, "back.bin")
    expect(await client.getFile(target, out)).toBe(bytes.length)
    const err = (await client.get(resolve(dir, "missing")).catch((e: unknown) => e)) as AgentError
    expect(err.status).toBe(404)
  })

  it("launches detached, lists and kills", async () => {
    const { pid } = await client.launch(["sleep", "30"])
    expect(pid).toBeGreaterThan(0)
    expect((await client.procs()).some((p) => p.pid === pid)).toBe(true)
    await client.kill(pid)
    await Bun.sleep(100)
    expect((await client.procs()).some((p) => p.pid === pid && !p.name.includes("defunct"))).toBe(false)
  })

  it("reports a missing program as an error, not a hang", async () => {
    const err = (await client.exec(["/no/such/program"]).catch((e: unknown) => e)) as AgentError
    expect(err.status).toBe(500)
  })
})

describe("parsers", () => {
  it("reads tasklist CSV", () => {
    const csv = '"System Idle Process","0","Services","0","8 K"\r\n"explorer.exe","3268","Console","1","120,004 K"\r\n'
    expect(parseTasklist(csv)).toEqual([
      { pid: 0, name: "System Idle Process", session: 0 },
      { pid: 3268, name: "explorer.exe", session: 1 },
    ])
  })

  it("finds the agent's forward in `info usernet`", () => {
    const out = [
      "Hub -1 (net0):",
      "  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ",
      "  TCP[HOST_FORWARD]  27       127.0.0.1 47123       10.0.2.15  7801     0     0",
      "  TCP[HOST_FORWARD]  28       127.0.0.1  2222       10.0.2.15    22     0     0",
      "  TCP[ESTABLISHED]  220       10.0.2.15 60455 199.232.210.172    80     0     0",
    ].join("\r\n")
    expect(forwardedPorts(out)).toEqual([47123])
    expect(hostfwdRule(47123)).toBe("tcp:127.0.0.1:47123-:7801")
  })
})

describe("state", () => {
  it("creates a token once and keeps it", () => {
    const p = { dir } as Paths
    const a = ensureState(p)
    expect(a.token).toMatch(/^[0-9a-f]{64}$/)
    expect(ensureState(p).token).toBe(a.token)
    expect(readState(p)?.hostPort).toBeNull()
  })
})
