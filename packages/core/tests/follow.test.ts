import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { appendEntry, type Cursor, endCursor, START } from "../src/eventlog"
import {
  decodeCursor,
  encodeCursor,
  type FollowOptions,
  followEvents,
} from "../src/follow"
import { PACKAGE_DIR, pathsFor } from "../src/paths"

let home = ""
let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync(resolve(tmpdir(), "winvm-follow-"))
  process.env.WINVM_HOME = home
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

function instance(name: string): void {
  const p = pathsFor(name)
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify({ image: "x", vnc: 1, created: "" }))
}

const qmp = (event: string, data: Record<string, unknown> | null = null) =>
  ({ kind: "qmp", event, data, timestamp: null }) as const

const opBegin = (operation: string) =>
  ({
    kind: "op",
    phase: "begin",
    id: `id-${operation}`,
    operation,
    pid: 4242,
    startedAt: "2026-11-16T10:00:00.000Z",
    automatic: false,
    leased: true,
  }) as const

type Line = Record<string, unknown> & { readonly type: string }

interface Run {
  readonly lines: Line[]
  readonly done: Promise<number>
  stop(): void
  until(pred: (l: Line) => boolean, ms?: number): Promise<Line>
}

function run(o: Partial<FollowOptions> = {}): Run {
  const lines: Line[] = []
  const ac = new AbortController()
  const done = followEvents({
    follow: true,
    json: true,
    pollMs: 20,
    scanMs: 40,
    signal: ac.signal,
    write: (line) => {
      lines.push(JSON.parse(line) as Line)
    },
    ...o,
  })
  return {
    lines,
    done,
    stop: () => {
      ac.abort()
    },
    until: async (pred, ms = 3000) => {
      const deadline = Date.now() + ms
      for (;;) {
        const hit = lines.find(pred)
        if (hit !== undefined) return hit
        if (Date.now() > deadline)
          throw new Error(`not seen in ${JSON.stringify(lines)}`)
        await sleep(10)
      }
    },
  }
}

const entries = (lines: readonly Line[]): string[] =>
  lines
    .filter((l) => l.type === "entry")
    .map((l) => {
      const e = l.entry as { kind: string; event?: string; phase?: string }
      return `${String(l.instance)}:${e.event ?? `${e.kind}-${e.phase ?? ""}`}`
    })

describe("the cursor token", () => {
  it("round-trips every instance's position and refuses anything else", () => {
    instance("a")
    appendEntry("a", qmp("STOP"))
    const at = new Map<string, Cursor>([
      ["a", endCursor("a")],
      ["b", START],
    ])
    const token = encodeCursor(at)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(token)).toEqual(at)
    for (const bad of [
      "",
      "not a token",
      Buffer.from("[]").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, at: { a: { ino: "x" } } })).toString(
        "base64url",
      ),
    ])
      expect(decodeCursor(bad)).toBeNull()
  })
})

describe("following the record of every instance", () => {
  it("says hello with the instances it follows, then streams what is appended after it began, in order", async () => {
    instance("a")
    instance("b")
    appendEntry("a", qmp("STOP"))
    const r = run()
    const hello = await r.until((l) => l.type === "hello")
    expect(hello.instances).toEqual(["a", "b"])
    expect(typeof hello.cursor).toBe("string")
    appendEntry("a", qmp("RESUME"))
    appendEntry("b", opBegin("stop"))
    appendEntry("a", { kind: "disconnected", reason: "qemu-closed" })
    await r.until(
      (l) =>
        l.type === "entry" &&
        l.instance === "a" &&
        (l.entry as { kind: string }).kind === "disconnected",
    )
    await r.until((l) => l.type === "entry" && l.instance === "b")
    r.stop()
    expect(await r.done).toBe(0)
    const seen = entries(r.lines)
    expect(seen.filter((s) => s.startsWith("a:"))).toEqual([
      "a:RESUME",
      "a:disconnected-",
    ])
    expect(seen.filter((s) => s.startsWith("b:"))).toEqual(["b:op-begin"])
    const full = r.lines.find((l) => l.type === "entry" && l.instance === "b")
    expect(full?.entry).toMatchObject({
      kind: "op",
      phase: "begin",
      operation: "stop",
      pid: 4242,
      instance: "b",
    })
  })

  it("follows only the named instance with one", async () => {
    instance("a")
    instance("b")
    const r = run({ instance: "b" })
    expect((await r.until((l) => l.type === "hello")).instances).toEqual(["b"])
    appendEntry("a", qmp("STOP"))
    appendEntry("b", qmp("RESUME"))
    await r.until((l) => l.type === "entry")
    await sleep(100)
    r.stop()
    await r.done
    expect(entries(r.lines)).toEqual(["b:RESUME"])
  })

  it("announces an instance that appears and streams it from its first entry; and one that goes", async () => {
    instance("a")
    const r = run()
    await r.until((l) => l.type === "hello")
    instance("b")
    appendEntry("b", qmp("RESUME"))
    const added = await r.until((l) => l.type === "instances")
    expect(added.instances).toEqual(["a", "b"])
    await r.until((l) => l.type === "entry" && l.instance === "b")
    rmSync(pathsFor("a").dir, { recursive: true, force: true })
    const gone = await r.until(
      (l) =>
        l.type === "instances" &&
        JSON.stringify(l.instances) === JSON.stringify(["b"]),
    )
    expect(gone.instances).toEqual(["b"])
    r.stop()
    await r.done
  })

  it("resumes from any line's cursor without losing or repeating an entry", async () => {
    instance("a")
    const first = run()
    await first.until((l) => l.type === "hello")
    appendEntry("a", qmp("STOP"))
    appendEntry("a", qmp("RESUME"))
    const stop = await first.until(
      (l) =>
        l.type === "entry" && (l.entry as { event?: string }).event === "STOP",
    )
    await first.until(
      (l) => (l.entry as { event?: string } | undefined)?.event === "RESUME",
    )
    first.stop()
    await first.done
    appendEntry("a", qmp("SHUTDOWN", { guest: true, reason: "guest-shutdown" }))

    const again = run({ since: String(stop.cursor) })
    await again.until(
      (l) => (l.entry as { event?: string } | undefined)?.event === "SHUTDOWN",
    )
    again.stop()
    await again.done
    expect(entries(again.lines)).toEqual(["a:RESUME", "a:SHUTDOWN"])
  })

  it("says so when entries were rotated away under it", async () => {
    instance("a")
    appendEntry("a", qmp("STOP"))
    const token = encodeCursor(new Map([["a", endCursor("a")]]))
    const p = pathsFor("a")
    renameSync(p.events, p.eventsPrev)
    appendEntry("a", qmp("RESUME"))
    renameSync(p.events, p.eventsPrev)
    appendEntry("a", qmp("RESET"))
    const r = run({ since: token })
    const gap = await r.until((l) => l.type === "gap")
    expect(gap.instance).toBe("a")
    await r.until(
      (l) => (l.entry as { event?: string } | undefined)?.event === "RESET",
    )
    r.stop()
    await r.done
  })

  it("prints what is kept and ends with the cursor to resume from, without --follow", async () => {
    instance("a")
    appendEntry("a", qmp("STOP"))
    appendEntry("a", qmp("RESUME"))
    const r = run({ follow: false })
    expect(await r.done).toBe(0)
    expect(entries(r.lines)).toEqual(["a:STOP", "a:RESUME"])
    const end = r.lines.at(-1)
    expect(end?.type).toBe("end")
    appendEntry("a", qmp("RESET"))
    const next = run({ follow: false, since: String(end?.cursor) })
    await next.done
    expect(entries(next.lines)).toEqual(["a:RESET"])
  })

  it("refuses a cursor it did not give out", async () => {
    const errors: string[] = []
    const r = run({ since: "nonsense", error: (m) => errors.push(m) })
    expect(await r.done).toBe(2)
    expect(errors.join("\n")).toContain("cursor")
  })

  it("ends at once when its signal aborts, even mid-wait", async () => {
    instance("a")
    const r = run({ pollMs: 60_000, scanMs: 60_000 })
    await r.until((l) => l.type === "hello")
    const t0 = Date.now()
    r.stop()
    expect(await r.done).toBe(0)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it("writes one plain line per entry without --json", async () => {
    instance("a")
    appendEntry("a", opBegin("stow"))
    const out: string[] = []
    const r = run({ follow: false, json: false, write: (l) => out.push(l) })
    await r.done
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("a")
    expect(out[0]).toContain("stow")
  })
})

describe("winvm events", () => {
  const cli = resolve(PACKAGE_DIR, "..", "..", "apps", "cli", "src", "winvm.ts")

  const spawnFollow = (): ReturnType<typeof Bun.spawn> =>
    Bun.spawn([process.execPath, cli, "events", "--follow", "--json"], {
      env: { ...process.env, WINVM_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

  async function firstLines(
    child: ReturnType<typeof Bun.spawn>,
    n: number,
  ): Promise<Line[]> {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    let text = ""
    const deadline = Date.now() + 20_000
    while (text.split("\n").filter((l) => l !== "").length < n) {
      if (Date.now() > deadline) throw new Error(`only got ${text}`)
      const r = await reader.read()
      if (r.done) break
      text += new TextDecoder().decode(r.value)
    }
    reader.releaseLock()
    return text
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Line)
  }

  async function exits(child: ReturnType<typeof Bun.spawn>): Promise<{
    code: number | null
    ms: number
  }> {
    const t0 = Date.now()
    const code = await Promise.race([
      child.exited,
      sleep(5000).then(() => null),
    ])
    return { code, ms: Date.now() - t0 }
  }

  it("streams the record as JSON lines and ends cleanly when its stdin closes", async () => {
    instance("a")
    const child = spawnFollow()
    try {
      const [hello] = await firstLines(child, 1)
      expect(hello?.type).toBe("hello")
      appendEntry("a", qmp("STOP"))
      const [entry] = await firstLines(child, 1)
      expect(entry).toMatchObject({ type: "entry", instance: "a" })
      ;(child.stdin as { end(): void }).end()
      const { code, ms } = await exits(child)
      expect(code).toBe(0)
      expect(ms).toBeLessThan(3000)
    } finally {
      child.kill("SIGKILL")
    }
  }, 30_000)

  it("ends cleanly on SIGTERM", async () => {
    instance("a")
    const child = spawnFollow()
    try {
      await firstLines(child, 1)
      child.kill("SIGTERM")
      const { code, ms } = await exits(child)
      expect(code).toBe(0)
      expect(ms).toBeLessThan(3000)
    } finally {
      child.kill("SIGKILL")
    }
  }, 30_000)
})
