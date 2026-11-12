/**
 * Cross-process VM operation records (operation.ts). `alive` and `command` are
 * injected so the real files and compare-and-swap run without signalling anything.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { parseArgs } from "../src/args"
import type { Args } from "../src/args"
import { pathsFor } from "../src/paths"
import { operationFor, readOperation, withOperation } from "../src/operation"
import type { OperationInfo, OperationReadSeams, VmOperation } from "../src/operation"

const NAME = "op-test"
let home: string
let savedHome: string | undefined

beforeAll(() => {
  savedHome = process.env["WINVM_HOME"]
  home = mkdtempSync("/tmp/wvop-")
  process.env["WINVM_HOME"] = home
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env["WINVM_HOME"]
  else process.env["WINVM_HOME"] = savedHome
})

beforeEach(() => {
  // An existing instance: the common case, and the one any command may lease.
  rmSync(pathsFor(NAME).dir, { recursive: true, force: true })
  mkdirSync(pathsFor(NAME).dir, { recursive: true })
  writeFileSync(pathsFor(NAME).meta, JSON.stringify({ image: "win11-arm64", vnc: 1, created: "2026-01-01T00:00:00.000Z" }))
})

const opsDir = (): string => pathsFor(NAME).operations
const recordPath = (pid: number): string => resolve(opsDir(), `${String(pid)}.json`)
const files = (): string[] => (existsSync(opsDir()) ? readdirSync(opsDir()).filter((f) => f.endsWith(".json")).sort() : [])

/** A record as another command would have left it. */
function put(pid: number, over: Record<string, unknown> = {}): void {
  mkdirSync(opsDir(), { recursive: true })
  const body = { operation: "stop", pid, startedAt: "2026-01-01T00:00:00.000Z", instance: NAME, token: `tok-${String(pid)}`, ...over }
  writeFileSync(recordPath(pid), JSON.stringify(body))
}

/** Every pid is alive and runs `winvm <verb>` with no selector, unless told otherwise. */
const seams = (verb = "start", over: OperationReadSeams = {}): OperationReadSeams => ({
  alive: () => true,
  command: () => `bun /repo/apps/cli/src/winvm.ts ${verb}`,
  ...over,
})

describe("operationFor", () => {
  it("maps only machine-impacting invocations, golden by its nested action", () => {
    const a = (...argv: string[]): Args => parseArgs(argv)
    for (const verb of ["start", "stop", "reboot", "kill", "reset", "snapshot", "rewind", "save", "load", "pause", "resume", "sleep", "wake", "lock", "stow", "setup"]) {
      expect(operationFor(verb, a())).toBe(verb as VmOperation)
    }
    expect(operationFor("golden", a("create"))).toBe("golden-create")
    expect(operationFor("golden", a("reset", "--name", "x"))).toBe("golden-reset")
    expect(operationFor("golden", a())).toBeNull()
    expect(operationFor("golden", a("status"))).toBeNull()
    expect(operationFor("golden", a("list"))).toBeNull()
    for (const verb of ["status", "exec", "snapshots", "saves", "destroy", "serve", "watch", "build", "doctor", "info", "clock", "ls", "open", "web", "run", "test"]) {
      expect(operationFor(verb, a())).toBeNull()
    }
    expect(operationFor(undefined, a())).toBeNull()
    // The golden operations are names for `golden <action>`, not verbs of their own.
    expect(operationFor("golden-create", a())).toBeNull()
    expect(operationFor("golden-reset", a())).toBeNull()
  })
})

describe("operation records", () => {
  it("publishes this pid and operation until the command settles", async () => {
    const during = await withOperation(NAME, "start", () => {
      expect(files()).toEqual([`${String(process.pid)}.json`])
      return readOperation(NAME, seams("start"))
    })
    expect(during).toEqual({ operation: "start", pid: process.pid, startedAt: expect.any(String) as string })
    // The lease token stays private to the record.
    expect(Object.keys(during ?? {}).sort()).toEqual(["operation", "pid", "startedAt"])
    expect(files()).toEqual([])
    expect(readOperation(NAME, seams("start"))).toBeNull()

    // A command that fails settles too.
    await expect(
      withOperation(NAME, "stop", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(files()).toEqual([])
  })

  it("keeps another pid's operation when this lease clears", async () => {
    put(4242, { operation: "save" })
    await withOperation(NAME, "start", () => undefined)
    expect(files()).toEqual(["4242.json"])
    expect(readOperation(NAME, seams("save"))).toEqual({ operation: "save", pid: 4242, startedAt: "2026-01-01T00:00:00.000Z" })
  })

  it("keeps a newer lease from this pid when an older one clears", async () => {
    let newer = ""
    await withOperation(NAME, "start", async () => {
      await withOperation(NAME, "stop", () => {
        newer = readFileSync(recordPath(process.pid), "utf8")
      })
      // The inner lease cleared its own record; the outer one finds it gone.
      expect(files()).toEqual([])
    })
    expect(newer).toContain('"operation":"stop"')

    let kept = ""
    const first = withOperation(NAME, "start", async () => {
      await Bun.sleep(30)
    })
    await Bun.sleep(5)
    // A second lease overwrites the record while the first is still running.
    const second = withOperation(NAME, "stop", async () => {
      await Bun.sleep(5)
      kept = readFileSync(recordPath(process.pid), "utf8")
      await Bun.sleep(50)
    })
    await first
    expect(kept).toContain('"operation":"stop"')
    expect(readFileSync(recordPath(process.pid), "utf8")).toContain('"operation":"stop"')
    await second
    expect(files()).toEqual([])
  })

  it("chooses the newest valid operation when records overlap", () => {
    put(101, { operation: "stop", startedAt: "2026-01-01T10:00:00.000Z" })
    put(102, { operation: "start", startedAt: "2026-01-01T11:00:00.000Z" })
    // Newest of all, but its process is gone: it must not win.
    put(103, { operation: "save", startedAt: "2026-01-01T12:00:00.000Z" })
    const verbs = new Map([
      [101, "stop"],
      [102, "start"],
      [103, "save"],
    ])
    const s = { alive: (pid: number) => pid !== 103, command: (pid: number) => `bun /repo/apps/cli/src/winvm.ts ${verbs.get(pid) ?? "?"}` }
    expect(readOperation(NAME, s)).toEqual({ operation: "start", pid: 102, startedAt: "2026-01-01T11:00:00.000Z" })
  })

  it("rejects malformed, dead, reused, wrong-instance, and wrong-verb owners", () => {
    const read = (operation: string, command: string | null, over: Record<string, unknown> = {}, alive = true): OperationInfo | null => {
      rmSync(opsDir(), { recursive: true, force: true })
      put(300, { operation, ...over })
      return readOperation(NAME, { alive: () => alive, command: () => command })
    }
    const winvm = (rest: string): string => `bun /repo/apps/cli/src/winvm.ts ${rest}`

    // What is accepted, so the rejections below are not vacuous: an explicit
    // selector naming this instance, or none (the instance the live CLI
    // process resolved, since WINVM_INSTANCE is not in `ps` text).
    for (const command of [winvm("start"), winvm(`start -i ${NAME}`), winvm(`start --instance ${NAME}`), winvm(`start --instance=${NAME} --x`)]) {
      expect(read("start", command)?.operation).toBe("start")
    }
    expect(read("golden-create", winvm(`golden create -i ${NAME}`))?.operation).toBe("golden-create")
    expect(read("golden-reset", winvm("golden reset"))?.operation).toBe("golden-reset")
    expect(read("start", "/Applications/WinVM.app/Contents/MacOS/winvm-aarch64-apple-darwin start")?.operation).toBe("start")

    // Malformed records.
    for (const raw of ["not json", "[]", "null", JSON.stringify({ operation: "start" })]) {
      rmSync(opsDir(), { recursive: true, force: true })
      mkdirSync(opsDir(), { recursive: true })
      writeFileSync(recordPath(300), raw)
      expect(readOperation(NAME, seams("start"))).toBeNull()
    }
    expect(read("format", winvm("format"))).toBeNull()
    expect(read("start", winvm("start"), { pid: 301 })).toBeNull()
    expect(read("start", winvm("start"), { startedAt: 5 })).toBeNull()
    expect(read("start", winvm("start"), { token: "" })).toBeNull()

    // A dead owner, and a pid that has been reused by something else.
    expect(read("start", winvm("start"), {}, false)).toBeNull()
    expect(read("start", null)).toBeNull()
    expect(read("start", "/usr/bin/vim notes.txt")).toBeNull()
    expect(read("start", "bun /repo/other.ts start")).toBeNull()
    expect(read("start", "bun /repo/apps/cli/src/evilwinvm.ts start")).toBeNull()

    // Another instance: the record's, or the one the command names.
    expect(read("start", winvm("start"), { instance: "other" })).toBeNull()
    expect(read("start", winvm("start -i other"))).toBeNull()
    expect(read("start", winvm("start --instance other"))).toBeNull()
    expect(read("start", winvm("start --instance=other"))).toBeNull()
    expect(read("golden-create", winvm("golden create -i other"))).toBeNull()

    // A live WinVM process running some other verb or nested action.
    expect(read("start", winvm("stop"))).toBeNull()
    expect(read("stop", winvm("start"))).toBeNull()
    expect(read("snapshot", winvm("snapshots"))).toBeNull()
    expect(read("golden-create", winvm("golden reset"))).toBeNull()
    expect(read("golden-reset", winvm("golden create"))).toBeNull()
    expect(read("golden-create", winvm("golden"))).toBeNull()
    expect(read("golden-create", winvm("golden status"))).toBeNull()
    expect(read("golden-create", winvm("start"))).toBeNull()
    expect(read("start", winvm("golden create"))).toBeNull()
  })

  it("removes only the stale record it inspected", () => {
    // Stale records are cleared as they are found: dead, reused, and malformed.
    put(501)
    put(502)
    put(503)
    writeFileSync(recordPath(504), "garbage")
    put(505, { operation: "start" })
    const live = { alive: (pid: number) => pid !== 501, command: (pid: number) => (pid === 502 ? "/usr/bin/vim" : `bun /repo/winvm.ts ${pid === 505 ? "start" : "stop"}`) }
    expect(readOperation(NAME, live)?.pid).toBe(505)
    expect(files()).toEqual(["503.json", "505.json"])

    // A record judged stale and replaced by a new owner before removal is kept:
    // the dead owner's pid is reused by a fresh command that publishes its own.
    rmSync(opsDir(), { recursive: true, force: true })
    put(601, { token: "old" })
    let replaced = false
    const racing = {
      alive: (pid: number) => {
        if (!replaced) {
          replaced = true
          put(pid, { token: "new", startedAt: "2026-02-02T00:00:00.000Z" })
        }
        return false
      },
      command: () => "bun /repo/winvm.ts stop",
    }
    expect(readOperation(NAME, racing)).toBeNull()
    expect(JSON.parse(readFileSync(recordPath(601), "utf8")).token).toBe("new")
    expect(readOperation(NAME, seams("stop"))).toEqual({ operation: "stop", pid: 601, startedAt: "2026-02-02T00:00:00.000Z" })
  })
})

describe("which instances get a lease", () => {
  const instance = (name: string): void => {
    mkdirSync(pathsFor(name).dir, { recursive: true })
    writeFileSync(pathsFor(name).meta, JSON.stringify({ image: "win11-arm64", vnc: 1, created: "2026-01-01T00:00:00.000Z" }))
  }
  const leased = async (name: string, operation: VmOperation): Promise<boolean> =>
    await withOperation(name, operation, () => existsSync(resolve(pathsFor(name).operations, `${String(process.pid)}.json`)))

  it("creates no path for a name that could leave the instances directory, and still runs the command", async () => {
    mkdirSync(resolve(home, "instances"), { recursive: true })
    const outside = ["../escape", "../../wvop-escape", "a/b", "..", ".", ""]
    for (const name of outside) {
      expect(await withOperation(name, "stop", () => "ran")).toBe("ran")
      expect(readOperation(name, seams("stop"))).toBeNull()
    }
    expect(existsSync(resolve(home, "escape"))).toBe(false)
    expect(existsSync(resolve(home, "..", "wvop-escape"))).toBe(false)
    expect(readdirSync(resolve(home, "instances"))).toEqual([NAME])
    expect(readdirSync(home).sort()).toEqual(["instances"])
  })

  it("leases an existing instance, and a valid new name only for the commands that create one", async () => {
    instance("op-existing")
    expect(await leased("op-existing", "stop")).toBe(true)
    // Not a name `create` would take today, but an instance that already exists keeps working.
    instance("My VM")
    expect(await leased("My VM", "stop")).toBe(true)

    for (const operation of ["start", "setup", "golden-create"] as const) expect(await leased(`op-new-${operation}`, operation)).toBe(true)
    // A typo'd name is not turned into an instance directory by a command that cannot create it.
    expect(await leased("op-typo", "stop")).toBe(false)
    expect(existsSync(pathsFor("op-typo").dir)).toBe(false)
    // Nor is an invalid new name, even for a creating command.
    expect(await leased("-bad name", "start")).toBe(false)
    expect(existsSync(pathsFor("-bad name").dir)).toBe(false)
    for (const n of ["op-existing", "My VM", "op-new-start", "op-new-setup", "op-new-golden-create"]) rmSync(pathsFor(n).dir, { recursive: true, force: true })
  })
})

describe("a command that exits inside its lease", () => {
  const SRC = resolve(import.meta.dir, "../src/operation.ts")
  /** Run `body` in a fresh process against this test's home; it sees `withOperation`, `recordFile` and `fs`. */
  const child = (body: string): { code: number; out: string } => {
    const script = resolve(home, `child-${String(Math.random()).slice(2)}.ts`)
    writeFileSync(
      script,
      [
        `import { withOperation } from ${JSON.stringify(SRC)}`,
        `import { writeFileSync } from "node:fs"`,
        `const recordFile = \`${opsDir()}/\${process.pid}.json\``,
        body,
      ].join("\n"),
    )
    const r = Bun.spawnSync(["bun", script], { env: { ...process.env, WINVM_HOME: home }, stdout: "pipe", stderr: "pipe" })
    rmSync(script, { force: true })
    return { code: r.exitCode, out: r.stdout.toString().trim() }
  }

  it("clears its own record when the command calls process.exit", () => {
    const r = child(`await withOperation(${JSON.stringify(NAME)}, "stop", () => { console.log(recordFile); process.exit(3) })`)
    expect(r.code).toBe(3)
    // The record existed while the command ran (the child printed its path) and is gone now.
    expect(r.out).toStartWith(opsDir())
    expect(files()).toEqual([])
  })

  it("clears the record when exit comes from a lease nested inside another of the same pid", () => {
    const r = child(
      `await withOperation(${JSON.stringify(NAME)}, "start", async () => {
         await withOperation(${JSON.stringify(NAME)}, "stop", () => { process.exit(4) })
       })`,
    )
    expect(r.code).toBe(4)
    expect(files()).toEqual([])
  })

  it("leaves a record that carries someone else's lease", () => {
    const foreign = JSON.stringify({ operation: "save", pid: 0, startedAt: "2026-01-01T00:00:00.000Z", instance: NAME, token: "newer-owner" })
    const r = child(`await withOperation(${JSON.stringify(NAME)}, "start", () => { writeFileSync(recordFile, ${JSON.stringify(foreign)}); process.exit(5) })`)
    expect(r.code).toBe(5)
    expect(files()).toHaveLength(1)
    expect(JSON.parse(readFileSync(resolve(opsDir(), files()[0] ?? ""), "utf8")).token).toBe("newer-owner")
  })

  it("does not leave an exit handler behind once the command settles", async () => {
    const before = process.listenerCount("exit")
    await withOperation(NAME, "start", () => undefined)
    await expect(
      withOperation(NAME, "stop", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(process.listenerCount("exit")).toBe(before)
  })
})
