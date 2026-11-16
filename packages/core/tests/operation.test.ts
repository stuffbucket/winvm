import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"
import type { Args } from "../src/args"
import { parseArgs } from "../src/args"
import { type Entry, readSince, START } from "../src/eventlog"
import type { LeaseOperation, VmOperation } from "../src/operation"
import {
  clearSavingRunning,
  InstanceBusy,
  leaseHolder,
  markSavingRunning,
  operationFor,
  readOperation,
  savingRunning,
  withOperation,
} from "../src/operation"
import { pathsFor } from "../src/paths"
import { isSameProcess, processStart } from "../src/proc"

const NAME = "op-test"
const HOLDER = resolve(import.meta.dir, "fakes", "holder.ts")
let home: string
let savedHome: string | undefined
const spawned: ReturnType<typeof Bun.spawn>[] = []

beforeAll(() => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync("/tmp/wvop-")
  process.env.WINVM_HOME = home
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
})

beforeEach(() => {
  rmSync(pathsFor(NAME).dir, { recursive: true, force: true })
  mkdirSync(pathsFor(NAME).dir, { recursive: true })
  writeFileSync(
    pathsFor(NAME).meta,
    JSON.stringify({
      image: "win11-arm64",
      vnc: 1,
      created: "2026-01-01T00:00:00.000Z",
    }),
  )
})

afterEach(() => {
  for (const h of spawned.splice(0)) h.kill("SIGKILL")
})

const leaseFile = (): string => pathsFor(NAME).lease
const onDisk = (): Record<string, unknown> | null =>
  existsSync(leaseFile())
    ? (JSON.parse(readFileSync(leaseFile(), "utf8")) as Record<string, unknown>)
    : null

async function hold(...argv: string[]): Promise<ReturnType<typeof Bun.spawn>> {
  const h = Bun.spawn([process.execPath, HOLDER, ...argv], {
    stdout: "pipe",
    stderr: "ignore",
  })
  spawned.push(h)
  const reader = (h.stdout as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  reader.releaseLock()
  return h
}

function put(pid: number, over: Record<string, unknown> = {}): void {
  const body = {
    operation: "save",
    id: `id-${String(pid)}`,
    pid,
    pidStart: processStart(pid),
    startedAt: "2026-01-01T00:00:00.000Z",
    instance: NAME,
    automatic: false,
    ...over,
  }
  writeFileSync(leaseFile(), JSON.stringify(body))
}

const gate = (): {
  readonly opened: Promise<void>
  readonly open: () => void
} => {
  let open: () => void = () => undefined
  const opened = new Promise<void>((r) => {
    open = r
  })
  return { opened, open }
}

const quietly = { onWait: (): void => undefined }

describe("operationFor", () => {
  it("maps the per-instance machine-impacting invocations, golden by its nested action", () => {
    const a = (...argv: string[]): Args => parseArgs(argv)
    for (const verb of [
      "start",
      "stop",
      "reboot",
      "kill",
      "reset",
      "snapshot",
      "rewind",
      "save",
      "load",
      "pause",
      "resume",
      "sleep",
      "wake",
      "lock",
      "stow",
    ]) {
      expect(operationFor(verb, a())).toBe(verb as VmOperation)
    }
    expect(operationFor("golden", a("create"))).toBe("golden-create")
    expect(operationFor("golden", a("reset", "--name", "x"))).toBe(
      "golden-reset",
    )
    expect(operationFor("share", a("install", "--restart"))).toBe("setup")
    expect(operationFor("destroy", a())).toBe("destroy")
    for (const [verb, rest] of [
      ["golden", []],
      ["golden", ["status"]],
      ["golden", ["list"]],
      ["share", ["status"]],
      ["share", ["set", "/x"]],
    ] as const) {
      expect(operationFor(verb, a(...rest))).toBeNull()
    }
    for (const verb of [
      "setup",
      "status",
      "exec",
      "snapshots",
      "saves",
      "serve",
      "watch",
      "build",
      "doctor",
      "info",
      "clock",
      "ls",
      "open",
      "web",
      "run",
      "test",
    ]) {
      expect(operationFor(verb, a())).toBeNull()
    }
    expect(operationFor(undefined, a())).toBeNull()
    expect(operationFor("golden-create", a())).toBeNull()
    expect(operationFor("golden-reset", a())).toBeNull()
  })
})

describe("the lease record", () => {
  it("is one file naming the operation, its holder's pid and start, and is gone once the command settles", async () => {
    const during = await withOperation(NAME, "start", () => {
      expect(
        readdirSync(pathsFor(NAME).dir).filter((f) => f.startsWith("lease")),
      ).toEqual(["lease.json"])
      return { record: onDisk(), status: readOperation(NAME) }
    })
    expect(during.record).toEqual({
      operation: "start",
      id: expect.any(String) as string,
      pid: process.pid,
      pidStart: processStart(process.pid),
      startedAt: expect.any(String) as string,
      instance: NAME,
      automatic: false,
    })
    expect(during.status).toEqual({
      operation: "start",
      pid: process.pid,
      startedAt: during.record?.startedAt as string,
    })
    expect(onDisk()).toBeNull()

    await expect(
      withOperation(NAME, "stop", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(onDisk()).toBeNull()
  })

  it("trusts a record only while its pid is still the process that started when the record says, and reading never removes one", async () => {
    const h = await hold("winvm", "save", "-i", NAME)
    put(h.pid)
    expect(readOperation(NAME)).toEqual({
      operation: "save",
      pid: h.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
    })

    put(h.pid, { pidStart: "Thu Jan  1 00:00:00 1970" })
    expect(readOperation(NAME)).toBeNull()
    expect(onDisk()?.pid).toBe(h.pid)

    const gone = Bun.spawn(["true"])
    await gone.exited
    put(gone.pid, { pidStart: "whenever" })
    expect(readOperation(NAME)).toBeNull()
    expect(onDisk()?.pid).toBe(gone.pid)

    for (const raw of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ operation: "save" }),
      JSON.stringify({ operation: "save", pid: 0 }),
    ]) {
      writeFileSync(leaseFile(), raw)
      expect(readOperation(NAME)).toBeNull()
      expect(readFileSync(leaseFile(), "utf8")).toBe(raw)
    }
    for (const over of [
      { instance: "other" },
      { id: "" },
      { startedAt: 5 },
      { pidStart: 5 },
    ]) {
      put(h.pid, over)
      expect(leaseHolder(NAME)?.pid).toBe(h.pid)
    }
  })

  it("keeps a live holder's lease when it names the instance in another case, as macOS resolves both to one file", async () => {
    const other = NAME.toUpperCase()
    if (!existsSync(pathsFor(other).meta)) return
    const script = resolve(home, "case-holder.ts")
    writeFileSync(
      script,
      [
        `import { withOperation } from ${JSON.stringify(resolve(import.meta.dir, "../src/operation.ts"))}`,
        `await withOperation(${JSON.stringify(other)}, "save", async () => { console.log("held"); await Bun.sleep(5000) })`,
      ].join("\n"),
    )
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, WINVM_HOME: home },
      stdout: "pipe",
      stderr: "ignore",
    })
    spawned.push(child)
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    reader.releaseLock()
    rmSync(script, { force: true })
    expect(readOperation(NAME)).toEqual({
      operation: "save",
      pid: child.pid,
      startedAt: expect.any(String) as string,
    })
    await expect(withOperation(NAME, "stop", () => "ran")).rejects.toThrow(
      `is busy: save (pid ${String(child.pid)})`,
    )
    expect(onDisk()?.pid).toBe(child.pid)
    expect(onDisk()?.instance).toBe(other)
  })

  it("keeps a live holder's lease whose operation this build does not know, and shows it to no one", async () => {
    const h = await hold("winvm", "defragment", "-i", NAME)
    put(h.pid, { operation: "defragment" })
    expect(readOperation(NAME)).toBeNull()
    expect(onDisk()?.operation).toBe("defragment")
    await expect(withOperation(NAME, "stop", () => "ran")).rejects.toThrow(
      `is busy: defragment (pid ${String(h.pid)})`,
    )
    expect(onDisk()?.pid).toBe(h.pid)
  })

  it("counts a live process whose start cannot be read as still holding, never as gone", () => {
    expect(
      isSameProcess(process.pid, "Sun Nov 15 08:09:46 2026", () => ""),
    ).toBe(true)
    expect(
      isSameProcess(process.pid, "", () => "Sun Nov 15 08:09:46 2026"),
    ).toBe(true)
    expect(
      isSameProcess(process.pid, "Sun Nov 15 08:09:46 2026", () => null),
    ).toBe(false)
  })

  it("is taken over from a holder that died or whose pid was reused, or a record that names no process", async () => {
    const reused = await hold("unrelated")
    put(reused.pid, { pidStart: "Thu Jan  1 00:00:00 1970" })
    expect(await withOperation(NAME, "pause", () => onDisk()?.pid)).toBe(
      process.pid,
    )

    writeFileSync(leaseFile(), "not json")
    expect(await withOperation(NAME, "pause", () => onDisk()?.pid)).toBe(
      process.pid,
    )

    const gone = Bun.spawn(["true"])
    await gone.exited
    put(gone.pid)
    expect(await withOperation(NAME, "pause", () => onDisk()?.pid)).toBe(
      process.pid,
    )
    expect(onDisk()).toBeNull()
  })

  it("shows an internal operation to no one: status reports operations the app knows", async () => {
    await withOperation(NAME, "reconcile", () => {
      expect(readOperation(NAME)).toBeNull()
      expect(onDisk()?.operation).toBe("reconcile")
    })
  })

  it("carries a save's stop of a running guest, and only for the holder that marked it", async () => {
    expect(savingRunning(NAME)).toBe(false)
    await withOperation(NAME, "save", () => {
      markSavingRunning(NAME)
      expect(savingRunning(NAME)).toBe(true)
      expect(readOperation(NAME)?.operation).toBe("save")
      clearSavingRunning(NAME)
      expect(savingRunning(NAME)).toBe(false)
      markSavingRunning(NAME)
    })
    expect(savingRunning(NAME)).toBe(false)
    markSavingRunning(NAME)
    expect(onDisk()).toBeNull()
  })
})

describe("exclusion", () => {
  it("refuses a second command while the first holds the instance, naming what holds it", async () => {
    const g = gate()
    const first = withOperation(NAME, "start", async () => {
      await g.opened
    })
    await Bun.sleep(20)
    const second = withOperation(NAME, "start", () => "ran")
    await expect(second).rejects.toBeInstanceOf(InstanceBusy)
    await expect(second).rejects.toThrow(
      new RegExp(
        `"${NAME}" is busy: start \\(pid ${String(process.pid)}\\) since `,
      ),
    )
    g.open()
    await first
    expect(await withOperation(NAME, "start", () => "ran")).toBe("ran")
  })

  it("refuses a command while another process holds the lease", async () => {
    const h = await hold("winvm", "stop", "-i", NAME)
    put(h.pid, { operation: "stop" })
    await expect(withOperation(NAME, "save", () => "ran")).rejects.toThrow(
      `is busy: stop (pid ${String(h.pid)})`,
    )
    expect(onDisk()?.pid).toBe(h.pid)
  })

  it("excludes across processes: a child's command is refused while this one holds it, and runs once it lets go", async () => {
    const script = resolve(home, "child.ts")
    writeFileSync(
      script,
      [
        `import { withOperation } from ${JSON.stringify(resolve(import.meta.dir, "../src/operation.ts"))}`,
        `try { console.log(await withOperation(${JSON.stringify(NAME)}, "stop", () => "ran")) } catch (e) { console.log(String(e)) }`,
      ].join("\n"),
    )
    const run = (): string =>
      Bun.spawnSync([process.execPath, script], {
        env: { ...process.env, WINVM_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      })
        .stdout.toString()
        .trim()
    const refused = await withOperation(NAME, "save", () => run())
    expect(refused).toContain(`is busy: save (pid ${String(process.pid)})`)
    expect(run()).toBe("ran")
    rmSync(script, { force: true })
  })

  it("lets a command call its own nested steps without refusing itself", async () => {
    const seen = await withOperation(
      NAME,
      "stow",
      async () =>
        await withOperation(
          NAME,
          "save",
          async () => await withOperation(NAME, "stop", () => onDisk()),
        ),
    )
    expect(seen?.operation).toBe("stow")
    expect(onDisk()).toBeNull()
  })

  it("keeps two flows of one process apart: only the one that took it nests", async () => {
    const g = gate()
    const inner: string[] = []
    const first = withOperation(NAME, "load", async () => {
      await g.opened
      inner.push(await withOperation(NAME, "save", () => "nested"))
    })
    await Bun.sleep(20)
    await expect(
      withOperation(NAME, "save", () => "ran"),
    ).rejects.toBeInstanceOf(InstanceBusy)
    g.open()
    await first
    expect(inner).toEqual(["nested"])
  })
})

describe("waiting", () => {
  it("waits out winvm's own work for a person's command, and refuses another person's at once", async () => {
    const g = gate()
    const waited: number[] = []
    const auto = withOperation(
      NAME,
      "save",
      async () => {
        await g.opened
      },
      { automatic: true },
    )
    await Bun.sleep(20)
    expect(leaseHolder(NAME)).toEqual({
      operation: "save",
      pid: process.pid,
      startedAt: expect.any(String) as string,
      automatic: true,
    })
    expect(readOperation(NAME)?.operation).toBe("save")
    const stop = withOperation(NAME, "stop", () => onDisk()?.operation, {
      pollMs: 10,
      onWait: (h) => waited.push(h.pid),
    })
    await Bun.sleep(100)
    g.open()
    await auto
    expect(await stop).toBe("stop")
    expect(waited).toEqual([process.pid])

    const user = gate()
    const held = withOperation(NAME, "pause", async () => {
      await user.opened
    })
    await Bun.sleep(20)
    const t0 = Date.now()
    await expect(
      withOperation(NAME, "stop", () => "ran", { pollMs: 10, ...quietly }),
    ).rejects.toBeInstanceOf(InstanceBusy)
    expect(Date.now() - t0).toBeLessThan(500)
    user.open()
    await held
  })

  it("gives up after its bound, naming the automatic holder", async () => {
    const g = gate()
    const auto = withOperation(
      NAME,
      "save",
      async () => {
        await g.opened
      },
      { automatic: true },
    )
    await Bun.sleep(20)
    await expect(
      withOperation(NAME, "pause", () => "ran", {
        waitMs: 100,
        pollMs: 10,
        ...quietly,
      }),
    ).rejects.toThrow(/busy: save \(pid \d+, started by winvm itself\)/)
    g.open()
    await auto
  })

  it("never waits when winvm's own work finds the instance busy: it skips instead", async () => {
    const g = gate()
    const auto = withOperation(
      NAME,
      "reconcile",
      async () => {
        await g.opened
      },
      { automatic: true },
    )
    await Bun.sleep(20)
    await expect(
      withOperation(NAME, "save", () => "ran", {
        automatic: true,
        pollMs: 10,
        ...quietly,
      }),
    ).rejects.toBeInstanceOf(InstanceBusy)
    g.open()
    await auto
  })

  it("marks every lease taken by a command winvm ran on its own", async () => {
    const before = process.env.WINVM_AUTOMATIC
    process.env.WINVM_AUTOMATIC = "1"
    try {
      expect(await withOperation(NAME, "stow", () => onDisk()?.automatic)).toBe(
        true,
      )
    } finally {
      if (before === undefined) delete process.env.WINVM_AUTOMATIC
      else process.env.WINVM_AUTOMATIC = before
    }
  })
})

describe("kill", () => {
  it("never waits on a lease: it runs beside a wedged holder, and holds the lease itself when it is free", async () => {
    const g = gate()
    const wedged = withOperation(NAME, "stop", async () => {
      await g.opened
    })
    await Bun.sleep(20)
    const t0 = Date.now()
    expect(await withOperation(NAME, "kill", () => onDisk()?.operation)).toBe(
      "stop",
    )
    expect(Date.now() - t0).toBeLessThan(500)
    g.open()
    await wedged
    expect(await withOperation(NAME, "kill", () => onDisk()?.operation)).toBe(
      "kill",
    )
  })
})

describe("the event record of operations", () => {
  const ops = (): readonly Entry[] =>
    readSince(NAME, START).entries.filter((e) => e.kind === "op")

  it("records when the lease is taken and when it is let go, with the command's exit code", async () => {
    const code = await withOperation(NAME, "stop", () => {
      expect(ops()).toEqual([
        {
          t: expect.any(String) as string,
          instance: NAME,
          kind: "op",
          phase: "begin",
          id: onDisk()?.id as string,
          operation: "stop",
          pid: process.pid,
          startedAt: onDisk()?.startedAt as string,
          automatic: false,
          leased: true,
        },
      ])
      return 3
    })
    expect(code).toBe(3)
    const [begin, end] = ops()
    expect(end).toEqual({
      t: expect.any(String) as string,
      instance: NAME,
      kind: "op",
      phase: "end",
      id: begin?.kind === "op" ? begin.id : "",
      operation: "stop",
      pid: process.pid,
      startedAt: begin?.kind === "op" ? begin.startedAt : "",
      endedAt: expect.any(String) as string,
      automatic: false,
      leased: true,
      ok: false,
      exitCode: 3,
    })
    await withOperation(NAME, "pause", () => 0)
    await withOperation(NAME, "pause", () => "done")
    expect(
      ops()
        .filter((e) => e.kind === "op" && e.phase === "end")
        .map((e) => [e.ok, e.exitCode]),
    ).toEqual([
      [false, 3],
      [true, 0],
      [true, undefined],
    ])
  })

  it("records the error a command failed with", async () => {
    await expect(
      withOperation(NAME, "start", () => {
        throw new Error("no firmware")
      }),
    ).rejects.toThrow("no firmware")
    expect(ops().at(-1)).toMatchObject({
      phase: "end",
      operation: "start",
      ok: false,
      error: "no firmware",
    })
  })

  it("records nested steps once, as the operation that took the lease", async () => {
    await withOperation(NAME, "stow", async () => {
      await withOperation(NAME, "save", () => 0)
      await withOperation(NAME, "stop", () => 0)
      return 0
    })
    expect(
      ops().map((e) => (e.kind === "op" ? `${e.phase}:${e.operation}` : "")),
    ).toEqual(["begin:stow", "end:stow"])
  })

  it("records a kill that ran beside a wedged holder, without the lease", async () => {
    const g = gate()
    const wedged = withOperation(NAME, "stop", async () => {
      await g.opened
    })
    await Bun.sleep(20)
    await withOperation(NAME, "kill", () => 0)
    g.open()
    await wedged
    expect(
      ops().map((e) =>
        e.kind === "op" ? `${e.phase}:${e.operation}:${String(e.leased)}` : "",
      ),
    ).toEqual([
      "begin:stop:true",
      "begin:kill:false",
      "end:kill:false",
      "end:stop:true",
    ])
  })

  it("records a lease whose holder went away as abandoned, when the next operation takes it over", async () => {
    const gone = Bun.spawn(["true"])
    await gone.exited
    put(gone.pid, { operation: "save", id: "dead-save" })
    await withOperation(NAME, "pause", () => 0)
    expect(ops()[0]).toMatchObject({
      phase: "end",
      id: "dead-save",
      operation: "save",
      pid: gone.pid,
      ok: false,
      abandoned: true,
    })
    expect(
      ops()
        .slice(1)
        .map((e) => (e.kind === "op" ? e.phase : "")),
    ).toEqual(["begin", "end"])
  })

  it("records nothing for a name that is not an instance", async () => {
    expect(await withOperation("op-nothing", "stop", () => "ran")).toBe("ran")
    expect(existsSync(pathsFor("op-nothing").dir)).toBe(false)
  })
})

describe("which instances get a lease", () => {
  const instance = (name: string): void => {
    mkdirSync(pathsFor(name).dir, { recursive: true })
    writeFileSync(
      pathsFor(name).meta,
      JSON.stringify({
        image: "win11-arm64",
        vnc: 1,
        created: "2026-01-01T00:00:00.000Z",
      }),
    )
  }
  const leased = async (
    name: string,
    operation: LeaseOperation,
  ): Promise<boolean> =>
    await withOperation(name, operation, () => existsSync(pathsFor(name).lease))

  it("creates no path for a name that could leave the instances directory, and still runs the command", async () => {
    mkdirSync(resolve(home, "instances"), { recursive: true })
    for (const name of [
      "../escape",
      "../../wvop-escape",
      "a/b",
      "..",
      ".",
      "",
    ]) {
      expect(await withOperation(name, "stop", () => "ran")).toBe("ran")
      expect(readOperation(name)).toBeNull()
    }
    expect(existsSync(resolve(home, "escape"))).toBe(false)
    expect(existsSync(resolve(home, "..", "wvop-escape"))).toBe(false)
    expect(readdirSync(resolve(home, "instances"))).toEqual([NAME])
    expect(readdirSync(home).sort()).toEqual(["instances"])
  })

  it("leases an existing instance, and a valid new name only for the commands that create one", async () => {
    instance("op-existing")
    expect(await leased("op-existing", "stop")).toBe(true)
    instance("My VM")
    expect(await leased("My VM", "stop")).toBe(true)
    for (const operation of ["start", "load", "golden-create"] as const)
      expect(await leased(`op-new-${operation}`, operation)).toBe(true)
    expect(await leased("op-typo", "stop")).toBe(false)
    expect(existsSync(pathsFor("op-typo").dir)).toBe(false)
    expect(await leased("-bad name", "start")).toBe(false)
    expect(existsSync(pathsFor("-bad name").dir)).toBe(false)
    for (const n of [
      "op-existing",
      "My VM",
      "op-new-start",
      "op-new-load",
      "op-new-golden-create",
    ])
      rmSync(pathsFor(n).dir, { recursive: true, force: true })
  })
})

describe("a command that exits inside its lease", () => {
  const SRC = resolve(import.meta.dir, "../src/operation.ts")
  const child = (body: string): { code: number; out: string } => {
    const script = resolve(home, `child-${String(Math.random()).slice(2)}.ts`)
    writeFileSync(
      script,
      [
        `import { withOperation } from ${JSON.stringify(SRC)}`,
        `import { writeFileSync } from "node:fs"`,
        `const leaseFile = ${JSON.stringify(leaseFile())}`,
        body,
      ].join("\n"),
    )
    const r = Bun.spawnSync(["bun", script], {
      env: { ...process.env, WINVM_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    rmSync(script, { force: true })
    return { code: r.exitCode, out: r.stdout.toString().trim() }
  }

  it("clears its record when the command calls process.exit", () => {
    const r = child(
      `await withOperation(${JSON.stringify(NAME)}, "stop", () => { console.log(leaseFile); process.exit(3) })`,
    )
    expect(r.code).toBe(3)
    expect(r.out).toBe(leaseFile())
    expect(onDisk()).toBeNull()
    expect(
      readSince(NAME, START)
        .entries.filter((e) => e.kind === "op")
        .at(-1),
    ).toMatchObject({ phase: "end", operation: "stop", ok: false, exitCode: 3 })
  })

  it("clears the record when exit comes from a step nested inside the command", () => {
    const r = child(
      `await withOperation(${JSON.stringify(NAME)}, "start", async () => {
         await withOperation(${JSON.stringify(NAME)}, "load", () => { process.exit(4) })
       })`,
    )
    expect(r.code).toBe(4)
    expect(onDisk()).toBeNull()
  })

  it("leaves a record that carries someone else's lease", () => {
    const foreign = JSON.stringify({
      operation: "save",
      id: "newer-owner",
      pid: 1,
      pidStart: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      instance: NAME,
      automatic: false,
    })
    const r = child(
      `await withOperation(${JSON.stringify(NAME)}, "start", () => { writeFileSync(leaseFile, ${JSON.stringify(foreign)}); process.exit(5) })`,
    )
    expect(r.code).toBe(5)
    expect(onDisk()?.id).toBe("newer-owner")
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
