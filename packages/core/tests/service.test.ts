import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { QmpChannel } from "../src/broker"
import { parseAssignment, writeAssignments } from "../src/config"
import {
  appendEntry,
  type Entry,
  endCursor,
  qmpEvent,
  readSince,
  START,
  waitForEvent,
} from "../src/eventlog"
import { buildIdentity } from "../src/identity"
import * as monitor from "../src/monitor"
import { PACKAGE_DIR, type Paths, pathsFor } from "../src/paths"
import { processStart, UNREADABLE_START } from "../src/proc"
import { qemuArgs } from "../src/qemu"
import * as qga from "../src/qga"
import * as qmp from "../src/qmp"
import { runService, type ServiceHandle, serviceSignals } from "../src/service"
import {
  dropServiceRecord,
  ensureService,
  keepService,
  readService,
  type ServiceInfo,
  serviceFreshness,
  stopService,
  wroteRecord,
} from "../src/servicectl"
import {
  type Actions,
  ensureWatcher,
  readWatchState,
  stopWatcher,
  watchPathsFor,
} from "../src/watch"
import { FakeAgent } from "./fakes/agent"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"
import { FakeQmp } from "./fakes/qmp"

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

let home = ""
let savedHome: string | undefined
let p: Paths
let fake: FakeQmp
let agent: FakeAgent
let svc: ServiceHandle | null = null
let qemuPid = 0

beforeEach(async () => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync(resolve(tmpdir(), "winvm-svc-"))
  process.env.WINVM_HOME = home
  p = pathsFor("t")
  mkdirSync(p.dir, { recursive: true })
  qemuPid = (await lockPidfile(p.pid, "qemu-system-aarch64")).pid
  fake = new FakeQmp(p.qmpQemu)
  await fake.listen()
  agent = new FakeAgent(p.qgaQemu)
  await agent.listen()
})

afterEach(async () => {
  await svc?.stop()
  svc = null
  await releasePidfiles()
  await fake.close().catch(() => undefined)
  await agent.close().catch(() => undefined)
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const lastEvent = (): Record<string, unknown> => {
  const lines = readFileSync(p.events, "utf8").trim().split("\n")
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>
}

const entries = (): readonly Entry[] => readSince("t", START).entries

const qmpEntries = (): readonly Entry[] =>
  entries().filter((e) => e.kind === "qmp")

const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await sleep(20)
  }
}

const synced = async (): Promise<Entry | undefined> => {
  await until(() => entries().some((e) => e.kind === "sync"))
  return entries().find((e) => e.kind === "sync")
}

const serviceState = async (): Promise<string> =>
  (
    (await (
      await fetch("http://localhost/status", { unix: p.control })
    ).json()) as { state: string }
  ).state

const recorded = (): ServiceInfo | null => {
  try {
    return JSON.parse(readFileSync(p.service, "utf8")) as ServiceInfo
  } catch {
    return null
  }
}

describe("the service", () => {
  it("serves the instance's sockets and records itself", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    expect(await qmp.status(p.qmp)).toBe("running")
    const info = recorded()
    expect(info?.pid).toBe(process.pid)
    expect(statSync(p.service).mode & 0o777).toBe(0o600)
    expect(info?.build).toBe(buildIdentity())
    expect(entries().find((e) => e.kind === "service")).toMatchObject({
      instance: "t",
      kind: "service",
      what: "started",
    })
  })

  it("records QMP events whole, on disk and on the stream", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    const res = await fetch("http://localhost/events", { unix: p.control })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await qmp.status(p.qmp)
    fake.emit({ event: "STOP", timestamp: { seconds: 1, microseconds: 0 } })
    let text = ""
    const dec = new TextDecoder()
    while (!text.includes('"STOP"'))
      text += dec.decode((await reader.read()).value)
    await reader.cancel()
    expect(text).toContain('"kind":"qmp","event":"STOP"')
    expect(lastEvent()).toMatchObject({
      kind: "qmp",
      event: "STOP",
      data: null,
      timestamp: { seconds: 1, microseconds: 0 },
    })
    expect(await serviceState()).toBe("paused")
  })

  it("keeps each event's data and QEMU's timestamp, for events with no run state too", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await synced()
    const sent = [
      { event: "POWERDOWN", timestamp: { seconds: 10, microseconds: 1 } },
      {
        event: "RESET",
        data: { guest: true, reason: "guest-reset" },
        timestamp: { seconds: 11, microseconds: 2 },
      },
      {
        event: "VSERPORT_CHANGE",
        data: { id: "qga0", open: false },
        timestamp: { seconds: 12, microseconds: 3 },
      },
      {
        event: "SHUTDOWN",
        data: { guest: true, reason: "guest-shutdown" },
        timestamp: { seconds: 13, microseconds: 4 },
      },
    ]
    for (const e of sent) fake.emit(e)
    await until(() => qmpEntries().length === sent.length)
    expect(qmpEntries()).toEqual(
      sent.map((e) => ({
        t: expect.any(String) as string,
        instance: "t",
        kind: "qmp",
        event: e.event,
        data: e.data ?? null,
        timestamp: e.timestamp,
      })),
    )
    expect(await serviceState()).toBe("shutdown")
  })

  it("reads QEMU's run state on every connect, so a sync always follows the connection", async () => {
    fake.handler = (cmd) =>
      cmd.execute === "query-status"
        ? { return: { status: "paused", running: false } }
        : { return: {} }
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(await synced()).toMatchObject({
      instance: "t",
      kind: "sync",
      status: "paused",
      running: false,
    })
    expect(await serviceState()).toBe("paused")
  })

  it("reads the run state again on every reconnect, recording the loss between", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await synced()
    await fake.close()
    await until(() => entries().some((e) => e.kind === "disconnected"))
    expect(await serviceState()).toBe("unknown")
    fake = new FakeQmp(p.qmpQemu)
    fake.handler = (cmd) =>
      cmd.execute === "query-status"
        ? { return: { status: "suspended", running: false } }
        : { return: {} }
    await fake.listen()
    await until(() => entries().filter((e) => e.kind === "sync").length === 2)
    expect(
      entries()
        .filter((e) => e.kind === "sync" || e.kind === "disconnected")
        .map((e) => (e.kind === "sync" ? e.status : e.kind)),
    ).toEqual(["running", "disconnected", "suspended"])
    expect(entries().find((e) => e.kind === "disconnected")).toMatchObject({
      reason: "qemu-closed",
    })
    expect(await serviceState()).toBe("suspended")
  })

  it("records the run state it read in QEMU's order against the events around it", async () => {
    fake.handler = (cmd) => {
      if (cmd.execute !== "query-status") return { return: {} }
      fake.emit({ return: { status: "running", running: true }, id: cmd.id })
      fake.emit({ event: "STOP", timestamp: { seconds: 5, microseconds: 0 } })
      return null
    }
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await until(() => qmpEntries().length === 1)
    expect(
      entries()
        .filter((e) => e.kind === "sync" || e.kind === "qmp")
        .map((e) => e.kind),
    ).toEqual(["sync", "qmp"])
    expect(await serviceState()).toBe("paused")
  })

  it("records a failed read of the run state instead of guessing one", async () => {
    fake.handler = (cmd) =>
      cmd.execute === "query-status"
        ? { error: { class: "GenericError", desc: "not now" } }
        : { return: {} }
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(await synced()).toMatchObject({
      kind: "sync",
      status: null,
      running: null,
      error: "not now",
    })
    expect(await serviceState()).toBe("unknown")
  })

  it("rotates its record past the size bound, but never while an operation holds the instance", async () => {
    svc = await runService("t", {
      exitAfterMs: 5000,
      checkMs: 50,
      eventsMaxBytes: 2048,
    })
    await synced()
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "stop",
        id: "l",
        pid: process.pid,
        pidStart: processStart(process.pid),
        startedAt: "",
        instance: "t",
        automatic: false,
      }),
    )
    for (let i = 0; i < 40; i += 1)
      fake.emit({ event: "RTC_CHANGE", data: { offset: i } })
    await until(() => qmpEntries().length === 40)
    await sleep(300)
    expect(existsSync(p.eventsPrev)).toBe(false)
    rmSync(p.lease)
    await until(() => existsSync(p.eventsPrev))
    expect(
      statSync(p.events, { throwIfNoEntry: false })?.size ?? 0,
    ).toBeLessThan(2048)
    expect(
      readSince("t", START).entries.filter((e) => e.kind === "qmp"),
    ).toHaveLength(40)
  })

  it("keeps a quiet stream open past Bun's default idle timeout", async () => {
    svc = await runService("t", {
      exitAfterMs: 30_000,
      checkMs: 50,
      heartbeatMs: 60_000,
    })
    const res = await fetch("http://localhost/events", { unix: p.control })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await sleep(14_000)
    await qmp.status(p.qmp)
    fake.emit({ event: "STOP", timestamp: { seconds: 1, microseconds: 0 } })
    let text = ""
    const dec = new TextDecoder()
    while (!text.includes('"STOP"')) {
      const r = await reader.read()
      if (r.done) break
      text += dec.decode(r.value)
    }
    await reader.cancel().catch(() => undefined)
    expect(text).toContain('"kind":"qmp","event":"STOP"')
  }, 25_000)

  it("drops a subscriber that went away", async () => {
    svc = await runService("t", {
      exitAfterMs: 200,
      checkMs: 50,
      heartbeatMs: 50,
    })
    const ac = new AbortController()
    const res = await fetch("http://localhost/events", {
      unix: p.control,
      signal: ac.signal,
    })
    await (res.body as ReadableStream<Uint8Array>).getReader().read()
    expect(svc.subscribers()).toBe(1)
    ac.abort()
    await sleep(300)
    expect(svc.subscribers()).toBe(0)
  })

  it("answers on the instance's control socket, which only its owner can open", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    expect(statSync(p.control).mode & 0o777).toBe(0o600)
    const res = await fetch("http://localhost/status", { unix: p.control })
    expect(((await res.json()) as { qemuPid: number }).qemuPid).toBe(qemuPid)
    expect(recorded()).not.toHaveProperty("port")
    expect(recorded()).not.toHaveProperty("token")
  })

  it("survives QEMU being replaced, and stops once QEMU is gone for good", async () => {
    svc = await runService("t", { exitAfterMs: 300, checkMs: 50 })
    expect(await qmp.status(p.qmp)).toBe("running")
    await fake.close()
    await sleep(300)
    fake = new FakeQmp(p.qmpQemu)
    await fake.listen()
    expect(await qmp.status(p.qmp)).toBe("running")
    rmSync(p.pid)
    await svc.done
    svc = null
    expect(existsSync(p.service)).toBe(false)
    expect(existsSync(p.qmp)).toBe(false)
    expect(existsSync(p.qga)).toBe(false)
    expect(existsSync(p.control)).toBe(false)
    expect(lastEvent()).toMatchObject({ kind: "service", what: "stopped" })
  })

  it("waits out a load: QEMU gone but the instance's lease held by a live process", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "load",
        id: "l",
        pid: process.pid,
        pidStart: processStart(process.pid),
        startedAt: "",
        instance: "t",
        automatic: false,
      }),
    )
    rmSync(p.pid)
    await sleep(600)
    expect(recorded()?.pid).toBe(process.pid)
    expect(existsSync(p.qmp)).toBe(true)
  })
})

describe("a host end handed to the service", () => {
  const post = async (body: unknown): Promise<number> =>
    (
      await fetch("http://localhost/host-ending", {
        unix: p.control,
        method: "POST",
        body: JSON.stringify(body),
      })
    ).status

  it("is accepted once, runs with the keeper's deadline, and holds the service until it finishes", async () => {
    const calls: [string, number][] = []
    let finish = (): void => undefined
    const gate = new Promise<void>((r) => {
      finish = r
    })
    svc = await runService("t", {
      exitAfterMs: 60_000,
      checkMs: 50,
      hostEnd: async (name, deadlineMs) => {
        calls.push([name, deadlineMs])
        await gate
      },
    })
    expect(await post({ deadlineMs: 1234, budgetMs: 55_000 })).toBe(202)
    expect(await post({ deadlineMs: 1234, budgetMs: 55_000 })).toBe(409)
    expect(calls).toEqual([["t", 1234]])
    let stopped = false
    const stopping = svc.stop().then(() => {
      stopped = true
    })
    await sleep(200)
    expect(stopped).toBe(false)
    finish()
    await stopping
    expect(stopped).toBe(true)
    svc = null
  })

  it("refuses a request without a deadline", async () => {
    svc = await runService("t", {
      exitAfterMs: 60_000,
      checkMs: 50,
      hostEnd: async () => {
        await Promise.resolve()
      },
    })
    expect(await post({ budgetMs: 1 })).toBe(400)
  })
})

describe("one service per instance", () => {
  it("refuses to start while another service holds the instance, and leaves it working", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await expect(
      runService("t", { exitAfterMs: 5000, checkMs: 50 }),
    ).rejects.toThrow(`holds instance "t"`)
    expect(recorded()?.pid).toBe(process.pid)
    expect(await qmp.status(p.qmp)).toBe("running")
    expect(
      (await fetch("http://localhost/status", { unix: p.control })).status,
    ).toBe(200)
  })

  it("takes over the record of a service that has gone", async () => {
    const gone = Bun.spawn(["true"])
    await gone.exited
    writeFileSync(
      p.service,
      JSON.stringify({ pid: gone.pid, cli: "", version: "", startedAt: "" }),
    )
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(recorded()?.pid).toBe(process.pid)
  })

  it("takes over a record that names pid 1, which is never a service", async () => {
    writeFileSync(
      p.service,
      JSON.stringify({
        pid: 1,
        cli: "",
        version: "",
        startedAt: "2000-01-01T00:00:00.000Z",
      }),
    )
    expect(readService(p)).toBeNull()
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(recorded()?.pid).toBe(process.pid)
    expect(recorded()?.pidStart).toBe(processStart(process.pid))
  })

  it("stops when its record names another service, and leaves that service's sockets", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    const newer = new QmpChannel({
      listen: p.qmp,
      upstream: resolve(home, "nowhere.sock"),
    })
    await newer.start()
    writeFileSync(
      p.service,
      JSON.stringify({ pid: 1, cli: "", version: "", startedAt: "" }),
    )
    await svc.done
    svc = null
    expect(existsSync(p.qmp)).toBe(true)
    await newer.stop()
  })

  it("is kept alive by a launch that just reused it", async () => {
    svc = await runService("t", { exitAfterMs: 300, checkMs: 50 })
    rmSync(p.pid)
    await sleep(200)
    keepService(p)
    await sleep(250)
    expect(recorded()?.pid).toBe(process.pid)
    await svc.done
    svc = null
  })

  it("does not take a process that started after the record was written for its service, as a reused pid would", () => {
    const other = Bun.spawn(["sleep", "30"])
    writeFileSync(
      p.service,
      JSON.stringify({
        pid: other.pid,
        cli: "",
        version: "",
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    )
    try {
      expect(readService(p)).toBeNull()
      const kills: string[] = []
      stopService(p, { kill: (_pid, sig) => void kills.push(sig) })
      expect(kills).toEqual([])
    } finally {
      other.kill()
    }
  })

  it("takes the process that wrote the record for its service", () => {
    const h = Bun.spawn(["sleep", "30"])
    writeFileSync(
      p.service,
      JSON.stringify({
        pid: h.pid,
        cli: "",
        version: "",
        startedAt: new Date(Date.now() + 1000).toISOString(),
      }),
    )
    try {
      expect(readService(p)?.pid).toBe(h.pid)
    } finally {
      h.kill()
    }
  })

  it("never takes this very process for a service, so a stale record naming it cannot make it signal itself", () => {
    writeFileSync(
      p.service,
      JSON.stringify({
        pid: process.pid,
        cli: "",
        version: "",
        startedAt: new Date().toISOString(),
      }),
    )
    expect(readService(p)).toBeNull()
    let t = 0
    const kills: string[] = []
    stopService(p, {
      kill: (_pid, sig) => void kills.push(sig),
      now: () => t,
      sleep: (ms) => {
        t += ms
      },
    })
    expect(kills).toEqual([])
  })

  it("drops a rejected record only while it is still that record, never a service's fresh claim", () => {
    const rejected = JSON.stringify({
      pid: 424_242,
      cli: "",
      version: "",
      startedAt: "",
    })
    const fresh = JSON.stringify({
      pid: 424_243,
      cli: "",
      version: "",
      startedAt: "",
      build: "sha256:new",
    })
    writeFileSync(p.service, fresh)
    expect(dropServiceRecord(p, rejected)).toBe(false)
    expect(readFileSync(p.service, "utf8")).toBe(fresh)
    writeFileSync(p.service, rejected)
    expect(dropServiceRecord(p, rejected)).toBe(true)
    expect(existsSync(p.service)).toBe(false)
  })
})

describe("which process wrote a service record", () => {
  const START = "Sat Nov 21 10:00:00 2026"
  const at = (startedAt: string, start: string | null = START): boolean =>
    wroteRecord({ pid: 424_242, startedAt }, () => start)

  it("is the one that started no later than the record says the service did", () => {
    expect(at("2026-11-21T10:00:00.500Z")).toBe(true)
    expect(at("2026-11-21T10:00:07.000Z")).toBe(true)
  })

  it("is not one that started after it, as a process given a reused pid did", () => {
    expect(at("2026-11-21T09:59:59.900Z")).toBe(false)
  })

  it("is none when the process is gone, its start can't be read, or the record has no time", () => {
    expect(at("2026-11-21T10:00:01.000Z", null)).toBe(false)
    expect(at("2026-11-21T10:00:01.000Z", UNREADABLE_START)).toBe(false)
    expect(at("")).toBe(false)
  })

  it("is the one whose start the record names exactly, when it names one", () => {
    const exact = (pidStart: string, start: string | null): boolean =>
      wroteRecord(
        { pid: 424_242, startedAt: "2026-11-21T10:00:05.000Z", pidStart },
        () => start,
      )
    expect(exact(START, START)).toBe(true)
    expect(exact(START, "Sat Nov 21 10:00:01 2026")).toBe(false)
    expect(exact(START, "Sat Nov 21 09:59:59 2026")).toBe(false)
  })

  it("is never pid 1 or below, whatever the record says", () => {
    for (const pid of [1, 0, -1])
      expect(
        wroteRecord(
          { pid, startedAt: "2099-01-01T00:00:00Z", pidStart: null },
          () => START,
        ),
      ).toBe(false)
  })

  it("is never this very process", () => {
    expect(
      wroteRecord({ pid: process.pid, startedAt: "2099-01-01T00:00:00Z" }),
    ).toBe(false)
  })
})

describe("waiting for an entry while the service runs", () => {
  it("wakes from the service's stream instead of waiting for the next look at the file", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await synced()
    const since = endCursor("t")
    const waiting = waitForEvent("t", qmpEvent("SHUTDOWN"), Date.now() + 8000, {
      since,
      pollMs: 30_000,
      streamPollMs: 30_000,
    })
    await until(() => svc?.subscribers() === 1)
    const t0 = Date.now()
    fake.emit({
      event: "SHUTDOWN",
      data: { guest: true, reason: "guest-shutdown" },
      timestamp: { seconds: 7, microseconds: 0 },
    })
    const got = await waiting
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(got?.entry).toMatchObject({
      kind: "qmp",
      event: "SHUTDOWN",
      data: { guest: true, reason: "guest-shutdown" },
    })
  })

  it("keeps waiting across the service being replaced, and loses nothing recorded meanwhile", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await synced()
    const since = endCursor("t")
    const waiting = waitForEvent(
      "t",
      qmpEvent("SHUTDOWN"),
      Date.now() + 10_000,
      {
        since,
        pollMs: 50,
        streamPollMs: 30_000,
      },
    )
    await until(() => svc?.subscribers() === 1)
    await svc.stop()
    appendEntry("t", { kind: "service", what: "between services" })
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await until(() => svc?.subscribers() === 1)
    fake.emit({
      event: "SHUTDOWN",
      data: { guest: false, reason: "host-signal" },
      timestamp: { seconds: 8, microseconds: 0 },
    })
    expect((await waiting)?.entry).toMatchObject({
      event: "SHUTDOWN",
      data: { guest: false, reason: "host-signal" },
    })
  })
})

describe("one service per instance, continued", () => {
  it("asks for the guest's port without waiting behind a QMP caller", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    const held = monitor.withQmp(
      p.qmp,
      async () => {
        await sleep(1500)
      },
      3000,
    )
    await sleep(100)
    const t0 = Date.now()
    expect(await qga.call(p.qga, { execute: "guest-ping" }, 1000)).toEqual({
      return: {},
    })
    expect(Date.now() - t0).toBeLessThan(800)
    await held
  })

  it("never connects to the agent after the guest closed its port, though QEMU sends no event for it", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(await qga.call(p.qga, { execute: "guest-ping" }, 1000)).toEqual({
      return: {},
    })
    const before = agent.connections
    const open = fake.handler
    fake.handler = (cmd) =>
      cmd.execute === "query-chardev"
        ? { return: [{ label: "qga0", "frontend-open": false }] }
        : open(cmd)
    await expect(
      qga.call(p.qga, { execute: "guest-ping" }, 500),
    ).rejects.toThrow("timed out")
    expect(agent.connections).toBe(before)
  })
})

describe("starting the service", () => {
  const cli = resolve(PACKAGE_DIR, "..", "..", "apps", "cli", "src", "winvm.ts")
  let savedCli: string | undefined

  beforeEach(() => {
    savedCli = process.env.WINVM_CLI
    process.env.WINVM_CLI = cli
  })

  afterEach(() => {
    stopService(p)
    if (savedCli === undefined) delete process.env.WINVM_CLI
    else process.env.WINVM_CLI = savedCli
  })

  it("starts the service once, detached, and reuses it", async () => {
    const first = await ensureService("t", p)
    expect(first.pid).not.toBe(process.pid)
    expect(first.cli).toBe(cli)
    expect(existsSync(p.qmp) && existsSync(p.qga)).toBe(true)
    expect(await qmp.status(p.qmp)).toBe("running")
    expect(
      (await fetch("http://localhost/status", { unix: p.control })).status,
    ).toBe(200)
    const again = await ensureService("t", p)
    expect(again.pid).toBe(first.pid)
    expect(first.build).toBe(buildIdentity())
  }, 30_000)

  it("stops it, and waits until it has gone", async () => {
    const info = await ensureService("t", p)
    stopService(p)
    expect(readService(p)).toBeNull()
    expect(
      spawnSync("ps", ["-o", "stat=", "-p", String(info.pid)], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toMatch(/^(Z.*)?$/)
  }, 30_000)
})

const fakeService = (name: string): ReturnType<typeof Bun.spawn> =>
  Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "fakes", "holder.ts"),
      "winvm",
      "serve",
      "-i",
      name,
    ],
    { stdout: "ignore", stderr: "ignore" },
  )

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    })
      .stdout.trim()
      .startsWith("Z")
  } catch {
    return false
  }
}

describe("service generations", () => {
  const CLI = "/test/apps/cli/src/winvm.ts"
  const CURRENT = "sha256:current"
  let savedCli: string | undefined
  let control: ReturnType<typeof Bun.serve> | null = null
  const spawned: ReturnType<typeof Bun.spawn>[] = []

  const holder = (): ReturnType<typeof Bun.spawn> => {
    const h = fakeService("t")
    spawned.push(h)
    return h
  }
  const record = (pid: number, build: string | undefined, cli = CLI): void => {
    const info: ServiceInfo = {
      pid,
      cli,
      version: "0",
      startedAt: new Date().toISOString(),
      ...(build === undefined ? {} : { build }),
    }
    writeFileSync(p.service, JSON.stringify(info))
  }

  beforeEach(() => {
    savedCli = process.env.WINVM_CLI
    process.env.WINVM_CLI = CLI
    control = Bun.serve({ unix: p.control, fetch: () => new Response("ok") })
  })

  afterEach(async () => {
    await control?.stop(true)
    control = null
    for (const s of spawned.splice(0)) s.kill()
    if (savedCli === undefined) delete process.env.WINVM_CLI
    else process.env.WINVM_CLI = savedCli
  })

  it("classifies a record by its build: current, stale, or legacy when it has none", () => {
    const base = { pid: 1, cli: CLI, version: "0", startedAt: "" }
    expect(serviceFreshness({ ...base, build: CURRENT }, CURRENT)).toBe(
      "current",
    )
    expect(serviceFreshness({ ...base, build: "sha256:old" }, CURRENT)).toBe(
      "stale",
    )
    expect(serviceFreshness(base, CURRENT)).toBe("legacy")
    expect(serviceFreshness({ ...base, build: buildIdentity() })).toBe(
      "current",
    )
  })

  it("still reads a live legacy record: freshness is the caller's decision", () => {
    const h = holder()
    record(h.pid, undefined)
    expect(readService(p)?.pid).toBe(h.pid)
    expect(readService(p)?.build).toBeUndefined()
  })

  for (const [label, cli] of [
    ["this CLI path", CLI],
    ["another CLI path", "/Applications/winvm.app/Contents/MacOS/winvm"],
  ] as const) {
    it(`reuses a service of the current generation from ${label}`, async () => {
      const h = holder()
      record(h.pid, CURRENT, cli)
      const info = await ensureService("t", p, {
        current: CURRENT,
        start: () => {
          throw new Error("must not start a second service")
        },
      })
      expect(info.pid).toBe(h.pid)
      expect(alive(h.pid)).toBe(true)
    })
  }

  for (const [label, build] of [
    ["another generation", "sha256:old"],
    ["no recorded generation", undefined],
  ] as const) {
    it(`replaces a service with ${label}`, async () => {
      const old = holder()
      record(old.pid, build)
      let next: ReturnType<typeof Bun.spawn> | null = null
      const info = await ensureService("t", p, {
        current: CURRENT,
        start: () => {
          next = holder()
          record(next.pid, CURRENT)
        },
      })
      expect(next).not.toBeNull()
      expect(info.pid).toBe((next as unknown as { pid: number }).pid)
      expect(info.build).toBe(CURRENT)
      await sleep(50)
      expect(alive(old.pid)).toBe(false)
    })
  }

  it("does not call the replacement ready until its record carries the current build", async () => {
    const old = holder()
    record(old.pid, "sha256:old")
    await expect(
      ensureService("t", p, {
        current: CURRENT,
        timeoutMs: 400,
        start: () => {
          record(holder().pid, "sha256:old")
        },
      }),
    ).rejects.toThrow("did not start")
  })

  it("never signals a process that started after its record was written, and drops the record", async () => {
    const stranger = Bun.spawn(["sleep", "20"])
    spawned.push(stranger)
    writeFileSync(
      p.service,
      JSON.stringify({
        pid: stranger.pid,
        cli: CLI,
        version: "0",
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        build: "sha256:old",
      }),
    )
    let started = 0
    await expect(
      ensureService("t", p, {
        current: CURRENT,
        timeoutMs: 300,
        start: () => {
          started += 1
        },
      }),
    ).rejects.toThrow("did not start")
    expect(started).toBe(1)
    expect(alive(stranger.pid)).toBe(true)
    expect(existsSync(p.service)).toBe(false)
  })

  it("can be called again after a start that failed", async () => {
    await expect(
      ensureService("t", p, {
        current: CURRENT,
        timeoutMs: 200,
        start: () => undefined,
      }),
    ).rejects.toThrow("did not start")
    const info = await ensureService("t", p, {
      current: CURRENT,
      start: () => {
        record(holder().pid, CURRENT)
      },
    })
    expect(info.build).toBe(CURRENT)
    const again = await ensureService("t", p, {
      current: CURRENT,
      start: () => {
        throw new Error("already running")
      },
    })
    expect(again.pid).toBe(info.pid)
  })
})

describe("stopping a service", () => {
  const run = (o: {
    readonly isService: (t: number) => boolean
  }): { kills: string[]; elapsed: number } => {
    writeFileSync(
      p.service,
      JSON.stringify({ pid: 424_242, cli: "", version: "", startedAt: "" }),
    )
    let t = 0
    const kills: string[] = []
    stopService(p, {
      kill: (_pid, sig) => void kills.push(sig),
      now: () => t,
      sleep: (ms) => {
        t += ms
      },
      running: () => true,
      isService: () => o.isService(t),
    })
    return { kills, elapsed: t }
  }

  it("kills a service that is still running 5 s after SIGUSR2", () => {
    const r = run({ isService: () => true })
    expect(r.kills).toEqual(["SIGUSR2", "SIGKILL"])
    expect(r.elapsed).toBeGreaterThanOrEqual(5000)
    expect(existsSync(p.service)).toBe(false)
  })

  it("re-checks the pid is still this instance's service just before SIGKILL", () => {
    const r = run({ isService: (t) => t < 5000 })
    expect(r.kills).toEqual(["SIGUSR2"])
  })

  it("signals nothing when the record names a process that is not its service", () => {
    expect(run({ isService: () => false }).kills).toEqual([])
  })
})

describe("QEMU's command line", () => {
  it("hands QEMU the private sockets", () => {
    const args = qemuArgs(
      "t",
      p,
      { image: "win11-arm64", vnc: 9, created: "" },
      {
        installMedia: false,
        ephemeral: true,
        virtioBoot: false,
      },
    ).join(" ")
    expect(args).toContain(`unix:${p.qmpQemu},server=on,wait=off`)
    expect(args).toContain(`socket,path=${p.qgaQemu},`)
    expect(args).not.toContain(`unix:${p.qmp},`)
    expect(args).not.toContain(`path=${p.qga},`)
  })
})

describe("the watcher's duties in the service", () => {
  const HOLDER = resolve(import.meta.dir, "fakes", "holder.ts")
  const held: ReturnType<typeof Bun.spawn>[] = []
  const saved: { readonly name: string; readonly at: number }[] = []
  let gateSave: Promise<void> = Promise.resolve()

  const actions: Actions = {
    save: async (name) => {
      await gateSave
      saved.push({ name, at: Date.now() })
      return "saved"
    },
    deleteSaves: async () => await Promise.resolve(true),
    stow: async () => await Promise.resolve("failed" as const),
    syncClock: async () => await Promise.resolve("synced"),
    drift: async () => await Promise.resolve(0),
  }
  const watchedQuickly = { timing: { tickMs: 50 }, actions }

  beforeEach(() => {
    saved.length = 0
    gateSave = Promise.resolve()
    writeFileSync(p.meta, JSON.stringify({ image: "x", vnc: 9, created: "" }))
    writeAssignments("t", [
      parseAssignment("autosave.idleMinutes=0.005"),
      parseAssignment("stow.enabled=false"),
    ])
  })

  afterEach(() => {
    for (const h of held.splice(0)) h.kill("SIGKILL")
  })

  const markedQemu = (): unknown => {
    try {
      return (
        JSON.parse(readFileSync(watchPathsFor("t").on, "utf8")) as {
          qemu?: unknown
        }
      ).qemu
    } catch {
      return null
    }
  }

  it("leaves a QEMU nobody asked it to watch unwatched", async () => {
    svc = await runService("t", {
      exitAfterMs: 5000,
      checkMs: 50,
      watch: watchedQuickly,
    })
    await sleep(800)
    expect(saved).toEqual([])
    expect(existsSync(watchPathsFor("t").state)).toBe(false)
  })

  it("takes over from an older winvm's watcher only once that one has let its autosave finish", async () => {
    const signals = resolve(home, "legacy-signals")
    const legacy = Bun.spawn(
      [
        process.execPath,
        HOLDER,
        "winvm",
        "watch",
        "-i",
        "t",
        "--linger",
        "800",
        "--then-rm",
        p.lease,
        "--log-signals",
        signals,
      ],
      { stdout: "pipe", stderr: "ignore" },
    )
    held.push(legacy)
    const reader = (legacy.stdout as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    reader.releaseLock()
    writeFileSync(resolve(p.dir, "watch.pid"), `${String(legacy.pid)}\n`)
    writeFileSync(
      watchPathsFor("t").state,
      JSON.stringify({ pid: legacy.pid, state: "autosaving" }),
    )
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "save",
        id: "legacy-autosave",
        pid: legacy.pid,
        pidStart: null,
        startedAt: new Date().toISOString(),
        instance: "t",
        automatic: true,
      }),
    )
    svc = await runService("t", {
      exitAfterMs: 5000,
      checkMs: 50,
      watch: watchedQuickly,
    })
    await legacy.exited
    const gone = Date.now()
    expect(readFileSync(signals, "utf8")).toBe("SIGTERM\n")
    expect(existsSync(p.lease)).toBe(false)
    await until(() => saved.length === 1, 8000)
    expect(saved[0]?.at ?? 0).toBeGreaterThanOrEqual(gone)
    expect(markedQemu()).toBe(qemuPid)
    expect(
      entries().find(
        (e) => e.kind === "service" && e.what === "watcher taken over",
      ),
    ).toMatchObject({ pid: legacy.pid })
    expect(readWatchState("t")).toMatchObject({ pid: process.pid })
  }, 20_000)

  it("does not turn the watcher back on after an older one it drained, if it was turned off meanwhile", async () => {
    const legacy = Bun.spawn(
      [
        process.execPath,
        HOLDER,
        "winvm",
        "watch",
        "-i",
        "t",
        "--linger",
        "800",
      ],
      { stdout: "pipe", stderr: "ignore" },
    )
    held.push(legacy)
    const reader = (legacy.stdout as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    reader.releaseLock()
    writeFileSync(resolve(p.dir, "watch.pid"), `${String(legacy.pid)}\n`)
    writeFileSync(
      watchPathsFor("t").state,
      JSON.stringify({ pid: legacy.pid, state: "autosaving" }),
    )
    svc = await runService("t", {
      exitAfterMs: 5000,
      checkMs: 50,
      watch: watchedQuickly,
    })
    await sleep(200)
    expect(await stopWatcher("t")).toBe(true)
    await legacy.exited
    await sleep(500)
    expect(markedQemu()).toBeNull()
    expect(saved).toEqual([])
    expect(
      entries().some(
        (e) => e.kind === "service" && e.what === "watcher taken over",
      ),
    ).toBe(false)
  }, 20_000)

  it("keeps running, and says so, when the watcher's mark cannot be written", async () => {
    mkdirSync(watchPathsFor("t").on)
    svc = await runService("t", {
      exitAfterMs: 5000,
      checkMs: 50,
      watch: watchedQuickly,
    })
    expect(ensureWatcher("t")).toBe(false)
    await sleep(300)
    expect(await serviceState()).toBe("running")
    expect(saved).toEqual([])
    expect(readFileSync(watchPathsFor("t").log, "utf8")).toContain(
      "could not turn the watcher on",
    )
  }, 20_000)

  it("follows a QEMU that a load replaced under the lease, and moves its mark to it", async () => {
    writeAssignments("t", [parseAssignment("autosave.enabled=false")])
    expect(ensureWatcher("t")).toBe(true)
    svc = await runService("t", {
      exitAfterMs: 5000,
      checkMs: 50,
      watch: watchedQuickly,
    })
    await until(() => readWatchState("t")?.state === "watching")
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "load",
        id: "a-load",
        pid: process.pid,
        pidStart: null,
        startedAt: new Date().toISOString(),
        instance: "t",
        automatic: false,
      }),
    )
    await releasePidfiles()
    const next = (await lockPidfile(p.pid, "qemu-system-aarch64")).pid
    rmSync(p.lease)
    await until(() => markedQemu() === next)
    expect(readWatchState("t")?.state).toBe("watching")
    expect(readFileSync(watchPathsFor("t").log, "utf8")).toContain(
      `qemu was replaced (pid ${String(qemuPid)} -> ${String(next)}`,
    )
  }, 20_000)

  it("stops when told to, only once the work in hand is done, and says so", async () => {
    let open: () => void = () => undefined
    gateSave = new Promise<void>((r) => {
      open = r
    })
    expect(ensureWatcher("t")).toBe(true)
    svc = await runService("t", {
      exitAfterMs: 5000,
      checkMs: 50,
      watch: watchedQuickly,
    })
    await until(() => readWatchState("t")?.state === "autosaving")
    let stopped = false
    const stopping = stopWatcher("t").then((was) => {
      stopped = true
      return was
    })
    await sleep(300)
    expect(stopped).toBe(false)
    open()
    expect(await stopping).toBe(true)
    expect(saved).toHaveLength(1)
    expect(readWatchState("t")?.state).toBe("stopped")
    expect(markedQemu()).toBeNull()
    await sleep(400)
    expect(saved).toHaveLength(1)
  }, 20_000)
})

describe("turning the watcher off through a service that cannot quiesce it", () => {
  let stub: ReturnType<typeof Bun.serve> | null = null
  let asked = 0

  const answering = (respond: () => Response | Promise<Response>): void => {
    stub = Bun.serve({
      unix: p.control,
      fetch: async (req) => {
        if (req.method === "POST" && new URL(req.url).pathname === "/watch")
          asked += 1
        return await respond()
      },
    })
  }

  const marked = (): unknown => {
    try {
      return (
        JSON.parse(readFileSync(watchPathsFor("t").on, "utf8")) as {
          qemu?: unknown
        }
      ).qemu
    } catch {
      return null
    }
  }

  beforeEach(() => {
    asked = 0
    writeFileSync(p.meta, JSON.stringify({ image: "x", vnc: 9, created: "" }))
  })

  afterEach(async () => {
    await stub?.stop(true)
    stub = null
  })

  it("turns it off here when an older service answers 404 to the request", async () => {
    expect(ensureWatcher("t")).toBe(true)
    expect(marked()).toBe(qemuPid)
    answering(() => Response.json({ error: "not found" }, { status: 404 }))
    expect(await stopWatcher("t")).toBe(true)
    expect(asked).toBe(1)
    expect(marked()).toBeNull()
  })

  it("reports an error, not a stop, when the service takes the request and never answers", async () => {
    expect(ensureWatcher("t")).toBe(true)
    answering(() => new Promise<Response>(() => undefined))
    const t0 = Date.now()
    await expect(stopWatcher("t", 300)).rejects.toThrow(
      /did not say its watcher had stopped.*try again/,
    )
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(asked).toBe(1)
  })
})

describe("the service's signals", () => {
  const wire = (
    keeperPid: string | undefined,
    parent: number,
  ): { readonly fire: (s: string) => void; readonly stops: () => number } => {
    const handlers = new Map<string, () => void>()
    let stops = 0
    serviceSignals(
      "signals",
      () => {
        stops += 1
      },
      {
        keeperPid,
        parent: () => parent,
        on: (signal, handler) => {
          handlers.set(signal, handler)
        },
      },
    )
    return {
      fire: (signal) => {
        handlers.get(signal)?.()
      },
      stops: () => stops,
    }
  }

  it("stops on SIGTERM, SIGINT and SIGHUP when its parent is not winvm's keeper", () => {
    for (const keeper of [undefined, "77"]) {
      const s = wire(keeper, 1)
      s.fire("SIGTERM")
      s.fire("SIGINT")
      s.fire("SIGHUP")
      expect(s.stops()).toBe(3)
    }
  })

  it("ignores them while the keeper is its parent, and stops on SIGUSR2", () => {
    const s = wire("77", 77)
    s.fire("SIGTERM")
    s.fire("SIGINT")
    s.fire("SIGHUP")
    expect(s.stops()).toBe(0)
    s.fire("SIGUSR2")
    expect(s.stops()).toBe(1)
  })
})
