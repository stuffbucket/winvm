import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
  olderWatcher,
  type StopSeams,
  stopOlderWatcher,
} from "../src/olderwatcher"
import { instanceDir } from "../src/paths"
import { watchPathsFor } from "../src/watch"

const HOLDER = resolve(import.meta.dir, "fakes", "holder.ts")
const START = "Sat Jan  1 00:00:00 2000"

let home = ""
let savedHome: string | undefined
const spawned: ReturnType<typeof Bun.spawn>[] = []

beforeEach(() => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync(resolve(tmpdir(), "winvm-olderwatcher-"))
  process.env.WINVM_HOME = home
  mkdirSync(instanceDir("w"), { recursive: true })
})

afterEach(() => {
  for (const s of spawned.splice(0)) s.kill("SIGKILL")
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const hold = (...argv: readonly string[]): ReturnType<typeof Bun.spawn> => {
  const h = Bun.spawn([process.execPath, HOLDER, ...argv], {
    stdout: "ignore",
    stderr: "ignore",
  })
  spawned.push(h)
  return h
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidFile = (): string => resolve(instanceDir("w"), "watch.pid")
const lock = (pid: number): void => {
  writeFileSync(pidFile(), `${String(pid)}\n`)
}
const state = (o: Record<string, unknown>): void => {
  writeFileSync(watchPathsFor("w").state, JSON.stringify(o))
}

describe("an older winvm's watcher process", () => {
  it("is found by watch.pid while it runs", () => {
    const h = hold("winvm", "watch", "-i", "w")
    lock(h.pid)
    expect(olderWatcher("w")?.pid).toBe(h.pid)
  })

  it("is not a process that started after watch.pid was written, as one given a reused pid did, and nobody signals it", async () => {
    const h = hold("winvm", "watch", "-i", "w")
    lock(h.pid)
    const before = new Date(Date.now() - 3_600_000)
    utimesSync(pidFile(), before, before)
    const kills: string[] = []
    expect(olderWatcher("w")).toBeNull()
    expect(existsSync(pidFile())).toBe(false)
    lock(h.pid)
    utimesSync(pidFile(), before, before)
    expect(
      await stopOlderWatcher("w", { kill: (_p, sig) => void kills.push(sig) }),
    ).toBe(false)
    expect(kills).toEqual([])
    expect(alive(h.pid)).toBe(true)
  })

  it("is never some other process watch.pid names, which nobody signals", async () => {
    const stranger = Bun.spawn(["sleep", "20"])
    spawned.push(stranger)
    lock(stranger.pid)
    const kills: string[] = []
    expect(
      await stopOlderWatcher("w", { kill: (_p, sig) => void kills.push(sig) }),
    ).toBe(false)
    expect(kills).toEqual([])
    expect(alive(stranger.pid)).toBe(true)
    expect(existsSync(pidFile())).toBe(false)
  })

  it("is never pid 0 or 1, whatever watch.pid says", async () => {
    for (const pid of [0, 1, -1]) {
      lock(pid)
      const kills: number[] = []
      const seams: StopSeams = {
        kill: (p) => void kills.push(p),
        startOf: () => START,
        commandOf: () => "winvm watch -i w",
      }
      expect(olderWatcher("w", seams)).toBeNull()
      lock(pid)
      expect(await stopOlderWatcher("w", seams)).toBe(false)
      expect(kills).toEqual([])
    }
  })

  const timed = (o: { readonly dies: "never" | "on-term" }) => {
    const calls: { sig: string; at: number }[] = []
    let t = 1_000
    let gone = false
    return {
      calls,
      elapsed: (): number => t - 1_000,
      seams: {
        kill: (_pid: number, sig: NodeJS.Signals): void => {
          calls.push({ sig, at: t })
          if (sig === "SIGKILL" || o.dies === "on-term") gone = true
        },
        now: (): number => t,
        sleep: (ms: number): Promise<void> => {
          t += ms
          return Promise.resolve()
        },
        startOf: (): string | null => (gone ? null : START),
        commandOf: (): string => "winvm watch -i w",
      } satisfies StopSeams,
    }
  }

  it("is given 10 seconds to finish when it is only watching, then killed", async () => {
    lock(424_242)
    state({ pid: 424_242, state: "watching" })
    const s = timed({ dies: "never" })
    expect(await stopOlderWatcher("w", s.seams)).toBe(true)
    expect(s.calls.map((c) => c.sig)).toEqual(["SIGTERM", "SIGKILL"])
    expect(s.elapsed()).toBeGreaterThanOrEqual(10_000)
    expect(s.elapsed()).toBeLessThan(11_000)
    expect(existsSync(pidFile())).toBe(false)
  })

  for (const st of ["autosaving", "stowing"] as const)
    it(`is given 10 minutes to finish when it is ${st}`, async () => {
      lock(424_242)
      state({ pid: 424_242, state: st })
      const s = timed({ dies: "never" })
      expect(await stopOlderWatcher("w", s.seams)).toBe(true)
      expect(s.calls.map((c) => c.sig)).toEqual(["SIGTERM", "SIGKILL"])
      expect(s.elapsed()).toBeGreaterThanOrEqual(600_000)
      expect(s.elapsed()).toBeLessThan(601_000)
    })

  it("is not killed when it exits after SIGTERM", async () => {
    lock(424_242)
    state({ pid: 424_242, state: "autosaving" })
    const s = timed({ dies: "on-term" })
    expect(await stopOlderWatcher("w", s.seams)).toBe(true)
    expect(s.calls.map((c) => c.sig)).toEqual(["SIGTERM"])
  })

  it("is believed to be saving only when watch.json names it", async () => {
    lock(424_242)
    state({ pid: 424_243, state: "autosaving" })
    const s = timed({ dies: "never" })
    expect(await stopOlderWatcher("w", s.seams)).toBe(true)
    expect(s.elapsed()).toBeGreaterThanOrEqual(10_000)
    expect(s.elapsed()).toBeLessThan(11_000)
  })

  it("is not killed when its pid names another process by the time of SIGKILL", async () => {
    lock(424_242)
    state({ pid: 424_242, state: "watching" })
    let t = 1_000
    const kills: string[] = []
    expect(
      await stopOlderWatcher("w", {
        kill: (_pid, sig) => void kills.push(sig),
        now: () => t,
        sleep: (ms) => {
          t += ms
          return Promise.resolve()
        },
        startOf: () => (t < 11_000 ? START : "Sun Jan  2 00:00:00 2000"),
        commandOf: () => "winvm watch -i w",
      }),
    ).toBe(true)
    expect(kills).toEqual(["SIGTERM"])
  })

  const named = (command: string): number | null => {
    lock(424_242)
    return (
      olderWatcher("w", { startOf: () => START, commandOf: () => command })
        ?.pid ?? null
    )
  }

  for (const [label, command] of [
    ["another instance's watcher", "winvm watch -i other"],
    [
      "the watcher of an instance whose name starts with this one's",
      "winvm watch -i wx",
    ],
    ["a watcher named with --instance=", "winvm watch --instance=other"],
    ["a `watch --stop` for this instance", "winvm watch -i w --stop"],
    ["a `watch --status` for this instance", "winvm watch -i w --status"],
    ["an executable whose name ends in winvm", "/tmp/evilwinvm watch -i w"],
    ["a helper whose name starts with winvm", "/tmp/winvm-helper watch -i w"],
    ["another winvm verb", "winvm serve -i w"],
  ] as const)
    it(`is never ${label}`, () => {
      expect(named(command)).toBeNull()
    })

  it("is recognised however it was named", () => {
    for (const command of [
      "/usr/local/bin/bun /repo/apps/cli/src/winvm.ts watch -i w",
      "winvm watch --instance w",
      "winvm watch --instance=w",
      "/Applications/winvm.app/Contents/MacOS/winvm-aarch64-apple-darwin watch -i w",
    ])
      expect(named(command)).toBe(424_242)
  })

  it("is never a look-alike process, before SIGTERM or SIGKILL", async () => {
    const h = hold("evilwinvm", "watch", "-i", "w")
    lock(h.pid)
    state({ pid: h.pid, state: "watching" })
    const kills: string[] = []
    expect(
      await stopOlderWatcher("w", { kill: (_p, sig) => void kills.push(sig) }),
    ).toBe(false)
    expect(kills).toEqual([])
    expect(alive(h.pid)).toBe(true)
  })
})
