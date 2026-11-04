/**
 * The agent's supervisor is single-instance per port. Two of them started at
 * once (a logon's Run key racing an install's own start) used to leave the
 * loser retrying "could not start" every 30 s for ever. Real processes on the
 * host (the agent is plain Bun), an ephemeral port, a temp token: no VM.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { AgentClient } from "../src/agent"
import { agentServes, superviseLoop, type SuperviseHooks } from "../src/guestagent"

const AGENT = resolve(import.meta.dir, "..", "src", "guestagent.ts")
const TOKEN = "supervise-test-token"
/** A loaded host is slow, not broken: bound the wait by the test timeout, not by a clock assertion. */
const SLOW_HOST_MS = 120_000

let dir: string
let tokenFile: string
let logFile: string
let port: number
const children: Bun.Subprocess[] = []

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
  const p = s.port
  void s.stop(true)
  return p
}

function supervisor(extra: readonly string[] = []): Bun.Subprocess {
  const p = Bun.spawn(
    [process.execPath, AGENT, "--supervise", "--port", String(port), "--hostname", "127.0.0.1", "--token-file", tokenFile, "--log", logFile, ...extra],
    { stdio: ["ignore", "ignore", "ignore"] },
  )
  children.push(p)
  return p
}

async function untilServing(): Promise<void> {
  const c = new AgentClient(`http://127.0.0.1:${String(port)}`, TOKEN)
  for (;;) {
    if (await c.health(1000).then(() => true, () => false)) return
    await Bun.sleep(100)
  }
}

const logLines = (): string[] => {
  try {
    return readFileSync(logFile, "utf8").split("\n").filter((l) => l !== "")
  } catch {
    return []
  }
}

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "winvm-supervise-"))
  tokenFile = resolve(dir, "token")
  logFile = resolve(dir, "agent.log")
  writeFileSync(tokenFile, TOKEN)
  port = freePort()
})
afterAll(() => {
  for (const c of children) c.kill()
  rmSync(dir, { recursive: true, force: true })
})

describe("two supervisors on one port", () => {
  it("lets the second exit quietly with one line while the first keeps serving", async () => {
    const first = supervisor()
    await untilServing()
    const second = supervisor()
    expect(await second.exited).toBe(0)
    const said = logLines().filter((l) => l.includes(`another agent already serves port ${String(port)}`))
    expect(said).toHaveLength(1)
    expect(first.killed || first.exitCode !== null).toBe(false)
    await untilServing()
  }, SLOW_HOST_MS)
})

describe("two supervisors started at the same moment", () => {
  it("leaves exactly one tree: the one whose agent bound the port", async () => {
    port = freePort()
    writeFileSync(logFile, "")
    const a = supervisor()
    const b = supervisor()
    await untilServing()
    const [loser] = await Promise.race([a.exited.then((c) => [a, c] as const), b.exited.then((c) => [b, c] as const)])
    const winner = loser === a ? b : a
    expect(loser.exitCode).toBe(0)
    expect(winner.exitCode).toBeNull()
    await untilServing()
  }, SLOW_HOST_MS)
})

describe("agentServes", () => {
  it("is true for an agent, whatever token it is given", async () => {
    await untilServing()
    expect(await agentServes(port, TOKEN)).toBe(true)
    expect(await agentServes(port, "some other token")).toBe(true)
  }, SLOW_HOST_MS)

  it("is false for a listener that never answers, and for nothing at all", async () => {
    const held: unknown[] = []
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (s) => void held.push(s), data() {} } })
    try {
      expect(await agentServes(silent.port, TOKEN, 200)).toBe(false)
    } finally {
      silent.stop(true)
    }
    expect(await agentServes(freePort(), TOKEN, 200)).toBe(false)
  })

  it("is false for another web server", async () => {
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("hello") })
    try {
      expect(await agentServes(other.port, TOKEN, 1000)).toBe(false)
    } finally {
      void other.stop(true)
    }
  })
})

/** A scripted child and clock: `codes` are the exit codes of successive children. */
function scripted(codes: number[], serves: boolean | (() => boolean)): { hooks: SuperviseHooks; runs: () => number; log: string[]; sleeps: number[] } {
  let now = 0
  let runs = 0
  const log: string[] = []
  const sleeps: number[] = []
  return {
    runs: () => runs,
    log,
    sleeps,
    hooks: {
      run: async () => {
        runs++
        now += 100
        return codes[Math.min(runs - 1, codes.length - 1)] ?? 0
      },
      serves: async () => (typeof serves === "function" ? serves() : serves),
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
      now: () => now,
      log: (l) => log.push(l),
    },
  }
}

describe("superviseLoop", () => {
  it("stops after a clean exit", async () => {
    const s = scripted([0], false)
    expect(await superviseLoop(s.hooks, 7801)).toBe(0)
    expect(s.runs()).toBe(1)
  })

  it("starts the agent again after a crash, with growing backoff", async () => {
    const s = scripted([1, 3, 1, 0], false)
    expect(await superviseLoop(s.hooks, 7801)).toBe(0)
    expect(s.runs()).toBe(4)
    expect(s.sleeps).toEqual([2000, 4000, 8000])
    expect(s.log).toEqual([])
  })

  it("exits 0 with one line when another agent already serves the port", async () => {
    const s = scripted([2], true)
    expect(await superviseLoop(s.hooks, 7801)).toBe(0)
    expect(s.runs()).toBe(1)
    expect(s.log).toEqual(["another agent already serves port 7801; exiting"])
  })

  it("waits for a winner that is still starting before deciding", async () => {
    let probes = 0
    const s = scripted([2], () => ++probes >= 3)
    expect(await superviseLoop(s.hooks, 7801)).toBe(0)
    expect(probes).toBe(3)
    expect(s.runs()).toBe(1)
  })

  it("keeps retrying a stale listener with bounded backoff, then gives up once", async () => {
    const s = scripted([2], false)
    expect(await superviseLoop(s.hooks, 7801, { staleLimitMs: 120_000 })).toBe(1)
    expect(s.runs()).toBeGreaterThan(2)
    expect(Math.max(...s.sleeps)).toBeLessThanOrEqual(30_000)
    expect(s.log).toHaveLength(1)
    expect(s.log[0]).toContain("port 7801 is held but nothing answers")
  })

  it("restarts after a crash that follows a stale spell, and forgets the spell", async () => {
    const s = scripted([2, 2, 1, 0], false)
    expect(await superviseLoop(s.hooks, 7801, { staleLimitMs: 120_000 })).toBe(0)
    expect(s.runs()).toBe(4)
    expect(s.log).toEqual([])
  })
})
