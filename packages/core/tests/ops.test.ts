import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import type { Args } from "../src/args"
import { type Entry, readSince, START } from "../src/eventlog"
import { pointOfNoReturn } from "../src/opcontext"
import { InstanceBusy, leaseHolder, withOperation } from "../src/operation"
import { OPS_PROTOCOL, type OpHandlers } from "../src/ops"
import { type Paths, pathsFor } from "../src/paths"
import * as qmp from "../src/qmp"
import { runService, type ServiceHandle } from "../src/service"
import { FakeAgent } from "./fakes/agent"
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

  it("says when there is nothing to cancel", async () => {
    const none = await cancel()
    expect(none.status).toBe(404)
    expect(none.body).toMatchObject({ protocol: OPS_PROTOCOL, none: true })
  })
})

describe("stopping the service", () => {
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
