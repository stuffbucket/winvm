import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
  appendEntry,
  type Entry,
  endCursor,
  MAX_LINE_BYTES,
  qmpEvent,
  readSince,
  rotateEvents,
  START,
  waitForEvent,
} from "../src/eventlog"
import { type Paths, pathsFor } from "../src/paths"

const NAME = "t"
let home = ""
let savedHome: string | undefined
let p: Paths

beforeEach(() => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync(resolve(tmpdir(), "winvm-log-"))
  process.env.WINVM_HOME = home
  p = pathsFor(NAME)
  mkdirSync(p.dir, { recursive: true })
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const shutdown = {
  kind: "qmp",
  event: "SHUTDOWN",
  data: { guest: true, reason: "guest-shutdown" },
  timestamp: { seconds: 1_763_000_000, microseconds: 250 },
} as const

const note = (
  what: string,
): { readonly kind: "service"; readonly what: string } => ({
  kind: "service",
  what,
})

const all = (): readonly Entry[] => readSince(NAME, START).entries

const lateLine = (what: string): string =>
  `${JSON.stringify({ t: "2026-11-01T00:00:00.000Z", instance: NAME, kind: "service", what })}\n`

const whats = (entries: readonly Entry[]): readonly string[] =>
  entries.map((e) => (e.kind === "service" ? e.what : e.kind))

const legacyLine = (fields: Record<string, unknown>): string =>
  `${JSON.stringify({ t: "2026-11-01T00:00:00.000Z", instance: NAME, ...fields })}\n`

describe("writing the event record", () => {
  it("appends one JSON line per entry, its time and instance first", () => {
    const line = appendEntry(NAME, shutdown)
    expect(line).not.toBeNull()
    const raw = readFileSync(p.events, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(raw.split("\n")).toHaveLength(2)
    expect(raw.startsWith('{"t":"')).toBe(true)
    expect(all()).toEqual([
      {
        t: expect.any(String) as string,
        instance: NAME,
        ...shutdown,
      },
    ])
  })

  it("drops an entry it cannot serialize rather than failing its caller", () => {
    expect(
      appendEntry(NAME, { kind: "warning", what: "odd", n: 1n }),
    ).toBeNull()
    expect(existsSync(p.events)).toBe(false)
  })

  it("never creates a missing instance directory to write into", () => {
    rmSync(p.dir, { recursive: true, force: true })
    expect(appendEntry(NAME, note("started"))).toBeNull()
    expect(existsSync(p.dir)).toBe(false)
  })

  it("cuts an oversized entry down to its short fields instead of writing an unbounded line", () => {
    const paths = Array.from(
      { length: 5000 },
      (_, i) => `C:\\dir\\file-${String(i)}`,
    )
    appendEntry(NAME, { kind: "service", what: "share notices sent", paths })
    const raw = readFileSync(p.events, "utf8")
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_LINE_BYTES)
    expect(all()).toEqual([
      {
        t: expect.any(String) as string,
        instance: NAME,
        kind: "service",
        what: "share notices sent",
        truncated: expect.any(Number) as number,
      },
    ])
  })

  it("keeps every line whole while several processes append at once", async () => {
    const script = resolve(home, "writer.ts")
    writeFileSync(
      script,
      [
        `import { appendEntry } from ${JSON.stringify(resolve(import.meta.dir, "../src/eventlog.ts"))}`,
        `const pad = "x".repeat(3000)`,
        `for (let i = 0; i < 150; i += 1) appendEntry(${JSON.stringify(NAME)}, { kind: "service", what: \`w\${process.argv[2]}-\${String(i)}\`, pad })`,
      ].join("\n"),
    )
    const writers = ["a", "b", "c", "d"].map((w) =>
      Bun.spawn([process.execPath, script, w], {
        env: { ...process.env, WINVM_HOME: home },
        stdout: "ignore",
        stderr: "inherit",
      }),
    )
    await Promise.all(writers.map(async (w) => await w.exited))
    const lines = readFileSync(p.events, "utf8").trimEnd().split("\n")
    expect(lines).toHaveLength(600)
    for (const line of lines)
      expect(() => JSON.parse(line) as unknown).not.toThrow()
    const seen = new Set(all().map((e) => (e.kind === "service" ? e.what : "")))
    expect(seen.size).toBe(600)
  }, 30_000)
})

describe("reading the event record", () => {
  it("reads lines written before this format as the QMP events they came from", () => {
    writeFileSync(
      p.events,
      [
        legacyLine({ kind: "service", what: "started" }),
        legacyLine({ kind: "state", state: "paused" }),
        legacyLine({ kind: "state", state: "running" }),
        legacyLine({
          kind: "state",
          state: "stopped",
          data: { guest: true, reason: "host-qmp-quit" },
        }),
        legacyLine({ kind: "state", state: "reset", data: { guest: true } }),
        legacyLine({ kind: "state", state: "migration", status: "completed" }),
        legacyLine({ kind: "warning", what: "share notices", error: "boom" }),
      ].join(""),
    )
    const legacy = (
      event: string,
      data: Record<string, unknown> | null,
    ): Entry => ({
      t: "2026-11-01T00:00:00.000Z",
      instance: NAME,
      kind: "qmp",
      event,
      data,
      timestamp: null,
      legacy: true,
    })
    expect(all()).toEqual([
      {
        t: "2026-11-01T00:00:00.000Z",
        instance: NAME,
        kind: "service",
        what: "started",
      },
      legacy("STOP", null),
      legacy("RESUME", null),
      legacy("SHUTDOWN", { guest: true, reason: "host-qmp-quit" }),
      legacy("RESET", { guest: true }),
      legacy("MIGRATION", { status: "completed" }),
      {
        t: "2026-11-01T00:00:00.000Z",
        instance: NAME,
        kind: "warning",
        what: "share notices",
        error: "boom",
      },
    ])
  })

  it("leaves a partly written last line unread, and reads it once it is finished", () => {
    appendEntry(NAME, note("one"))
    const whole = JSON.stringify({
      t: "2026-11-01T00:00:00.000Z",
      instance: NAME,
      kind: "service",
      what: "two",
    })
    appendFileSync(p.events, whole.slice(0, 20))
    const first = readSince(NAME, START)
    expect(
      first.entries.map((e) => (e.kind === "service" ? e.what : "")),
    ).toEqual(["one"])
    appendFileSync(p.events, `${whole.slice(20)}\n`)
    const second = readSince(NAME, first.cursor)
    expect(
      second.entries.map((e) => (e.kind === "service" ? e.what : "")),
    ).toEqual(["two"])
    expect(readSince(NAME, second.cursor).entries).toEqual([])
  })

  it("recovers the entry that follows a line a crash left torn", () => {
    appendFileSync(
      p.events,
      '{"t":"2026-11-01T00:00:00.000Z","instance":"t","ki',
    )
    appendEntry(NAME, shutdown)
    expect(all()).toEqual([
      { t: expect.any(String) as string, instance: NAME, ...shutdown },
    ])
  })

  it("skips lines it cannot read and kinds it does not know", () => {
    writeFileSync(
      p.events,
      [
        "not json\n",
        "[]\n",
        legacyLine({ kind: "telepathy", what: "x" }),
        legacyLine({ kind: "qmp" }),
        legacyLine({ kind: "op", phase: "begin" }),
        legacyLine({ kind: "service", what: "kept" }),
      ].join(""),
    )
    expect(all().map((e) => e.kind)).toEqual(["service"])
  })

  it("starts a cursor taken now after everything already recorded", () => {
    appendEntry(NAME, note("before"))
    const cursor = endCursor(NAME)
    expect(readSince(NAME, cursor).entries).toEqual([])
    appendEntry(NAME, note("after"))
    expect(
      readSince(NAME, cursor).entries.map((e) =>
        e.kind === "service" ? e.what : "",
      ),
    ).toEqual(["after"])
  })

  it("counts a line still being written when the cursor was taken as after it", () => {
    appendEntry(NAME, note("before"))
    const whole = JSON.stringify({
      t: "2026-11-01T00:00:00.000Z",
      instance: NAME,
      kind: "service",
      what: "during",
    })
    appendFileSync(p.events, whole.slice(0, 10))
    const cursor = endCursor(NAME)
    appendFileSync(p.events, `${whole.slice(10)}\n`)
    expect(
      readSince(NAME, cursor).entries.map((e) =>
        e.kind === "service" ? e.what : "",
      ),
    ).toEqual(["during"])
  })

  it("reads entries written before the record existed from the start", () => {
    const cursor = endCursor(NAME)
    appendEntry(NAME, note("first"))
    expect(readSince(NAME, cursor).entries).toHaveLength(1)
  })
})

describe("bounding the event record", () => {
  it("rotates only once the record reaches its bound, keeping one older generation", () => {
    appendEntry(NAME, note("old"))
    expect(rotateEvents(NAME, 1 << 20)).toBe(false)
    expect(existsSync(p.eventsPrev)).toBe(false)
    expect(rotateEvents(NAME, 10)).toBe(true)
    expect(existsSync(p.events)).toBe(false)
    expect(existsSync(p.eventsPrev)).toBe(true)
    appendEntry(NAME, note("new"))
    expect(all().map((e) => (e.kind === "service" ? e.what : ""))).toEqual([
      "old",
      "new",
    ])
    expect(rotateEvents(NAME, 10)).toBe(true)
    expect(all().map((e) => (e.kind === "service" ? e.what : ""))).toEqual([
      "new",
    ])
  })

  it("follows a cursor across a rotation without losing or repeating entries", () => {
    appendEntry(NAME, note("one"))
    const cursor = readSince(NAME, START).cursor
    appendEntry(NAME, note("two"))
    rotateEvents(NAME, 1)
    appendEntry(NAME, note("three"))
    const r = readSince(NAME, cursor)
    expect(r.gap).toBe(false)
    expect(r.entries.map((e) => (e.kind === "service" ? e.what : ""))).toEqual([
      "two",
      "three",
    ])
    appendEntry(NAME, note("four"))
    expect(
      readSince(NAME, r.cursor).entries.map((e) =>
        e.kind === "service" ? e.what : "",
      ),
    ).toEqual(["four"])
  })

  it("says so when entries were rotated away before a cursor reached them", () => {
    appendEntry(NAME, note("one"))
    const cursor = readSince(NAME, START).cursor
    appendEntry(NAME, note("lost"))
    rotateEvents(NAME, 1)
    appendEntry(NAME, note("two"))
    rotateEvents(NAME, 1)
    appendEntry(NAME, note("three"))
    const r = readSince(NAME, cursor)
    expect(r.gap).toBe(true)
    expect(r.entries.map((e) => (e.kind === "service" ? e.what : ""))).toEqual([
      "two",
      "three",
    ])
  })

  it("never reads from before its cursor when the record rotates between its two opens", () => {
    appendEntry(NAME, note("archived"))
    rotateEvents(NAME, 1)
    appendEntry(NAME, note("one"))
    const cursor = readSince(NAME, START).cursor
    appendEntry(NAME, note("two"))
    const r = readSince(NAME, cursor, {
      betweenOpens: () => {
        rotateEvents(NAME, 1)
        appendEntry(NAME, note("three"))
      },
    })
    expect(whats(r.entries)).toEqual(["two"])
    expect(r.gap).toBe(false)
    const next = readSince(NAME, r.cursor)
    expect(whats(next.entries)).toEqual(["three"])
    expect(next.gap).toBe(false)
  })

  it("reads every entry once and in order while another process appends and rotates under it", async () => {
    const total = 3000
    const token = resolve(home, "caught-up")
    const script = resolve(home, "rotator.ts")
    writeFileSync(
      script,
      [
        `import { existsSync, rmSync, statSync } from "node:fs"`,
        `import { appendEntry, rotateEvents } from ${JSON.stringify(resolve(import.meta.dir, "../src/eventlog.ts"))}`,
        `import { pathsFor } from ${JSON.stringify(resolve(import.meta.dir, "../src/paths.ts"))}`,
        `const file = pathsFor(${JSON.stringify(NAME)}).events`,
        `const token = ${JSON.stringify(token)}`,
        `for (let i = 0; i < ${String(total)}; i += 1) {`,
        `  appendEntry(${JSON.stringify(NAME)}, { kind: "service", what: "seq", n: i })`,
        `  if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) < 8192) continue`,
        `  const until = Date.now() + 10_000`,
        `  while (!existsSync(token) && Date.now() < until) Bun.sleepSync(1)`,
        `  if (rotateEvents(${JSON.stringify(NAME)}, 8192)) rmSync(token, { force: true })`,
        `}`,
      ].join("\n"),
    )
    const writer = Bun.spawn([process.execPath, script], {
      env: { ...process.env, WINVM_HOME: home },
      stdout: "ignore",
      stderr: "inherit",
    })
    const seen: number[] = []
    let gaps = 0
    let cursor = START
    const until = Date.now() + 30_000
    while (seen.length < total && Date.now() < until) {
      const r = readSince(NAME, cursor)
      cursor = r.cursor
      if (r.gap) gaps += 1
      for (const e of r.entries)
        if (e.kind === "service" && typeof e.n === "number") seen.push(e.n)
      if (statSync(p.events, { throwIfNoEntry: false })?.ino === cursor.ino)
        writeFileSync(token, "")
      await Bun.sleep(0)
    }
    await writer.exited
    expect(gaps).toBe(0)
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i))
  }, 60_000)

  it("picks up a line written into the archive after the cursor had moved past the rotation", () => {
    appendEntry(NAME, note("one"))
    const before = readSince(NAME, START).cursor
    const late = openSync(p.events, "a")
    rotateEvents(NAME, 1)
    appendEntry(NAME, note("two"))
    const moved = readSince(NAME, before)
    expect(whats(moved.entries)).toEqual(["two"])
    writeSync(late, lateLine("late"))
    closeSync(late)
    const r = readSince(NAME, moved.cursor)
    expect(whats(r.entries)).toEqual(["late"])
    expect(r.gap).toBe(false)
    expect(readSince(NAME, r.cursor).entries).toEqual([])
  })

  it("picks up a late line in the archive behind a cursor taken just after a rotation", () => {
    appendEntry(NAME, note("one"))
    const late = openSync(p.events, "a")
    rotateEvents(NAME, 1)
    appendEntry(NAME, note("two"))
    const cursor = endCursor(NAME)
    writeSync(late, lateLine("late"))
    closeSync(late)
    expect(whats(readSince(NAME, cursor).entries)).toEqual(["late"])
  })

  for (const which of ["archive", "current file"] as const) {
    it(`reads only the newest stretch of a huge legacy ${which}, and says it skipped the rest`, () => {
      const lines = Array.from({ length: 40_000 }, (_, i) =>
        legacyLine({ kind: "service", what: `old-${String(i)}` }),
      ).join("")
      expect(Buffer.byteLength(lines)).toBeGreaterThan(3 << 20)
      writeFileSync(which === "archive" ? p.eventsPrev : p.events, lines)
      const r = readSince(NAME, START)
      expect(r.gap).toBe(true)
      expect(r.entries.length).toBeGreaterThan(1000)
      expect(r.entries.length).toBeLessThan(40_000)
      expect(whats(r.entries).at(-1)).toBe("old-39999")
      expect(whats(r.entries).every((w) => w.startsWith("old-"))).toBe(true)
    })
  }

  it("never throws from a rotation check it cannot make", () => {
    appendEntry(NAME, note("one"))
    chmodSync(p.dir, 0o000)
    try {
      expect(rotateEvents(NAME, 1)).toBe(false)
      expect(
        rotateEvents(NAME, 1, () => {
          throw new Error("no lease answer")
        }),
      ).toBe(false)
    } finally {
      chmodSync(p.dir, 0o755)
    }
    expect(
      rotateEvents(NAME, 1, () => {
        throw new Error("no lease answer")
      }),
    ).toBe(false)
  })

  it("starts over when the record was replaced underneath a cursor", () => {
    appendEntry(NAME, note("one"))
    appendEntry(NAME, note("two"))
    const cursor = readSince(NAME, START).cursor
    const aside = resolve(home, "aside")
    renameSync(p.events, aside)
    writeFileSync(p.events, "")
    rmSync(aside)
    appendEntry(NAME, note("fresh"))
    const r = readSince(NAME, cursor)
    expect(r.entries.map((e) => (e.kind === "service" ? e.what : ""))).toEqual([
      "fresh",
    ])
  })
})

describe("waiting for an entry with no service running", () => {
  it("follows the file and resolves with the first match after its cursor", async () => {
    appendEntry(NAME, shutdown)
    const since = endCursor(NAME)
    const waiting = waitForEvent(
      NAME,
      qmpEvent("SHUTDOWN"),
      Date.now() + 5000,
      {
        since,
        pollMs: 20,
      },
    )
    await Bun.sleep(100)
    appendEntry(NAME, {
      ...shutdown,
      data: { guest: false, reason: "host-signal" },
    })
    const got = await waiting
    expect(got?.event).toBe("SHUTDOWN")
    expect(got?.data).toEqual({ guest: false, reason: "host-signal" })
  })

  it("matches an entry already recorded after its cursor at once", async () => {
    const since = endCursor(NAME)
    appendEntry(NAME, note("x"))
    appendEntry(NAME, { kind: "disconnected" })
    const t0 = Date.now()
    const got = await waitForEvent(
      NAME,
      (e) => e.kind === "disconnected",
      Date.now() + 5000,
      {
        since,
        pollMs: 10_000,
      },
    )
    expect(got?.kind).toBe("disconnected")
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it("gives up with null at its deadline, ignoring matches from before its cursor", async () => {
    appendEntry(NAME, shutdown)
    const t0 = Date.now()
    expect(
      await waitForEvent(NAME, qmpEvent("SHUTDOWN"), Date.now() + 200, {
        pollMs: 20,
      }),
    ).toBeNull()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it("stops when its signal aborts", async () => {
    const ac = new AbortController()
    const waiting = waitForEvent(
      NAME,
      qmpEvent("SHUTDOWN"),
      Date.now() + 10_000,
      {
        pollMs: 10_000,
        signal: ac.signal,
      },
    )
    setTimeout(() => {
      ac.abort(new Error("called off"))
    }, 50)
    await expect(waiting).rejects.toThrow("called off")
  })
})
