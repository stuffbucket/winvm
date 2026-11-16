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
import { processStart } from "../src/proc"
import { qemuArgs } from "../src/qemu"
import * as qga from "../src/qga"
import * as qmp from "../src/qmp"
import { runService, type ServiceHandle } from "../src/service"
import {
  dropServiceRecord,
  ensureService,
  keepService,
  readService,
  type ServiceInfo,
  serviceFreshness,
  stopService,
} from "../src/servicectl"
import { FakeAgent } from "./fakes/agent"
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

beforeEach(async () => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync(resolve(tmpdir(), "winvm-svc-"))
  process.env.WINVM_HOME = home
  p = pathsFor("t")
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.pid, `${String(process.pid)}\n`)
  fake = new FakeQmp(p.qmpQemu)
  await fake.listen()
  agent = new FakeAgent(p.qgaQemu)
  await agent.listen()
})

afterEach(async () => {
  await svc?.stop()
  svc = null
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

  it("reads QEMU's run state as soon as it connects, before any event", async () => {
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
    expect(((await res.json()) as { qemuPid: number }).qemuPid).toBe(
      process.pid,
    )
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

  it("does not take a live process that is not this instance's service for one", () => {
    const other = Bun.spawn(["sleep", "30"])
    writeFileSync(
      p.service,
      JSON.stringify({ pid: other.pid, cli: "", version: "", startedAt: "" }),
    )
    expect(readService(p)).toBeNull()
    other.kill()
  })

  it("never takes this very process for a service, so a stale record naming it cannot make it signal itself", () => {
    writeFileSync(
      p.service,
      JSON.stringify({ pid: process.pid, cli: "", version: "", startedAt: "" }),
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

  for (const [label, argv] of [
    [
      "an instance whose name starts with this one's",
      ["winvm", "serve", "-i", "tt"],
    ],
    [
      "another instance named with --instance=",
      ["winvm", "serve", "--instance=other"],
    ],
  ] as const) {
    it(`never takes the service of ${label} for this one's, nor signals it`, () => {
      const h = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "fakes", "holder.ts"),
          ...argv,
        ],
        { stdout: "ignore", stderr: "ignore" },
      )
      try {
        writeFileSync(
          p.service,
          JSON.stringify({ pid: h.pid, cli: "", version: "", startedAt: "" }),
        )
        expect(readService(p)).toBeNull()
        const kills: string[] = []
        stopService(p, { kill: (_pid, sig) => void kills.push(sig) })
        expect(kills).toEqual([])
      } finally {
        h.kill()
      }
    })
  }
})

describe("which process is the default instance's service", () => {
  const holder = resolve(import.meta.dir, "fakes", "holder.ts")
  const d = (): Paths => {
    const dp = pathsFor("default")
    mkdirSync(dp.dir, { recursive: true })
    return dp
  }

  for (const argv of [
    ["ollama", "serve"],
    ["hugo", "serve"],
    ["node", "server.js", "serve"],
    ["winvm", "serve"],
    ["evilwinvm", "serve", "-i", "default"],
    ["ollama", "serve", "-i", "default"],
  ]) {
    it(`is never \`${argv.join(" ")}\``, () => {
      const dp = d()
      const h = Bun.spawn([process.execPath, holder, ...argv], {
        stdout: "ignore",
        stderr: "ignore",
      })
      try {
        writeFileSync(
          dp.service,
          JSON.stringify({ pid: h.pid, cli: "", version: "", startedAt: "" }),
        )
        expect(readService(dp)).toBeNull()
        const kills: string[] = []
        stopService(dp, { kill: (_pid, sig) => void kills.push(sig) })
        expect(kills).toEqual([])
      } finally {
        h.kill()
      }
    })
  }

  for (const argv of [
    ["/repo/apps/cli/src/winvm.ts", "serve", "-i", "default"],
    [
      "/Applications/winvm.app/Contents/MacOS/winvm",
      "serve",
      "--instance=default",
    ],
    [
      "/Applications/winvm.app/Contents/MacOS/winvm-aarch64-apple-darwin",
      "serve",
      "-i",
      "default",
    ],
  ]) {
    it(`is \`${argv.join(" ")}\``, () => {
      const dp = d()
      const h = Bun.spawn([process.execPath, holder, ...argv], {
        stdout: "ignore",
        stderr: "ignore",
      })
      try {
        writeFileSync(
          dp.service,
          JSON.stringify({ pid: h.pid, cli: "", version: "", startedAt: "" }),
        )
        expect(readService(dp)?.pid).toBe(h.pid)
      } finally {
        h.kill()
      }
    })
  }
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
      startedAt: "",
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

  it("never signals a pid that is not this instance's service, and drops the record", async () => {
    const stranger = Bun.spawn(["sleep", "20"])
    spawned.push(stranger)
    record(stranger.pid, "sha256:old")
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

  it("kills a service that is still running 5 s after SIGTERM", () => {
    const r = run({ isService: () => true })
    expect(r.kills).toEqual(["SIGTERM", "SIGKILL"])
    expect(r.elapsed).toBeGreaterThanOrEqual(5000)
    expect(existsSync(p.service)).toBe(false)
  })

  it("re-checks the pid is still this instance's service just before SIGKILL", () => {
    const r = run({ isService: (t) => t < 5000 })
    expect(r.kills).toEqual(["SIGTERM"])
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
