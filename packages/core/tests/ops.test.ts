import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import type { Args } from "../src/args"
import { parseArgs } from "../src/args"
import { type Entry, readSince, START } from "../src/eventlog"
import { type HostEndOutcome, runHostEnd } from "../src/hostend"
import { remountCmd, remountHeld, runOp } from "../src/opclient"
import { currentOp, OpCancelled, pointOfNoReturn } from "../src/opcontext"
import { InstanceBusy, leaseHolder, withOperation } from "../src/operation"
import { OPS_PROTOCOL, type OpHandlers, OpQueue } from "../src/ops"
import { SERVICE_HANDLERS } from "../src/opverbs"
import { type Paths, pathsFor } from "../src/paths"
import * as qmp from "../src/qmp"
import { runService, type ServiceHandle } from "../src/service"
import { FakeAgent } from "./fakes/agent"
import { FakeGuest } from "./fakes/guest"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"
import { FakeQmp } from "./fakes/qmp"

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

let home = ""
let savedHome: string | undefined
let p: Paths
let fake: FakeQmp
let agent: FakeAgent
let svc: ServiceHandle | null = null
let gates: Record<string, ReturnType<typeof gate>> = {}
let running = 0
let most = 0
let seen: Args[] = []
let late: unknown = null

const held = async (key: string): Promise<void> => {
  running += 1
  most = Math.max(most, running)
  try {
    await gates[key]?.opened
  } finally {
    running -= 1
  }
}

const handlers: OpHandlers = {
  pause: {
    cancel: "never",
    run: async (args) => {
      seen.push(args)
      console.log("first line")
      console.warn("a warning between")
      process.stdout.write("partial")
      process.stdout.write(" and the rest\n")
      console.error(`::error::${"x".repeat(3000)}`)
      return await Promise.resolve(0)
    },
  },
  resume: {
    cancel: "never",
    run: async () => {
      await held("resume")
      console.log("resumed")
      return 0
    },
  },
  lock: {
    cancel: "never",
    run: async () => {
      await held("lock")
      return 2
    },
  },
  sleep: {
    cancel: "never",
    run: async () => {
      await held("sleep")
      try {
        await qmp.execute(p.qmp, "stop")
      } catch (error) {
        late = error
      }
      return 0
    },
  },
  reboot: {
    cancel: "before-request",
    run: async () => {
      await held("reboot")
      pointOfNoReturn()
      console.log("asked")
      await held("rebooted")
      return 0
    },
  },
  wake: {
    cancel: "never",
    run: async () => {
      process.stdout.write(`${"x".repeat(1023)}😀\n`)
      const e = Buffer.from("é\n")
      process.stdout.write(e.subarray(0, 1))
      process.stdout.write(e.subarray(1))
      setTimeout(() => {
        console.log("after the end")
      }, 50)
      return await Promise.resolve(0)
    },
  },
  kill: {
    cancel: "never",
    run: async () => {
      console.log("killed it")
      return await Promise.resolve(0)
    },
  },
}

interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function post(path: string, body: unknown): Promise<Answer> {
  const res = await fetch(`http://localhost${path}`, {
    unix: p.control,
    method: "POST",
    body: JSON.stringify(body),
  })
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  }
}

const submit = async (
  op: string,
  extra: Record<string, unknown> = {},
): Promise<Answer> =>
  await post("/ops", { protocol: OPS_PROTOCOL, op, args: [], ...extra })

const opsOf = (id: unknown): readonly Entry[] =>
  readSince("t", START).entries.filter((e) => e.kind === "op" && e.id === id)

const endOf = (id: unknown): Entry | undefined =>
  opsOf(id).find((e) => e.kind === "op" && e.phase === "end")

const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(10)
  }
}

const ended = async (id: unknown): Promise<Entry> => {
  await until(() => endOf(id) !== undefined)
  return endOf(id) as Entry
}

beforeEach(async () => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync(resolve(tmpdir(), "winvm-ops-"))
  process.env.WINVM_HOME = home
  p = pathsFor("t")
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify({ image: "x", vnc: 9, created: "" }))
  await lockPidfile(p.pid, "qemu-system-aarch64", "-pidfile", p.pid)
  fake = new FakeQmp(p.qmpQemu)
  await fake.listen()
  agent = new FakeAgent(p.qgaQemu)
  await agent.listen()
  gates = Object.fromEntries(
    ["resume", "lock", "sleep", "reboot", "rebooted"].map((k) => [k, gate()]),
  )
  running = 0
  most = 0
  seen = []
  late = null
  svc = await runService("t", { exitAfterMs: 60_000, checkMs: 50, handlers })
})

afterEach(async () => {
  for (const g of Object.values(gates)) g.open()
  await svc?.stop()
  svc = null
  await releasePidfiles()
  await fake.close().catch(() => undefined)
  await agent.close().catch(() => undefined)
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe("an op the service runs", () => {
  it("is accepted with its id and a cursor, runs in the service under the lease, and ends with its exit code", async () => {
    const a = await submit("pause", { args: ["--force"] })
    const id = a.body.id
    expect(a.status).toBe(202)
    expect(a.body).toMatchObject({
      protocol: OPS_PROTOCOL,
      id: expect.any(String) as string,
      pid: process.pid,
      queued: null,
    })
    const end = await ended(id)
    expect(end).toMatchObject({
      kind: "op",
      phase: "end",
      operation: "pause",
      pid: process.pid,
      leased: true,
      ok: true,
      exitCode: 0,
    })
    expect(opsOf(id)[0]).toMatchObject({ phase: "begin", leased: true })
    expect(seen[0]?.flags.get("instance")).toBe("t")
    expect(seen[0]?.flags.has("force")).toBe(true)
  })

  it("records what it printed, in order, on its own stream, in lines the record can hold", async () => {
    const a = await submit("pause")
    await ended(a.body.id)
    const said = opsOf(a.body.id).flatMap((e) =>
      e.kind === "op" && e.phase === "output" ? [e] : [],
    )
    expect(said.map((e) => e.stream)).toEqual([
      "out",
      "err",
      "out",
      "out",
      "err",
      "err",
      "err",
    ])
    expect(
      said
        .filter((e) => e.stream === "out")
        .map((e) => e.text)
        .join(""),
    ).toBe("first line\npartial and the rest\n")
    expect(
      said
        .filter((e) => e.stream === "err")
        .map((e) => e.text)
        .join(""),
    ).toBe(`a warning between\n::error::${"x".repeat(3000)}\n`)
    expect(Math.max(...said.map((e) => e.text.length))).toBeLessThanOrEqual(
      1024,
    )
  })

  it("cuts what an op prints only between characters, and joins a character written in two pieces", async () => {
    const a = await submit("wake")
    await ended(a.body.id)
    const said = opsOf(a.body.id).flatMap((e) =>
      e.kind === "op" && e.phase === "output" ? [e.text] : [],
    )
    expect(said.join("")).toBe(`${"x".repeat(1023)}😀\né\n`)
    for (const piece of said) {
      expect(piece).not.toContain("\uFFFD")
      expect(/[\uD800-\uDBFF]$/.test(piece)).toBe(false)
    }
  })

  it("records nothing under an op's id once it has ended", async () => {
    const a = await submit("wake")
    await ended(a.body.id)
    await Bun.sleep(200)
    expect(
      opsOf(a.body.id).filter(
        (e) =>
          e.kind === "op" &&
          e.phase === "output" &&
          e.text.includes("after the end"),
      ),
    ).toEqual([])
  })

  it("keeps the service alive while it runs, though QEMU has gone", async () => {
    await svc?.stop()
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50, handlers })
    const a = await submit("resume")
    await releasePidfiles()
    await Bun.sleep(600)
    const res = await fetch("http://localhost/status", { unix: p.control })
    expect(res.ok).toBe(true)
    gates.resume?.open()
    await ended(a.body.id)
  })

  it("says at once that it could not take the lease, without running the op, when taking it fails", async () => {
    writeFileSync(p.events, "")
    chmodSync(p.dir, 0o500)
    try {
      const t0 = Date.now()
      const r = await submit("pause")
      expect(Date.now() - t0).toBeLessThan(2000)
      expect(r.status).toBe(503)
      expect(r.body).toMatchObject({ protocol: OPS_PROTOCOL })
      expect(String(r.body.error)).toContain("EACCES")
    } finally {
      chmodSync(p.dir, 0o700)
    }
    expect(seen).toEqual([])
  })

  it("refuses an op it could not record, for an instance with no metadata", async () => {
    rmSync(p.meta)
    const r = await submit("pause")
    expect(r.status).toBe(503)
    expect(seen).toEqual([])
  })

  it("refuses a protocol it does not speak, and an op it does not run, so the client can run it itself", async () => {
    const wrong = await post("/ops", { protocol: 99, op: "pause", args: [] })
    expect(wrong.status).toBe(400)
    expect(wrong.body).toMatchObject({ protocol: OPS_PROTOCOL })
    const unknown = await submit("stow")
    expect(unknown.status).toBe(501)
    expect(unknown.body).toMatchObject({ protocol: OPS_PROTOCOL })
    expect(
      readSince("t", START).entries.filter((e) => e.kind === "op"),
    ).toEqual([])
  })
})

describe("two ops on one VM", () => {
  it("never run at once: the second is refused as busy, naming the first", async () => {
    const first = await submit("resume")
    await until(() => running === 1)
    const second = await submit("lock")
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({
      protocol: OPS_PROTOCOL,
      busy: { operation: "resume", pid: process.pid, automatic: false },
    })
    gates.resume?.open()
    await ended(first.body.id)
    expect(most).toBe(1)
  })

  it("run one after the other when the second asks to wait, and it says what it waits for", async () => {
    const first = await submit("resume")
    await until(() => running === 1)
    const second = await submit("lock", { wait: true })
    expect(second.status).toBe(202)
    expect(second.body).toMatchObject({
      queued: { operation: "resume", pid: process.pid },
    })
    await Bun.sleep(150)
    expect(running).toBe(1)
    gates.resume?.open()
    gates.lock?.open()
    expect(await ended(first.body.id)).toMatchObject({ ok: true })
    expect(await ended(second.body.id)).toMatchObject({
      ok: false,
      exitCode: 2,
    })
    expect(most).toBe(1)
    const waited = opsOf(second.body.id).find(
      (e) => e.kind === "op" && e.phase === "output",
    )
    expect(waited).toMatchObject({
      stream: "err",
      text: `instance "t": waiting for the resume (pid ${String(process.pid)}) to finish\n`,
    })
  })

  it("is refused while another process holds the lease, as an older winvm would", async () => {
    const outside = gate()
    const other = withOperation("t", "stop", async () => {
      await outside.opened
    })
    await Bun.sleep(20)
    const r = await submit("pause")
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ busy: { operation: "stop" } })
    outside.open()
    await other
  })

  it("holds the lease against another process, which is refused naming the service", async () => {
    const a = await submit("resume")
    await until(() => running === 1)
    expect(leaseHolder("t")).toMatchObject({
      operation: "resume",
      pid: process.pid,
    })
    await expect(
      withOperation("t", "stop", () => "ran", { onWait: () => undefined }),
    ).rejects.toBeInstanceOf(InstanceBusy)
    gates.resume?.open()
    await ended(a.body.id)
  })
})

describe("kill", () => {
  it("runs beside the op in flight and ends it as killed; the killed op can't reach QEMU afterwards", async () => {
    const first = await submit("sleep")
    await until(() => running === 1)
    const k = await submit("kill")
    expect(k.status).toBe(202)
    expect(await ended(k.body.id)).toMatchObject({ ok: true, exitCode: 0 })
    expect(await ended(first.body.id)).toMatchObject({
      ok: false,
      error: "killed",
    })
    gates.sleep?.open()
    await until(() => late !== null)
    expect(String(late)).toContain("ended by winvm kill")
    expect(fake.commands).not.toContain("stop")
    expect(leaseHolder("t")).toBeNull()
  })

  it("ends an op still waiting for the lease as killed too", async () => {
    const first = await submit("resume")
    await until(() => running === 1)
    const queued = await submit("lock", { wait: true })
    await submit("kill")
    expect(await ended(queued.body.id)).toMatchObject({
      ok: false,
      error: "killed",
      leased: false,
    })
    expect(await ended(first.body.id)).toMatchObject({ error: "killed" })
    expect(running).toBe(1)
  })
})

describe("cancel", () => {
  const cancel = async (id?: unknown): Promise<Answer> =>
    await post("/ops/cancel", {
      protocol: OPS_PROTOCOL,
      ...(id === undefined ? {} : { id }),
    })

  it("ends an op before its point of no return, and nothing after it runs", async () => {
    const a = await submit("reboot")
    await until(() => running === 1)
    const c = await cancel()
    expect(c.status).toBe(200)
    expect(c.body).toMatchObject({
      cancelled: { id: a.body.id, operation: "reboot" },
    })
    expect(await ended(a.body.id)).toMatchObject({ ok: false, exitCode: 130 })
    gates.reboot?.open()
    await Bun.sleep(50)
    const out = opsOf(a.body.id).flatMap((e) =>
      e.kind === "op" && e.phase === "output" ? [e.text] : [],
    )
    expect(out.join("")).not.toContain("asked")
    expect(out.join("")).toContain("reboot was cancelled")
  })

  it("is refused past the point of no return, with when it was passed", async () => {
    const a = await submit("reboot")
    gates.reboot?.open()
    await until(() =>
      opsOf(a.body.id).some((e) => e.kind === "op" && e.phase === "output"),
    )
    const c = await cancel(a.body.id)
    expect(c.status).toBe(409)
    expect((c.body.refused as { reason: string }).reason).toContain(
      "point of no return",
    )
    gates.rebooted?.open()
    expect(await ended(a.body.id)).toMatchObject({ ok: true, exitCode: 0 })
  })

  it("is refused for an op that can't be cancelled once begun, and takes a queued one off the queue", async () => {
    const first = await submit("resume")
    await until(() => running === 1)
    const queued = await submit("lock", { wait: true })
    const refused = await cancel(first.body.id)
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({
      refused: { id: first.body.id, operation: "resume" },
    })
    const off = await cancel(queued.body.id)
    expect(off.status).toBe(200)
    expect(await ended(queued.body.id)).toMatchObject({
      ok: false,
      exitCode: 130,
      leased: false,
    })
    gates.resume?.open()
    expect(await ended(first.body.id)).toMatchObject({ ok: true })
  })

  it("says so when the id names no op, rather than that nothing runs", async () => {
    const a = await submit("resume")
    await until(() => running === 1)
    const c = await cancel("no-such-op")
    expect(c.status).toBe(404)
    expect(c.body).toMatchObject({ unknown: "no-such-op" })
    gates.resume?.open()
    await ended(a.body.id)
  })

  it("cancels no queued op of its own choosing while another process holds the lease", async () => {
    const outside = gate()
    const other = withOperation("t", "stop", async () => {
      await outside.opened
    })
    await Bun.sleep(20)
    const queued = await submit("pause", { wait: true })
    expect(queued.status).toBe(202)
    const c = await cancel()
    expect(c.status).toBe(409)
    expect((c.body.refused as { reason: string }).reason).toContain("--id")
    expect(endOf(queued.body.id)).toBeUndefined()
    const off = await cancel(queued.body.id)
    expect(off.status).toBe(200)
    expect(await ended(queued.body.id)).toMatchObject({
      queued: true,
      exitCode: 130,
    })
    outside.open()
    await other
  })

  it("says when there is nothing to cancel", async () => {
    const none = await cancel()
    expect(none.status).toBe(404)
    expect(none.body).toMatchObject({ protocol: OPS_PROTOCOL, none: true })
  })
})

describe("an op waiting for the lease when QEMU goes", () => {
  it("ends, saying QEMU is not running, once QEMU has been gone as long as the service waits before it exits", async () => {
    await svc?.stop()
    svc = await runService("t", { exitAfterMs: 300, checkMs: 50, handlers })
    const outside = gate()
    const other = withOperation("t", "stop", async () => {
      await outside.opened
    })
    await Bun.sleep(20)
    const queued = await submit("pause", { wait: true })
    expect(queued.status).toBe(202)
    await releasePidfiles()
    expect(await ended(queued.body.id)).toMatchObject({
      queued: true,
      exitCode: 1,
      error: "QEMU is not running",
    })
    expect(seen).toEqual([])
    outside.open()
    await other
  })

  it("still runs once another command's load has started QEMU again", async () => {
    const outside = gate()
    const other = withOperation("t", "load", async () => {
      await outside.opened
    })
    await Bun.sleep(20)
    const queued = await submit("pause", { wait: true })
    expect(queued.status).toBe(202)
    await releasePidfiles()
    await Bun.sleep(400)
    await lockPidfile(p.pid, "qemu-system-aarch64", "-pidfile", p.pid)
    outside.open()
    await other
    expect(await ended(queued.body.id)).toMatchObject({ ok: true, exitCode: 0 })
    expect(seen).toHaveLength(1)
  })
})

describe("a client's remount", () => {
  const mounts = (): {
    count: number
    mount: () => Promise<"mounted">
  } => {
    const m = {
      count: 0,
      mount: async (): Promise<"mounted"> => {
        m.count += 1
        return await Promise.resolve("mounted")
      },
    }
    return m
  }

  it("waits for the op that holds the instance, then mounts under the lease", async () => {
    const outside = gate()
    let holding = true
    const other = withOperation("t", "resume", async () => {
      await outside.opened
      holding = false
    })
    await Bun.sleep(20)
    let leasedWhileMounting: unknown = null
    const m = mounts()
    const done = remountHeld("t", async () => {
      leasedWhileMounting = leaseHolder("t")
      return await m.mount()
    })
    await Bun.sleep(100)
    expect(m.count).toBe(0)
    outside.open()
    await done
    await other
    expect(holding).toBe(false)
    expect(m.count).toBe(1)
    expect(leasedWhileMounting).toBeNull()
    expect(
      readSince("t", START).entries.some(
        (e) =>
          e.kind === "op" && e.phase === "begin" && e.operation === "remount",
      ),
    ).toBe(true)
  })

  it("mounts nothing on a guest that was paused meanwhile, and says to resume it", async () => {
    fake.handler = (cmd) =>
      cmd.execute === "query-status"
        ? { return: { status: "paused", running: false } }
        : { return: {} }
    const m = mounts()
    const r = await remountHeld("t", m.mount)
    expect(m.count).toBe(0)
    expect(r).toEqual({
      kind: "refused",
      why: 'instance "t" is paused — resume it first (`winvm resume -i t`)',
    })
  })

  it("says what the mount did: mounted, nothing pending, or failed", async () => {
    expect(
      await remountHeld("t", async () => await Promise.resolve("mounted")),
    ).toEqual({ kind: "mounted" })
    expect(
      await remountHeld(
        "t",
        async () => await Promise.resolve("nothing pending"),
      ),
    ).toEqual({ kind: "nothing pending" })
    expect(
      await remountHeld("t", async () => await Promise.resolve("failed")),
    ).toEqual({ kind: "failed" })
  })

  it("is refused, naming the holder, when the instance stays busy for the whole wait", async () => {
    const outside = gate()
    const other = withOperation("t", "resume", async () => {
      await outside.opened
    })
    await Bun.sleep(20)
    const m = mounts()
    const r = await remountHeld("t", m.mount, new AbortController().signal, {
      waitMs: 200,
    })
    expect(m.count).toBe(0)
    expect(r).toMatchObject({ kind: "refused" })
    expect(r.kind === "refused" ? r.why : "").toContain(
      'instance "t" is busy: resume',
    )
    outside.open()
    await other
  })

  it("stops waiting for the instance at once when the client is interrupted, and mounts nothing", async () => {
    const outside = gate()
    const other = withOperation("t", "resume", async () => {
      await outside.opened
    })
    await Bun.sleep(20)
    const m = mounts()
    const interrupted = new AbortController()
    const t0 = Date.now()
    const done = remountHeld("t", m.mount, interrupted.signal)
    setTimeout(() => {
      interrupted.abort("SIGINT")
    }, 100)
    await expect(done).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(m.count).toBe(0)
    outside.open()
    await other
  })

  it("stops waiting for a slow mount at once when the client is interrupted", async () => {
    const interrupted = new AbortController()
    const t0 = Date.now()
    const done = remountHeld(
      "t",
      async () => {
        await Bun.sleep(5000)
        return "mounted"
      },
      interrupted.signal,
    )
    setTimeout(() => {
      interrupted.abort("SIGINT")
    }, 100)
    await expect(done).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(leaseHolder("t")).toBeNull()
  })

  it("lets a client interrupted during its remount detach at once, saying so", async () => {
    await svc?.stop()
    svc = await runService("t", {
      exitAfterMs: 60_000,
      checkMs: 50,
      handlers: {
        resume: {
          cancel: "never",
          run: async () => {
            currentOp()?.remount()
            return await Promise.resolve(0)
          },
        },
      },
    })
    const said: string[] = []
    let remounting = false
    const io = {
      out: (text: string): void => {
        said.push(text)
      },
      err: (text: string): void => {
        said.push(text)
      },
      remount: async (_name: string, signal?: AbortSignal): Promise<void> => {
        remounting = true
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("interrupted"))
          })
        })
      },
    }
    const ran = runOp(
      { op: "resume", args: parseArgs(["-i", "t"]), argv: ["-i", "t"] },
      { up: () => Promise.resolve() },
      io,
    )
    await until(() => remounting)
    process.emit("SIGINT")
    expect(await ran).toBe(130)
    expect(said.join("")).toContain("resume continues in winvm's service")
  })
})

describe("a command when no service takes its op", () => {
  const call = (op: "pause" | "kill") => ({
    op,
    args: parseArgs(["-i", "t"]),
    argv: ["-i", "t"],
  })
  const heard = (): { said: string[]; io: Parameters<typeof runOp>[2] } => {
    const said: string[] = []
    return {
      said,
      io: {
        out: (text) => {
          said.push(text)
        },
        err: (text) => {
          said.push(text)
        },
        remount: () => Promise.resolve(),
      },
    }
  }

  it("brings a service up and runs the op in it when none answers", async () => {
    await svc?.stop()
    svc = null
    const asked: string[] = []
    const { said, io } = heard()
    const code = await runOp(
      call("pause"),
      {
        up: async (name, wait) => {
          asked.push(`${name} ${String(wait)}`)
          svc = await runService("t", {
            exitAfterMs: 60_000,
            checkMs: 50,
            handlers: {
              pause: {
                cancel: "never",
                run: async () => {
                  console.log("paused in the service")
                  return await Promise.resolve(0)
                },
              },
            },
          })
        },
      },
      io,
    )
    expect(code).toBe(0)
    expect(asked).toEqual(["t false"])
    expect(said).toEqual(["paused in the service\n"])
  })

  it("runs nothing, and says why, when the service still does not run the op", async () => {
    await svc?.stop()
    svc = null
    const stub = Bun.serve({
      unix: p.control,
      fetch: () =>
        Response.json(
          { protocol: OPS_PROTOCOL, error: "this service does not run pause" },
          { status: 501 },
        ),
    })
    try {
      let ups = 0
      const { said, io } = heard()
      const code = await runOp(
        call("pause"),
        {
          up: async () => {
            ups += 1
            await Promise.resolve()
          },
        },
        io,
      )
      expect(code).toBe(1)
      expect(ups).toBe(1)
      expect(said).toEqual([
        '::error::winvm\'s service for "t" does not run pause (this service does not run pause), so it was not run\n',
      ])
    } finally {
      await stub.stop(true)
    }
  })

  it("says why a service could not be brought up, and that the op was not run", async () => {
    await svc?.stop()
    svc = null
    const { said, io } = heard()
    const code = await runOp(
      call("pause"),
      {
        up: () =>
          Promise.reject(new Error("no winvm-keeper was found, so nothing")),
      },
      io,
    )
    expect(code).toBe(1)
    expect(said).toEqual([
      "::error::pause was not run: no winvm-keeper was found, so nothing\n",
    ])
  })

  it("says the instance is busy when another command holds it while the service is brought up", async () => {
    await svc?.stop()
    svc = null
    const holder = {
      operation: "snapshot",
      pid: process.pid,
      startedAt: "2026-11-21T10:00:00.000Z",
      automatic: false,
    }
    const { said, io } = heard()
    const code = await runOp(
      call("pause"),
      { up: () => Promise.reject(new InstanceBusy("t", holder)) },
      io,
    )
    expect(code).toBe(1)
    expect(said).toEqual([
      `::error::${new InstanceBusy("t", holder).message}\n`,
    ])
  })

  it("kills without a service, and brings none up", async () => {
    await svc?.stop()
    svc = null
    let ups = 0
    const { io } = heard()
    const code = await runOp(
      call("kill"),
      {
        up: async () => {
          ups += 1
          await Promise.resolve()
        },
        withoutService: () => Promise.resolve(0),
      },
      io,
    )
    expect(code).toBe(0)
    expect(ups).toBe(0)
  })
})

describe("winvm files remount, as a command", () => {
  const runCmd = async (
    outcome: Awaited<ReturnType<typeof remountHeld>>,
  ): Promise<{ code: number; out: string; err: string }> => {
    const said = { out: "", err: "" }
    const code = await remountCmd(
      parseArgs(["files", "remount", "-i", "t"]),
      {
        out: (text) => {
          said.out += text
        },
        err: (text) => {
          said.err += text
        },
      },
      async () => await Promise.resolve(outcome),
    )
    return { code, ...said }
  }

  it("exits 0 and says nothing when it mounted the drives", async () => {
    expect(await runCmd({ kind: "mounted" })).toEqual({
      code: 0,
      out: "",
      err: "",
    })
  })

  it("exits 0 and says so when no drives were pending", async () => {
    expect(await runCmd({ kind: "nothing pending" })).toEqual({
      code: 0,
      out: 'no drives of "t" are waiting to be mounted again\n',
      err: "",
    })
  })

  it("exits 1 when the mount failed, leaving the reason to the warning the mount printed", async () => {
    expect(await runCmd({ kind: "failed" })).toEqual({
      code: 1,
      out: "",
      err: "",
    })
  })

  it("exits 1 and says why when it was refused", async () => {
    expect(await runCmd({ kind: "refused", why: "the reason" })).toEqual({
      code: 1,
      out: "",
      err: "::error::the reason\n",
    })
  })
})

describe("stopping the service", () => {
  it("ends the ops still waiting for the lease at once, saying why", async () => {
    const outside = gate()
    const other = withOperation("t", "stop", async () => {
      await outside.opened
    })
    await Bun.sleep(20)
    const queued = await submit("pause", { wait: true })
    const t0 = Date.now()
    await svc?.stop()
    svc = null
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(endOf(queued.body.id)).toMatchObject({
      queued: true,
      exitCode: 1,
      error: "winvm's service stopped",
    })
    outside.open()
    await other
  })

  it("waits for the op in flight to end and be recorded", async () => {
    const a = await submit("resume")
    await until(() => running === 1)
    let stopped = false
    const stopping = svc?.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(100)
    expect(stopped).toBe(false)
    expect(endOf(a.body.id)).toBeUndefined()
    gates.resume?.open()
    await stopping
    svc = null
    expect(endOf(a.body.id)).toMatchObject({ ok: true })
  })
})

const realReboot = SERVICE_HANDLERS.reboot ?? {
  cancel: "never",
  run: async () => await Promise.resolve(1),
}

describe("host end", () => {
  let outcome: Promise<HostEndOutcome> | null = null
  let handedBack: string[] = []
  let stowed = 0
  let stowedAt = 0
  let release: () => Promise<void> = async () => {
    await Promise.resolve()
  }

  const hostEnd = (_name: string, deadlineMs: number): Promise<unknown> => {
    outcome = runHostEnd(deadlineMs, {
      facts: () => ({
        action: "stow",
        ephemeral: false,
        installMedia: false,
        unsaveable: null,
        freeBytes: null,
        needBytes: null,
        busy: busyNow(),
      }),
      running: () => true,
      busy: busyNow,
      cancel: async () => {
        await release()
      },
      stow: async () => {
        await withOperation(
          "t",
          "stow",
          () => {
            stowed += 1
            stowedAt = Date.now()
          },
          { automatic: true, waitMs: 0 },
        )
      },
      handBack: async (end, reason) => {
        handedBack.push(`${end}: ${reason}`)
        await Promise.resolve()
      },
      note: () => undefined,
      now: Date.now,
      sleep: async (ms) => {
        await Bun.sleep(ms)
      },
    })
    return outcome
  }

  const busyNow = (): {
    operation: string
    automatic: boolean
    irreversible: boolean
  } | null => {
    const h = leaseHolder("t")
    return h === null
      ? null
      : { operation: h.operation, automatic: h.automatic, irreversible: false }
  }

  const ending = async (): Promise<number> => {
    const res = await fetch("http://localhost/host-ending", {
      unix: p.control,
      method: "POST",
      body: JSON.stringify({ deadlineMs: Date.now() + 8000, budgetMs: 55_000 }),
    })
    return res.status
  }

  beforeEach(async () => {
    outcome = null
    handedBack = []
    stowed = 0
    release = async () => {
      await Promise.resolve()
    }
    await svc?.stop()
    svc = await runService("t", {
      exitAfterMs: 60_000,
      checkMs: 50,
      handlers: {
        ...handlers,
        reboot: realReboot,
        lock: {
          cancel: "never",
          run: async () => {
            await qmp.execute(p.qmp, "stop")
            return 0
          },
        },
        sleep: {
          cancel: "never",
          run: async () => {
            for (;;) {
              try {
                await qmp.execute(p.qmp, "query-status")
              } catch {
                console.error("::error::the guest was not back")
                return 1
              }
            }
          },
        },
      },
      hostEnd,
    })
  })

  it("ends a reboot already sent to Windows at once, and stows instead of waiting it out", async () => {
    const guest = new FakeGuest(fake, agent)
    guest.bootDelayMs = 60_000
    const a = await submit("reboot")
    await until(() =>
      opsOf(a.body.id).some(
        (e) =>
          e.kind === "op" && e.phase === "output" && e.text === "rebooting",
      ),
    )
    const t0 = Date.now()
    expect(await ending()).toBe(202)
    await until(() => outcome !== null, 10_000)
    expect(await outcome).toBe("stowed")
    expect(Date.now() - t0).toBeLessThan(6000)
    expect(handedBack).toEqual([])
    expect(stowed).toBe(1)
    expect(await ended(a.body.id)).toMatchObject({
      ok: false,
      error: "host-end",
    })
    expect(guest.shutdownRequests).toEqual(["reboot"])
  }, 20_000)

  it("never lets an op queued behind an autosave take the guest from host end", async () => {
    const autosave = gate()
    const saving = withOperation(
      "t",
      "save",
      async () => {
        await autosave.opened
      },
      { automatic: true },
    )
    await Bun.sleep(20)
    release = async () => {
      autosave.open()
      await saving
      await Bun.sleep(400)
    }
    const queued = await submit("resume")
    expect(queued.body).toMatchObject({ queued: { operation: "save" } })
    expect(await ending()).toBe(202)
    await until(() => outcome !== null, 10_000)
    expect(await outcome).toBe("stowed")
    expect(handedBack).toEqual([])
    expect(stowed).toBe(1)
    expect(running).toBe(0)
    expect(await ended(queued.body.id)).toMatchObject({
      ok: false,
      exitCode: 1,
      leased: false,
    })
    const said = opsOf(queued.body.id).flatMap((e) =>
      e.kind === "op" && e.phase === "output" ? [e.text] : [],
    )
    expect(said.join("")).toContain("the Mac is shutting down")
  }, 20_000)

  it("lets a command the op already sent to QEMU be answered before it stows", async () => {
    const plain = fake.handler
    let answeredAt = 0
    fake.handler = async (cmd) => {
      if (cmd.execute !== "stop") return await plain(cmd)
      await Bun.sleep(800)
      answeredAt = Date.now()
      return { return: {} }
    }
    const a = await submit("lock")
    await until(() => fake.commands.includes("stop"))
    expect(await ending()).toBe(202)
    await until(() => outcome !== null, 10_000)
    expect(await outcome).toBe("stowed")
    expect(answeredAt).toBeGreaterThan(0)
    expect(stowedAt).toBeGreaterThanOrEqual(answeredAt)
    expect(await ended(a.body.id)).toMatchObject({ ok: true, exitCode: 0 })
  }, 20_000)

  it("reports an op it ended as ended by host end, not as the failure the op then made of it", async () => {
    const plain = fake.handler
    fake.handler = async (cmd) => {
      if (cmd.execute === "query-status") await Bun.sleep(100)
      return await plain(cmd)
    }
    const a = await submit("sleep")
    await Bun.sleep(150)
    expect(await ending()).toBe(202)
    await until(() => outcome !== null, 10_000)
    expect(await outcome).toBe("stowed")
    expect(await ended(a.body.id)).toMatchObject({
      ok: false,
      error: "host-end",
    })
    expect(
      opsOf(a.body.id).filter((e) => e.kind === "op" && e.phase === "output"),
    ).toEqual([])
  }, 20_000)

  it("never calls an op cancelled that it already ended", async () => {
    const plain = fake.handler
    fake.handler = async (cmd) => {
      if (cmd.execute === "stop") await Bun.sleep(800)
      return await plain(cmd)
    }
    const a = await submit("lock")
    await until(() => fake.commands.includes("stop"))
    expect(await ending()).toBe(202)
    const c = await post("/ops/cancel", {
      protocol: OPS_PROTOCOL,
      id: a.body.id,
    })
    expect(c.status).toBe(409)
    expect((c.body.refused as { reason: string }).reason).toContain(
      "the Mac is shutting down",
    )
    await until(() => outcome !== null, 10_000)
    await outcome
  }, 20_000)

  it("still says the Mac is shutting down when the service starts stopping during host end", async () => {
    release = async () => {
      await Bun.sleep(1500)
    }
    const autosave = gate()
    const saving = withOperation(
      "t",
      "save",
      async () => {
        await autosave.opened
      },
      { automatic: true },
    )
    await Bun.sleep(20)
    expect(await ending()).toBe(202)
    await until(() => outcome !== null, 10_000)
    const stopping = svc?.stop()
    const r = await submit("pause")
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ hostEnding: true })
    autosave.open()
    await saving
    await outcome
    await stopping
    svc = null
  }, 20_000)

  it("leaves the drives down rather than remount them for a client once it has begun", async () => {
    release = async () => {
      await Bun.sleep(1500)
    }
    const autosave = gate()
    const saving = withOperation(
      "t",
      "save",
      async () => {
        await autosave.opened
      },
      { automatic: true },
    )
    await Bun.sleep(20)
    expect(await ending()).toBe(202)
    autosave.open()
    await saving
    let mounted = 0
    const r = await remountHeld("t", async () => {
      mounted += 1
      return await Promise.resolve("mounted")
    })
    expect(mounted).toBe(0)
    expect(r).toEqual({
      kind: "refused",
      why: 'the Mac is shutting down, so the guest\'s drives of "t" were not mounted again',
    })
    await until(() => outcome !== null, 10_000)
    await outcome
  }, 20_000)

  it("cuts a remount short that is already mounting, so the stow is not kept waiting for the mount", async () => {
    let mounting = false
    const remounting = remountHeld(
      "t",
      async () => {
        mounting = true
        await Bun.sleep(5000)
        return "mounted"
      },
      new AbortController().signal,
      { hostPollMs: 50 },
    )
    await until(() => mounting)
    const began = Date.now()
    expect(await ending()).toBe(202)
    expect(await remounting).toEqual({
      kind: "refused",
      why: 'the Mac is shutting down, so the guest\'s drives of "t" were not mounted again',
    })
    expect(Date.now() - began).toBeLessThan(1500)
    await until(() => outcome !== null, 10_000)
    expect(await outcome).toBe("stowed")
    expect(stowedAt - began).toBeLessThan(2500)
  }, 20_000)

  it("takes no new op once it has begun, and says why", async () => {
    release = async () => {
      await Bun.sleep(2000)
    }
    const autosave = gate()
    const saving = withOperation(
      "t",
      "save",
      async () => {
        await autosave.opened
      },
      { automatic: true },
    )
    await Bun.sleep(20)
    expect(await ending()).toBe(202)
    const r = await submit("pause")
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ protocol: OPS_PROTOCOL, hostEnding: true })
    expect(seen).toEqual([])
    autosave.open()
    await saving
    await until(() => outcome !== null, 10_000)
    await outcome
  }, 20_000)
})

describe("the long verbs' rules in the queue", () => {
  const longHandlers: OpHandlers = {
    stow: {
      cancel: "cooperative",
      hostEnd: "finish",
      run: async () => {
        await held("stow")
        return currentOp()?.cancelled.aborted === true ? 130 : 0
      },
    },
    stop: {
      cancel: "cooperative",
      hostEnd: "finish-after-mark",
      run: async () => {
        await held("before")
        pointOfNoReturn()
        await held("after")
        return 0
      },
    },
    start: {
      cancel: "before-request",
      run: async () => {
        await held("start")
        return 0
      },
    },
  }
  let hostEndedAt: number | null = null

  beforeEach(async () => {
    hostEndedAt = null
    for (const k of ["stow", "before", "after", "start"]) gates[k] = gate()
    await svc?.stop()
    svc = await runService("t", {
      exitAfterMs: 60_000,
      checkMs: 50,
      handlers: longHandlers,
      hostEnd: async () => {
        hostEndedAt = Date.now()
        await Promise.resolve()
      },
    })
  })

  const hostEnding = async (): Promise<void> => {
    await post("/host-ending", { deadlineMs: Date.now() + 30_000 })
  }

  it("lets a cooperative op put things back when cancelled, and ends it with what it returns", async () => {
    const a = await submit("stow")
    await until(() => running === 1)
    const c = await post("/ops/cancel", { protocol: OPS_PROTOCOL })
    expect(c.status).toBe(200)
    await Bun.sleep(100)
    expect(endOf(a.body.id)).toBeUndefined()
    gates.stow?.open()
    expect(await ended(a.body.id)).toMatchObject({ exitCode: 130 })
  })

  it("lets a stow finish through host end, and does not wait for it before host end begins", async () => {
    const a = await submit("stow")
    await until(() => running === 1)
    await hostEnding()
    await until(() => hostEndedAt !== null)
    expect(endOf(a.body.id)).toBeUndefined()
    gates.stow?.open()
    expect(await ended(a.body.id)).toMatchObject({ ok: true, exitCode: 0 })
  })

  it("ends a stop at host end before its point of no return, and lets it finish after", async () => {
    const early = await submit("stop")
    await until(() => running === 1)
    await hostEnding()
    expect(await ended(early.body.id)).toMatchObject({ error: "host-end" })
    gates.before?.open()
    gates.after?.open()
  })

  it("lets a stop past its point of no return finish through host end", async () => {
    const a = await submit("stop")
    await until(() => running === 1)
    gates.before?.open()
    await Bun.sleep(50)
    await hostEnding()
    await until(() => hostEndedAt !== null)
    expect(endOf(a.body.id)).toBeUndefined()
    gates.after?.open()
    expect(await ended(a.body.id)).toMatchObject({ ok: true })
  })

  it("ends a start at host end, as the short verbs are", async () => {
    const a = await submit("start")
    await until(() => running === 1)
    await hostEnding()
    expect(await ended(a.body.id)).toMatchObject({ error: "host-end" })
    gates.start?.open()
  })

  it("takes the id its client chose, and refuses one that is not an id", async () => {
    const a = await submit("start", { id: "close-0123456789abcdef" })
    expect(a.status).toBe(202)
    expect(a.body.id).toBe("close-0123456789abcdef")
    gates.start?.open()
    expect(await ended("close-0123456789abcdef")).toMatchObject({ ok: true })
    expect(opsOf("close-0123456789abcdef")[0]).toMatchObject({
      phase: "begin",
      operation: "start",
    })
    const bad = await submit("start", { id: "x y" })
    expect(bad.status).toBe(400)
  })

  it("refuses a second op with the id of one not yet under way", async () => {
    const queue = new OpQueue("t", longHandlers, {
      record: () => undefined,
      nudge: () => undefined,
      killed: () => undefined,
    })
    const request = {
      op: "start",
      args: [],
      wait: true,
      id: "same-id-0001",
    } as const
    const [first, second] = await Promise.all([
      queue.submit({ ...request, wait: false }),
      queue.submit(request),
    ])
    expect([first.kind, second.kind]).toEqual(["accepted", "failed"])
    gates.start?.open()
    await queue.drain()
    expect(
      opsOf("same-id-0001").filter((e) => e.kind === "op" && e.phase === "end"),
    ).toHaveLength(1)
  })
})

describe("an op winvm's service runs by itself", () => {
  const ownQueue = (): OpQueue =>
    new OpQueue(
      "t",
      {},
      {
        record: () => undefined,
        nudge: () => undefined,
        killed: () => undefined,
      },
    )
  const automaticOf = (operation: string): readonly Entry[] =>
    readSince("t", START).entries.filter(
      (e) =>
        e.kind === "op" &&
        (e.phase === "begin" || e.phase === "end") &&
        e.operation === operation &&
        e.automatic,
    )

  it("runs under the lease as winvm's own, by the service, and answers with its exit code", async () => {
    const queue = ownQueue()
    const ran: Args[] = []
    const r = await queue.perform(
      "stow",
      {
        cancel: "cooperative",
        run: async (args) => {
          ran.push(args)
          expect(JSON.parse(readFileSync(p.lease, "utf8"))).toMatchObject({
            operation: "stow",
            pid: process.pid,
            automatic: true,
          })
          return await Promise.resolve(4)
        },
      },
      ["--force"],
    )
    expect(r).toMatchObject({ kind: "done", code: 4 })
    expect(ran[0]?.flags.has("automatic")).toBe(true)
    expect(ran[0]?.flags.has("force")).toBe(true)
    expect(automaticOf("stow").map((e) => e.kind === "op" && e.phase)).toEqual([
      "begin",
      "end",
    ])
    expect(automaticOf("stow")[1]).toMatchObject({
      pid: process.pid,
      leased: true,
      ok: false,
      exitCode: 4,
    })
  })

  it("answers busy at once, running nothing, while someone else holds the instance", async () => {
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "reboot",
        id: "someone-else",
        pid: process.pid,
        pidStart: null,
        startedAt: "2026-11-17T00:00:00.000Z",
        instance: "t",
        automatic: false,
      }),
    )
    let ran = false
    const r = await ownQueue().perform(
      "save",
      {
        cancel: "never",
        run: async () => {
          ran = true
          return await Promise.resolve(0)
        },
      },
      [],
    )
    expect(r).toMatchObject({ kind: "busy", holder: { operation: "reboot" } })
    expect(ran).toBe(false)
    expect(automaticOf("save")).toEqual([])
  })

  it("answers with the error its body threw, recorded as it always was", async () => {
    const r = await ownQueue().perform(
      "save",
      {
        cancel: "never",
        run: async () => await Promise.reject(new Error("the disk is full")),
      },
      [],
    )
    expect(r).toMatchObject({ kind: "failed", error: "the disk is full" })
    expect(automaticOf("save").at(-1)).toMatchObject({
      phase: "end",
      ok: false,
      error: "the disk is full",
    })
  })

  it("is cancelled at host end, if it asks to be, and holds the instance until it has put things back", async () => {
    const queue = ownQueue()
    const g = gate()
    let started = false
    let why = ""
    const performing = queue.perform(
      "save",
      {
        cancel: "cooperative",
        hostEnd: "cancel",
        run: async () => {
          started = true
          await g.opened
          const op = currentOp()
          if (op === null) return 1
          why = new OpCancelled(op).message
          return op.cancelled.aborted ? 130 : 0
        },
      },
      [],
    )
    await until(() => started)
    await queue.close("host-end")
    expect(JSON.parse(readFileSync(p.lease, "utf8"))).toMatchObject({
      operation: "save",
      automatic: true,
    })
    g.open()
    expect(await performing).toMatchObject({ kind: "done", code: 130 })
    expect(why).toBe(
      "save was cancelled (the Mac is shutting down) before its point of no return; what it had begun was put back",
    )
  })

  it("answers closed once the Mac is shutting down", async () => {
    const queue = ownQueue()
    await queue.close("host-end")
    expect(
      await queue.perform(
        "save",
        { cancel: "never", run: async () => await Promise.resolve(0) },
        [],
      ),
    ).toEqual({ kind: "closed", reason: "host-end" })
  })
})
