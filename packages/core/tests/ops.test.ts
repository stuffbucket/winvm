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
import { type HostEndOutcome, runHostEnd } from "../src/hostend"
import { pointOfNoReturn } from "../src/opcontext"
import { InstanceBusy, leaseHolder, withOperation } from "../src/operation"
import { OPS_PROTOCOL, type OpHandlers } from "../src/ops"
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
