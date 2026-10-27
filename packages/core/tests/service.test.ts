import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { PACKAGE_DIR, pathsFor, type Paths } from "../src/paths"
import { qemuArgs } from "../src/qemu"
import * as qmp from "../src/qmp"
import { ensureService, readService, runService, stopService, type ServiceHandle } from "../src/service"
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
  process.env["WINVM_SERVICE_TOKEN"] = "test-token"
})

afterEach(async () => {
  await svc?.stop()
  svc = null
  await fake.close().catch(() => undefined)
  await agent.close().catch(() => undefined)
  delete process.env["WINVM_SERVICE_TOKEN"]
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
    expect(info?.token).toBe("test-token")
    expect(statSync(p.service).mode & 0o777).toBe(0o600)
    expect(lastEvent()).toMatchObject({ instance: "t", kind: "service", what: "started" })
  })

  it("records QMP events as state events, on disk and on the stream", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    const info = readService(p)
    const res = await fetch(`http://127.0.0.1:${String(info?.port)}/events?key=test-token`)
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

  it("drops a subscriber that went away", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50, heartbeatMs: 50 })
    const info = readService(p)
    const ac = new AbortController()
    const res = await fetch(`http://127.0.0.1:${String(info?.port)}/events?key=test-token`, { signal: ac.signal })
    await (res.body as ReadableStream<Uint8Array>).getReader().read()
    expect(svc.subscribers()).toBe(1)
    ac.abort()
    await sleep(300)
    expect(svc.subscribers()).toBe(0)
  })

  it("refuses the stream and status without the token", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    const port = String(readService(p)?.port)
    expect((await fetch(`http://127.0.0.1:${port}/events`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(401)
    const ok = await fetch(`http://127.0.0.1:${port}/status`, { headers: { "x-winvm-token": "test-token" } })
    expect(((await ok.json()) as { qemuPid: number }).qemuPid).toBe(process.pid)
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

describe("starting the service", () => {
  const cli = resolve(PACKAGE_DIR, "..", "..", "apps", "cli", "src", "winvm.ts")
  let savedCli: string | undefined

  beforeEach(() => {
    savedCli = process.env["WINVM_CLI"]
    process.env["WINVM_CLI"] = cli
    delete process.env["WINVM_SERVICE_TOKEN"]
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
