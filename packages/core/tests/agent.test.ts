/**
 * The in-guest agent and its host client, with the REAL agent served on the
 * host (it is plain Bun) — no VM. Windows-only parts (PowerShell, tasklist,
 * sessions) are covered by their parsers.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"

import { AgentClient, AgentError } from "../src/agent"
import { TIMED_OUT, destination, execResult, execTimeoutMs, formatListing } from "../src/agentcmds"
import { ensureState, forwardedPorts, hostfwdRule, readState } from "../src/agentfwd"
import { parseArgs } from "../src/args"
import type { Paths } from "../src/paths"
import {
  AGENT_VERSION,
  DisplayHost,
  isWithin,
  launcherArgv,
  normalizeDir,
  parseLauncherPid,
  parseRecycled,
  parseTasklist,
  recycleFailure,
  recycleScript,
  startAgent,
} from "../src/guestagent"

let dir: string
let tokenFile: string
let server: ReturnType<typeof startAgent>
let client: AgentClient
const TOKEN = "t0k3n-for-tests"
/** Per-test timeout for what spawns processes: a loaded host is slow, not broken. */
const SLOW_HOST_MS = 300_000

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "winvm-agent-"))
  tokenFile = resolve(dir, "token")
  writeFileSync(tokenFile, `${TOKEN}\n`)
  server = startAgent({ port: 0, hostname: "127.0.0.1", tokenFile, allowFrom: ["127.0.0.1", "::1"] })
  client = new AgentClient(`http://127.0.0.1:${String(server.port)}`, TOKEN)
})
afterAll(() => {
  server.stop()
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
  }, SLOW_HOST_MS)

  // NO WALL-CLOCK BOUNDS IN HERE. On a host loaded with guests this file has
  // stalled for minutes (measured: this test at 183 s, in one `check` of six),
  // so a "< 3 s" or a fixed 100 ms sleep is a coin toss. What is asserted is
  // the outcome; how long it may take is the test timeout's job, generous
  // because a slow host is not a failure.
  it("kills a command that overruns its timeout", async () => {
    // Ten minutes: it only ever ends early by being killed.
    const r = await client.exec(["sleep", "600"], { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.code).not.toBe(0)
  }, SLOW_HOST_MS)

  // Bun's fetch drops a connection idle for 5 minutes, and /exec sends nothing
  // until the command ends: every exec over 300 s failed, whatever its deadline
  // (measured, Bun 1.3.14). Waiting that out here would take five minutes, so
  // this checks that every request turns the idle timer off.
  it("turns off Bun's idle timeout, so only the request's own deadline applies", async () => {
    const seen: unknown[] = []
    const real = globalThis.fetch
    const spy = spyOn(globalThis, "fetch").mockImplementation(((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push((init as { timeout?: unknown } | undefined)?.timeout)
      return real(input, init)
    }) as typeof fetch)
    try {
      await client.health()
      await client.exec(["true"])
      await client.pwsh("1").catch(() => undefined) // no PowerShell here; the request is what counts
    } finally {
      spy.mockRestore()
    }
    expect(seen).toEqual([false, false, false])
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
  }, SLOW_HOST_MS)

  it("launches detached, lists and kills", async () => {
    const { pid } = await client.launch(["sleep", "600"])
    expect(pid).toBeGreaterThan(0)
    expect((await client.procs()).some((p) => p.pid === pid)).toBe(true)
    await client.kill(pid)
    // Gone once the kill is delivered and the zombie reaped: asked until it
    // is, not after a fixed pause.
    const alive = async (): Promise<boolean> => (await client.procs()).some((p) => p.pid === pid && !p.name.includes("defunct"))
    while (await alive()) await Bun.sleep(50)
  }, SLOW_HOST_MS)

  it("reports a missing program as an error, not a hang", async () => {
    const err = (await client.exec(["/no/such/program"]).catch((e: unknown) => e)) as AgentError
    expect(err.status).toBe(500)
  }, SLOW_HOST_MS)

  it("reports memory and the system drive's space without starting anything", async () => {
    const s = await client.stats()
    expect(s.memory.total).toBeGreaterThan(0)
    expect(s.memory.available).toBeGreaterThan(0)
    expect(s.memory.available).toBeLessThanOrEqual(s.memory.total)
    expect(s.disk?.path).toBe("/")
    expect(s.disk?.free).toBeLessThanOrEqual(s.disk?.total ?? 0)
  })
})

describe("the display helper, kept running", () => {
  // A stand-in for `winvm-display.exe serve`: echoes each request's words; "hang" never answers; "die" exits.
  const fake = (): string => {
    const f = resolve(dir, "fake-display.ts")
    writeFileSync(
      f,
      `let buf = ""
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c)
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (line === "die") process.exit(1)
    if (line !== "hang") console.log(JSON.stringify({ words: line.split(" "), pid: process.pid }))
  }
}`,
    )
    return f
  }

  it("answers requests in order from one process", async () => {
    const host = new DisplayHost([process.execPath, fake()])
    try {
      const [a, b] = await Promise.all([host.call(["set", "1920", "1200", "2000", "200"], 10_000), host.call(["get"], 10_000)])
      const ja = JSON.parse(a) as { words: string[]; pid: number }
      const jb = JSON.parse(b) as { words: string[]; pid: number }
      expect(ja.words).toEqual(["set", "1920", "1200", "2000", "200"])
      expect(jb.words).toEqual(["get"])
      expect(ja.pid).toBe(jb.pid)
    } finally {
      host.stop()
    }
  }, SLOW_HOST_MS)

  it("stops a helper that does not answer, and starts a fresh one for the next request", async () => {
    const host = new DisplayHost([process.execPath, fake()])
    try {
      const first = JSON.parse(await host.call(["get"], 10_000)) as { pid: number }
      expect(await host.call(["hang"], 300).catch((e: unknown) => String(e))).toContain("did not answer")
      const next = JSON.parse(await host.call(["get"], 10_000)) as { pid: number }
      expect(next.pid).not.toBe(first.pid)
      expect(await host.call(["die"], 10_000).catch((e: unknown) => String(e))).toContain("exited")
      expect((JSON.parse(await host.call(["get"], 10_000)) as { words: string[] }).words).toEqual(["get"])
    } finally {
      host.stop()
    }
  }, SLOW_HOST_MS)
})

describe("folder listings", () => {
  let root: string

  beforeAll(() => {
    root = resolve(dir, "listing")
    mkdirSync(resolve(root, "b folder"), { recursive: true })
    mkdirSync(resolve(root, "A folder"))
    writeFileSync(resolve(root, "file10.txt"), "ten")
    writeFileSync(resolve(root, "file2.txt"), "two!")
    writeFileSync(resolve(root, ".hidden"), "")
    symlinkSync(resolve(root, "A folder"), resolve(root, "link to folder"))
    utimesSync(resolve(root, "file2.txt"), new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  })

  it("lists folders first, then files, by name as Explorer orders them, with sizes and times", async () => {
    const l = await client.list(root)
    expect(l.path).toBe(root)
    expect(l.parent).toBe(dir)
    expect(l.entries.map((e) => [e.name, e.dir])).toEqual([
      ["A folder", true],
      ["b folder", true],
      ["link to folder", true],
      ["file2.txt", false],
      ["file10.txt", false],
    ])
    const two = l.entries.find((e) => e.name === "file2.txt")
    expect(two).toEqual({ name: "file2.txt", dir: false, size: 4, modified: 1_700_000_000_000, hidden: false })
    expect(l.entries[0]?.size).toBeNull()
    expect(l.total).toBe(5)
  })

  it("leaves hidden entries out unless asked, and marks them", async () => {
    expect((await client.list(root)).entries.some((e) => e.name === ".hidden")).toBe(false)
    const all = await client.list(root, { hidden: true })
    expect(all.entries.find((e) => e.name === ".hidden")?.hidden).toBe(true)
    expect(all.total).toBe(6)
  })

  it("cuts a big folder at the limit and says how many there are", async () => {
    const l = await client.list(root, { limit: 2 })
    expect(l.entries.map((e) => e.name)).toEqual(["A folder", "b folder"])
    expect(l.total).toBe(5)
  })

  it("lists the Desktop when given no path, with the known folders that exist", async () => {
    // The agent's user's profile; not the host's own, whose Desktop macOS may refuse.
    const profile = resolve(dir, "profile")
    mkdirSync(resolve(profile, "Desktop"), { recursive: true })
    mkdirSync(resolve(profile, "Documents"))
    const was = process.env["USERPROFILE"]
    process.env["USERPROFILE"] = profile
    try {
      const l = await client.list()
      expect(l.path).toBe(resolve(profile, "Desktop"))
      expect(l.places.map((p) => [p.kind, p.path])).toEqual([
        ["desktop", resolve(profile, "Desktop")],
        ["documents", resolve(profile, "Documents")],
        ["home", profile],
        ["drive", "/"],
      ])
      expect(l.places.find((p) => p.kind === "home")?.name).toBe("profile")
    } finally {
      if (was === undefined) delete process.env["USERPROFILE"]
      else process.env["USERPROFILE"] = was
    }
  })

  it("normalizes the path, and a drive's root has no parent", async () => {
    expect((await client.list(`${root}/b folder/..`)).path).toBe(root)
    expect((await client.list("/")).parent).toBeNull()
    expect(normalizeDir(`${root}/./b folder`)).toBe(resolve(root, "b folder"))
  })

  it("says why a folder could not be listed: missing, not a folder, access denied", async () => {
    const code = async (path: string): Promise<[number, string | null]> => {
      const e = (await client.list(path).catch((x: unknown) => x)) as AgentError
      return [e.status, e.code]
    }
    expect(await code(resolve(root, "nope"))).toEqual([404, "notfound"])
    expect(await code(resolve(root, "file2.txt"))).toEqual([400, "notdir"])
    const locked = resolve(dir, "locked")
    mkdirSync(locked, { mode: 0o000 })
    try {
      // root reads anything, so only for anyone else does this mean something.
      if (process.getuid?.() !== 0) expect(await code(locked)).toEqual([403, "denied"])
    } finally {
      chmodSync(locked, 0o700)
    }
  })

  it("prints a listing as Windows' `dir` lays it out", () => {
    const text = formatListing({
      path: "C:\\Users\\me\\Desktop",
      parent: "C:\\Users\\me",
      entries: [
        { name: "Projects", dir: true, size: null, modified: null, hidden: false },
        { name: "notes.txt", dir: false, size: 12_345, modified: null, hidden: false },
      ],
      total: 3,
      places: [],
    }).split("\n")
    expect(text[0]).toBe("C:\\Users\\me\\Desktop")
    expect(text[1]).toEndWith("<DIR>  Projects")
    expect(text[2]).toEndWith("12,345  notes.txt")
    expect(text[3]).toContain("1 more")
  })
})

describe("changing files", () => {
  let root: string
  const at = (...parts: string[]): string => resolve(root, ...parts)
  const code = async (p: Promise<unknown>): Promise<[number, string | null]> => {
    const e = (await p.catch((x: unknown) => x)) as AgentError
    expect(e).toBeInstanceOf(AgentError)
    return [e.status, e.code]
  }

  beforeAll(() => {
    root = resolve(dir, "changing")
    mkdirSync(at("folder", "inner"), { recursive: true })
    writeFileSync(at("folder", "inner", "deep.txt"), "deep")
    writeFileSync(at("folder", "top.txt"), "top")
    writeFileSync(at("taken.txt"), "taken")
  })

  it("makes a folder, but not one that's there or in a folder that isn't", async () => {
    expect(await client.mkdir(at("New folder"))).toEqual({ path: at("New folder") })
    expect(statSync(at("New folder")).isDirectory()).toBe(true)
    expect(await code(client.mkdir(at("New folder")))).toEqual([409, "exists"])
    expect(await code(client.mkdir(at("nowhere", "New folder")))).toEqual([404, "notfound"])
    expect(await code(client.mkdir(at("taken.txt", "New folder")))).toEqual([400, "notdir"])
  })

  it("renames, and changes only the case of a name", async () => {
    writeFileSync(at("a.txt"), "a")
    expect(await client.rename(at("a.txt"), at("b.txt"))).toEqual({ path: at("b.txt") })
    expect(readFileSync(at("b.txt"), "utf8")).toBe("a")
    await client.rename(at("b.txt"), at("B.txt"))
    expect(readdirSync(root)).toContain("B.txt")
    expect(readdirSync(root)).not.toContain("b.txt")
    rmSync(at("B.txt"))
  })

  it("never renames over something, nor something that isn't there", async () => {
    writeFileSync(at("mine.txt"), "mine")
    expect(await code(client.rename(at("mine.txt"), at("taken.txt")))).toEqual([409, "exists"])
    expect(readFileSync(at("taken.txt"), "utf8")).toBe("taken")
    expect(await code(client.rename(at("ghost.txt"), at("spirit.txt")))).toEqual([404, "notfound"])
    expect(await code(client.rename(at("mine.txt"), at("nowhere", "mine.txt")))).toEqual([404, "notfound"])
    rmSync(at("mine.txt"))
  })

  it("moves into a folder, but not a folder into itself", async () => {
    writeFileSync(at("moving.txt"), "moving")
    await client.rename(at("moving.txt"), at("folder", "moving.txt"))
    expect(readFileSync(at("folder", "moving.txt"), "utf8")).toBe("moving")
    expect(await code(client.rename(at("folder"), at("folder", "inner", "folder")))).toEqual([400, "into"])
    expect(await client.rename(at("folder"), at("folder"))).toEqual({ path: at("folder") })
  })

  it("copies a file and a whole folder, and never over something", async () => {
    expect(await client.copy(at("taken.txt"), at("copy.txt"))).toEqual({ path: at("copy.txt") })
    expect(readFileSync(at("copy.txt"), "utf8")).toBe("taken")
    await client.copy(at("folder"), at("folder copy"))
    expect(readFileSync(at("folder copy", "inner", "deep.txt"), "utf8")).toBe("deep")
    expect(readFileSync(at("folder", "inner", "deep.txt"), "utf8")).toBe("deep")
    expect(await code(client.copy(at("copy.txt"), at("taken.txt")))).toEqual([409, "exists"])
    expect(await code(client.copy(at("folder"), at("folder", "inner", "again")))).toEqual([400, "into"])
    expect(await code(client.copy(at("ghost"), at("ghost copy")))).toEqual([404, "notfound"])
  })

  it("deletes for good, files and folders, and nothing when one path is missing", async () => {
    writeFileSync(at("gone.txt"), "")
    mkdirSync(at("gone", "sub"), { recursive: true })
    writeFileSync(at("gone", "sub", "x"), "")
    writeFileSync(at("stays.txt"), "")
    expect(await code(client.remove([at("stays.txt"), at("ghost")], { recycle: false }))).toEqual([404, "notfound"])
    expect(readdirSync(root)).toContain("stays.txt")
    expect(await client.remove([at("gone.txt"), at("gone")], { recycle: false })).toEqual({ deleted: 2 })
    expect(readdirSync(root)).not.toContain("gone.txt")
    expect(readdirSync(root)).not.toContain("gone")
    expect(await code(client.remove([], { recycle: false }))).toEqual([400, "bad"])
    expect(await code(client.remove(["/"], { recycle: false }))).toEqual([403, "denied"])
  })

  it("has no Recycle Bin outside Windows", async () => {
    // The Recycle Bin is the default; here it is unavailable and nothing goes.
    expect(await code(client.remove([at("stays.txt")]))).toEqual([501, "unavailable"])
    expect(readdirSync(root)).toContain("stays.txt")
  })

  it("puts mv and cp into a folder that is there, else at the path given", async () => {
    expect(await destination(client, at("taken.txt"), at("folder"))).toBe(at("folder", "taken.txt"))
    expect(await destination(client, at("taken.txt"), `${at("folder")}/`)).toBe(at("folder", "taken.txt"))
    expect(await destination(client, at("taken.txt"), at("fresh.txt"))).toBe(at("fresh.txt"))
    expect(await destination(client, at("taken.txt"), at("copy.txt"))).toBe(at("copy.txt"))
    // A folder that is `from` itself, in another case, is a rename.
    expect(await destination(client, at("folder"), at("FOLDER"))).toBe(at("FOLDER"))
  })
})

describe("the Recycle Bin's PowerShell", () => {
  it("carries every path as base64, so no name can break out of the script", () => {
    const evil = "C:\\it's ‘here’ $(Remove-Item C:\\) `n\".txt"
    const script = recycleScript(["C:\\a.txt", evil])
    expect(script).not.toContain("it's")
    expect(script).not.toContain("Remove-Item")
    expect(script).toContain(Buffer.from(evil, "utf8").toString("base64"))
    expect(script).toContain("SHFileOperation")
    // The here-string's closing '@ must start its own line.
    expect(script).toMatch(/\n'@ }\n/)
  })

  it("reads each path's result, and says what a failure means", () => {
    expect(parseRecycled("recycle 0 0\r\nrecycle 1 32\r\n", 2)).toEqual([0, 32])
    expect(parseRecycled("ERROR: Add-Type failed\n", 1)).toEqual([null])
    expect(recycleFailure(0x20, "C:\\x")).toMatchObject({ code: "busy", status: 409 })
    expect(recycleFailure(0x7c, "C:\\x")).toMatchObject({ code: "notfound", status: 404 })
    expect(recycleFailure(0x5, "C:\\x")).toMatchObject({ code: "denied", status: 403 })
    expect(recycleFailure(-1, "C:\\x").message).toContain("cancelled")
    expect(recycleFailure(0x10000, "C:\\x").message).toContain("0x10000")
  })

  it("knows when one path is inside another", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true)
    expect(isWithin("/a/b", "/a/b/c")).toBe(true)
    expect(isWithin("/a/b", "/a/bc")).toBe(false)
    expect(isWithin("/a/b", "/a")).toBe(false)
  })
})

describe("parsers", () => {
  it("launches on Windows through the session launcher, hidden, as itself", () => {
    // Not node's `detached` (DETACHED_PROCESS): Windows PowerShell started that
    // way exits 0 at once and runs nothing. The launcher gives it a console.
    const ris = "C:\\ProgramData\\winvm\\agent\\runinsession.exe"
    const argv = ["powershell.exe", "-NoProfile", "-File", "C:\\a b\\s.ps1"]
    expect(launcherArgv(ris, argv)).toEqual([ris, "--self", "--hidden", ...argv])
    expect(parseLauncherPid("session 1 pid 7984\r\n")).toBe(7984)
    expect(parseLauncherPid("CreateProcess 2\r\n")).toBeNull()
  })

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

describe("winvm exec results", () => {
  const ok = { code: 3, stdout: "out\n", stderr: "err\n", ms: 5, timedOut: false }

  it("passes a finished command's exit code and streams through", () => {
    expect(execResult(ok, 900_000)).toEqual({ exitcode: 3, stdout: "out\n", stderr: "err\n" })
  })

  it("keeps what a command killed at its deadline printed, and exits 124", () => {
    const r = execResult({ ...ok, code: 1, stdout: "step 1 done\n", stderr: "waiting on the mirror", timedOut: true }, 60_000)
    expect(r.exitcode).toBe(TIMED_OUT)
    expect(TIMED_OUT).toBe(124)
    expect(r.stdout).toBe("step 1 done\n")
    expect(r.stderr).toBe(
      "waiting on the mirror\n::error::guest command timed out after 60 s and was killed with its process tree\n",
    )
  })

  it("takes --timeout in seconds, 900 by default, and refuses nonsense", () => {
    expect(execTimeoutMs(parseArgs(["--", "cmd"]))).toBe(900_000)
    expect(execTimeoutMs(parseArgs(["--timeout", "1.5", "--", "cmd"]))).toBe(1500)
    expect(() => execTimeoutMs(parseArgs(["--timeout", "soon", "--", "cmd"]))).toThrow("--timeout wants seconds")
    expect(() => execTimeoutMs(parseArgs(["--timeout", "0", "--", "cmd"]))).toThrow("--timeout wants seconds")
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
