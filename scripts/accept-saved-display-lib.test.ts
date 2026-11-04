import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { SOCKET_PATH_LIMIT, exitOnSignals, finish, once, runtimePin, signalExitCode, socketPathProblem } from "./accept-saved-display-lib.ts"

describe("socketPathProblem", () => {
  test("accepts paths a macOS unix socket can hold", () => {
    expect(socketPathProblem(["/tmp/wd-abc123/home/instances/accept-display/qmp-qemu.sock"])).toBeNull()
    expect(socketPathProblem(["x".repeat(SOCKET_PATH_LIMIT)])).toBeNull()
  })

  test("names the longest path when one is too long, as a default $TMPDIR makes them", () => {
    const tmp = "/var/folders/1s/zrz49vq907s90nbykdjqrghw0000gn/T"
    const dir = `${tmp}/winvm-display-abc123/home/instances/accept-display`
    const problem = socketPathProblem([`${dir}/qmp.sock`, `${dir}/tpm/swtpm-sock`])
    expect(problem).toContain(`${dir}/tpm/swtpm-sock`)
    expect(problem).toContain("shorter")
    expect(socketPathProblem(["x".repeat(SOCKET_PATH_LIMIT + 1)])).not.toBeNull()
  })
})

describe("runtimePin", () => {
  test("pins the person's runtime cache before XDG_DATA_HOME is redirected", () => {
    expect(runtimePin({}, "/Users/me/.local/share/winvm/runtime")).toEqual({ WINVM_RUNTIME_CACHE: "/Users/me/.local/share/winvm/runtime" })
  })

  test("leaves an explicit runtime alone", () => {
    expect(runtimePin({ WINVM_RUNTIME_CACHE: "/c" }, "/other")).toEqual({})
    expect(runtimePin({ WINVM_RUNTIME: "/r" }, "/other")).toEqual({})
    expect(runtimePin({ WINVM_RUNTIME_CACHE: "" }, "/other")).toEqual({ WINVM_RUNTIME_CACHE: "/other" })
  })
})

describe("once", () => {
  test("runs the cleanup one time however many callers ask, and shares its result", async () => {
    let runs = 0
    const cleanup = once(async () => {
      runs += 1
      await Promise.resolve()
      return runs
    })
    expect(await Promise.all([cleanup(), cleanup(), cleanup()])).toEqual([1, 1, 1])
    expect(await cleanup()).toBe(1)
    expect(runs).toBe(1)
  })

  test("shares a failure instead of retrying", async () => {
    let runs = 0
    const cleanup = once(async () => {
      runs += 1
      throw new Error("boom")
    })
    await expect(cleanup()).rejects.toThrow("boom")
    await expect(cleanup()).rejects.toThrow("boom")
    expect(runs).toBe(1)
  })
})

describe("finish", () => {
  test("removes the root and succeeds only for a pass whose processes are all confirmed stopped", () => {
    expect(finish({ passed: true, interrupted: null, stopped: true })).toEqual({ removeRoot: true, passed: true, exitCode: 0 })
  })

  test("keeps the root and fails when a pass could not confirm everything stopped", () => {
    expect(finish({ passed: true, interrupted: null, stopped: false })).toEqual({ removeRoot: false, passed: false, exitCode: 1 })
  })

  test("keeps the root and fails for a failed run, stopped or not", () => {
    for (const stopped of [true, false]) {
      expect(finish({ passed: false, interrupted: null, stopped })).toEqual({ removeRoot: false, passed: false, exitCode: 1 })
    }
  })

  test("keeps the root and exits with the signal's code for an interrupted run, even one marked passed", () => {
    expect(finish({ passed: false, interrupted: "SIGINT", stopped: true })).toEqual({ removeRoot: false, passed: false, exitCode: 130 })
    expect(finish({ passed: true, interrupted: "SIGTERM", stopped: true })).toEqual({ removeRoot: false, passed: false, exitCode: 143 })
  })
})

describe("exitOnSignals", () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

  function run(cleanup: () => Promise<void>) {
    const source = new EventEmitter()
    const log: string[] = []
    exitOnSignals(
      { on: (signal, listener) => source.on(signal, listener) },
      {
        interrupted: (s) => log.push(`interrupted ${s}`),
        cleanup: async () => {
          log.push("cleanup start")
          await cleanup()
          log.push("cleanup end")
        },
        report: (s) => log.push(`report ${s}`),
        exit: (code) => log.push(`exit ${String(code)}`),
      },
    )
    return { source, log }
  }

  test("marks the run interrupted, cleans up, reports, then exits 130 for SIGINT and 143 for SIGTERM", async () => {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const { source, log } = run(async () => undefined)
      source.emit(signal)
      await settle()
      expect(log).toEqual([`interrupted ${signal}`, "cleanup start", "cleanup end", `report ${signal}`, `exit ${String(code)}`])
      expect(signalExitCode(signal)).toBe(code)
    }
  })

  test("still exits non-zero after the cleanup itself fails", async () => {
    const { source, log } = run(async () => {
      throw new Error("could not stop")
    })
    source.emit("SIGTERM")
    await settle()
    expect(log.at(-1)).toBe("exit 143")
    expect(log).toContain("report SIGTERM")
  })

  test("a second signal during the cleanup does not start another or exit early", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const { source, log } = run(() => gate)
    source.emit("SIGINT")
    source.emit("SIGTERM")
    source.emit("SIGINT")
    await settle()
    expect(log).toEqual(["interrupted SIGINT", "cleanup start"])
    release()
    await settle()
    expect(log.filter((l) => l.startsWith("exit"))).toEqual(["exit 130"])
  })

  test("shares one cleanup with the normal path when the cleanup is wrapped in once", async () => {
    let stops = 0
    const cleanup = once(async () => {
      stops += 1
      await Promise.resolve()
    })
    const { source } = (() => {
      const s = new EventEmitter()
      exitOnSignals({ on: (sig, l) => s.on(sig, l) }, { interrupted: () => undefined, cleanup, report: () => undefined, exit: () => undefined })
      return { source: s }
    })()
    const normal = cleanup()
    source.emit("SIGINT")
    await normal
    await settle()
    expect(stops).toBe(1)
  })
})
