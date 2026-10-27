import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { QmpChannel } from "../src/broker"
import * as monitor from "../src/monitor"
import { PACKAGE_DIR, pathsFor, type Paths } from "../src/paths"
import * as qga from "../src/qga"
import { qemuArgs } from "../src/qemu"
import * as qmp from "../src/qmp"
import { ensureService, keepService, readService, runService, stopService, type ServiceHandle } from "../src/service"
import { FakeAgent } from "./fakes/agent"
import { FakeQmp } from "./fakes/qmp"

const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

let home = ""
let savedHome: string | undefined
let p: Paths
let fake: FakeQmp
let agent: FakeAgent
let svc: ServiceHandle | null = null

beforeEach(async () => {
  savedHome = process.env["WINVM_HOME"]
  home = mkdtempSync(resolve(tmpdir(), "winvm-svc-"))
  process.env["WINVM_HOME"] = home
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
  if (savedHome === undefined) delete process.env["WINVM_HOME"]
  else process.env["WINVM_HOME"] = savedHome
  rmSync(home, { recursive: true, force: true })
})

const lastEvent = (): Record<string, unknown> => {
  const lines = readFileSync(p.events, "utf8").trim().split("\n")
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>
}

describe("the service", () => {
  it("serves the instance's sockets and records itself", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    expect(await qmp.status(p.qmp)).toBe("running")
    const info = readService(p)
    expect(info?.pid).toBe(process.pid)
    expect(statSync(p.service).mode & 0o777).toBe(0o600)
    expect(lastEvent()).toMatchObject({ instance: "t", kind: "service", what: "started" })
  })

  it("records QMP events as state events, on disk and on the stream", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    const res = await fetch("http://localhost/events", { unix: p.control })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await qmp.status(p.qmp)
    fake.emit({ event: "STOP", timestamp: { seconds: 1, microseconds: 0 } })
    let text = ""
    const dec = new TextDecoder()
    while (!text.includes('"state"')) text += dec.decode((await reader.read()).value)
    await reader.cancel()
    expect(text).toContain('"state":"paused"')
    expect(lastEvent()).toMatchObject({ kind: "state", state: "paused" })
  })

  it("keeps a quiet stream open past Bun's default idle timeout", async () => {
    svc = await runService("t", { exitAfterMs: 30_000, checkMs: 50, heartbeatMs: 60_000 })
    const res = await fetch("http://localhost/events", { unix: p.control })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await sleep(14_000)
    await qmp.status(p.qmp)
    fake.emit({ event: "STOP", timestamp: { seconds: 1, microseconds: 0 } })
    let text = ""
    const dec = new TextDecoder()
    while (!text.includes('"state"')) {
      const r = await reader.read()
      if (r.done) break
      text += dec.decode(r.value)
    }
    await reader.cancel().catch(() => undefined)
    expect(text).toContain('"state":"paused"')
  }, 25_000)

  it("drops a subscriber that went away", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50, heartbeatMs: 50 })
    const ac = new AbortController()
    const res = await fetch("http://localhost/events", { unix: p.control, signal: ac.signal })
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
    expect(((await res.json()) as { qemuPid: number }).qemuPid).toBe(process.pid)
    expect(readService(p)).not.toHaveProperty("port")
    expect(readService(p)).not.toHaveProperty("token")
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

  it("waits out a load: QEMU gone but the save lock held by a live pid", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    const lockDir = resolve(home, "saves", "t")
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(resolve(lockDir, ".lock"), String(process.pid))
    rmSync(p.pid)
    await sleep(600)
    expect(readService(p)?.pid).toBe(process.pid)
    expect(existsSync(p.qmp)).toBe(true)
  })
})

describe("one service per instance", () => {
  it("refuses to start while another service holds the instance, and leaves it working", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await expect(runService("t", { exitAfterMs: 5000, checkMs: 50 })).rejects.toThrow(`holds instance "t"`)
    expect(readService(p)?.pid).toBe(process.pid)
    expect(await qmp.status(p.qmp)).toBe("running")
    expect((await fetch("http://localhost/status", { unix: p.control })).status).toBe(200)
  })

  it("takes over the record of a service that has gone", async () => {
    const gone = Bun.spawn(["true"])
    await gone.exited
    writeFileSync(p.service, JSON.stringify({ pid: gone.pid, cli: "", version: "", startedAt: "" }))
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(readService(p)?.pid).toBe(process.pid)
  })

  it("stops when its record names another service, and leaves that service's sockets", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    const newer = new QmpChannel({ listen: p.qmp, upstream: resolve(home, "nowhere.sock") })
    await newer.start()
    writeFileSync(p.service, JSON.stringify({ pid: 1, cli: "", version: "", startedAt: "" }))
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
    expect(readService(p)?.pid).toBe(process.pid)
    await svc.done
    svc = null
  })

  it("does not take a live process that is not this instance's service for one", () => {
    const other = Bun.spawn(["sleep", "30"])
    writeFileSync(p.service, JSON.stringify({ pid: other.pid, cli: "", version: "", startedAt: "" }))
    expect(readService(p)).toBeNull()
    other.kill()
  })

  it("asks for the guest's port without waiting behind a QMP caller", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    const held = monitor.withQmp(p.qmp, async () => await sleep(1500), 3000)
    await sleep(100)
    const t0 = Date.now()
    expect(await qga.call(p.qga, { execute: "guest-ping" }, 1000)).toEqual({ return: {} })
    expect(Date.now() - t0).toBeLessThan(800)
    await held
  })

  it("never connects to the agent after the guest closed its port, though QEMU sends no event for it", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(await qga.call(p.qga, { execute: "guest-ping" }, 1000)).toEqual({ return: {} })
    const before = agent.connections
    const open = fake.handler
    fake.handler = (cmd) =>
      cmd["execute"] === "query-chardev" ? { return: [{ label: "qga0", "frontend-open": false }] } : open(cmd)
    await expect(qga.call(p.qga, { execute: "guest-ping" }, 500)).rejects.toThrow("timed out")
    expect(agent.connections).toBe(before)
  })
})

describe("starting the service", () => {
  const cli = resolve(PACKAGE_DIR, "..", "..", "apps", "cli", "src", "winvm.ts")
  let savedCli: string | undefined

  beforeEach(() => {
    savedCli = process.env["WINVM_CLI"]
    process.env["WINVM_CLI"] = cli
  })

  afterEach(() => {
    stopService(p)
    if (savedCli === undefined) delete process.env["WINVM_CLI"]
    else process.env["WINVM_CLI"] = savedCli
  })

  it("starts the service once, detached, and reuses it", async () => {
    const first = await ensureService("t", p)
    expect(first.pid).not.toBe(process.pid)
    expect(first.cli).toBe(cli)
    expect(existsSync(p.qmp) && existsSync(p.qga)).toBe(true)
    expect(await qmp.status(p.qmp)).toBe("running")
    expect((await fetch("http://localhost/status", { unix: p.control })).status).toBe(200)
    const again = await ensureService("t", p)
    expect(again.pid).toBe(first.pid)
  }, 30_000)

  it("stops it, and waits until it has gone", async () => {
    const info = await ensureService("t", p)
    stopService(p)
    expect(readService(p)).toBeNull()
    expect(spawnSync("ps", ["-o", "stat=", "-p", String(info.pid)], { encoding: "utf8" }).stdout.trim()).toMatch(/^(Z.*)?$/)
  }, 30_000)
})

describe("QEMU's command line", () => {
  it("hands QEMU the private sockets", () => {
    const args = qemuArgs("t", p, { image: "win11-arm64", vnc: 9, created: "" }, {
      installMedia: false,
      ephemeral: true,
      virtioBoot: false,
    }).join(" ")
    expect(args).toContain(`unix:${p.qmpQemu},server=on,wait=off`)
    expect(args).toContain(`socket,path=${p.qgaQemu},`)
    expect(args).not.toContain(`unix:${p.qmp},`)
    expect(args).not.toContain(`path=${p.qga},`)
  })
})
