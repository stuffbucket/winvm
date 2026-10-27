import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { QgaChannel, QmpChannel } from "../src/broker"
import * as monitor from "../src/monitor"
import * as qga from "../src/qga"
import * as qmp from "../src/qmp"
import { FakeAgent } from "./fakes/agent"
import { FakeQmp } from "./fakes/qmp"

const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

let dir = ""
let fake: FakeQmp
let channel: QmpChannel
let listen = ""
const events: Record<string, unknown>[] = []

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "winvm-broker-"))
  listen = resolve(dir, "qmp.sock")
  fake = new FakeQmp(resolve(dir, "up.sock"))
  await fake.listen()
  events.length = 0
  channel = new QmpChannel({ listen, upstream: fake.path, onEvent: (e) => events.push(e) })
  await channel.start()
})

afterEach(async () => {
  await channel.stop()
  await fake.close().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe("the QMP channel", () => {
  it("hands clients the greeting and answers qmp_capabilities itself", async () => {
    expect(await monitor.qmpCommand(listen, "query-status")).toEqual({ status: "running", running: true })
    expect(await qmp.status(listen)).toBe("running")
    expect(fake.connections).toBe(1)
    expect(fake.commands.filter((c) => c === "qmp_capabilities")).toHaveLength(1)
  })

  it("admits one client at a time, in order", async () => {
    fake.handler = async (cmd) => {
      if (cmd["execute"] === "slow") await sleep(300)
      return cmd["execute"] === "query-status" ? { return: { status: "running" } } : { return: {} }
    }
    const done: string[] = []
    const a = qmp.execute(listen, "slow").then(() => done.push("a"))
    await sleep(50)
    const b = qmp.status(listen).then(() => done.push("b"))
    await Promise.all([a, b])
    expect(done).toEqual(["a", "b"])
    expect(fake.commands).toEqual(["qmp_capabilities", "slow", "query-status"])
  })

  it("does not hand a late reply to the next client", async () => {
    fake.handler = async (cmd) => {
      if (cmd["execute"] === "late") {
        await sleep(300)
        return { return: "the late reply" }
      }
      return { return: { status: "running" } }
    }
    await expect(monitor.qmpCommand(listen, "late", undefined, 100)).rejects.toThrow("no answer")
    expect(await qmp.status(listen)).toBe("running")
  })

  it("forwards events to the active client and to onEvent", async () => {
    const r = await monitor.withQmp(listen, async (send) => {
      fake.emit({ event: "STOP", timestamp: { seconds: 1, microseconds: 0 } })
      await sleep(50)
      return await send("query-status")
    })
    expect(r).toEqual({ status: "running", running: true })
    expect(events.map((e) => e["event"])).toEqual(["STOP"])
  })

  it("keeps clients waiting while QEMU is away, and serves them when it is back", async () => {
    await fake.close()
    await sleep(100)
    expect(channel.connected).toBe(false)
    const pending = qmp.status(listen)
    await sleep(300)
    fake = new FakeQmp(resolve(dir, "up.sock"))
    await fake.listen()
    expect(await pending).toBe("running")
    expect(channel.connected).toBe(true)
  })

  it("asks QEMU itself, ahead of a caller holding the queue", async () => {
    const held = monitor.withQmp(listen, async () => await sleep(1000), 3000)
    await sleep(100)
    const t0 = Date.now()
    expect(await channel.request("query-chardev")).toEqual({ return: [{ label: "qga0", "frontend-open": true }] })
    expect(Date.now() - t0).toBeLessThan(500)
    await held
  })

  it("leaves a newer listener's socket in place when it stops", async () => {
    const newer = new QmpChannel({ listen, upstream: resolve(dir, "nowhere.sock") })
    await newer.start()
    await channel.stop()
    expect(existsSync(listen)).toBe(true)
    await newer.stop()
    channel = new QmpChannel({ listen, upstream: fake.path })
  })
})

describe("the QMP channel's own timeouts", () => {
  let other: QmpChannel | null = null

  afterEach(async () => {
    await other?.stop()
    other = null
  })

  it("drops a QEMU connection that never greets, and tries again", async () => {
    await channel.stop()
    await fake.close()
    fake = new FakeQmp(resolve(dir, "up.sock"))
    fake.greets = false
    await fake.listen()
    other = new QmpChannel({ listen: resolve(dir, "other.sock"), upstream: fake.path, negotiateTimeoutMs: 200 })
    await other.start()
    await sleep(700)
    expect(fake.connections).toBeGreaterThanOrEqual(2)
  })

  it("renegotiates rather than hand a reply owed past the drain timeout to the next caller", async () => {
    await channel.stop()
    fake.handler = async (cmd) => {
      if (cmd["execute"] === "savevm") {
        await sleep(600)
        return { return: "savevm finished late" }
      }
      return { return: { status: "running" } }
    }
    const otherListen = resolve(dir, "other.sock")
    other = new QmpChannel({ listen: otherListen, upstream: fake.path, drainTimeoutMs: 200 })
    await other.start()
    while (!other.connected) await sleep(20)
    await expect(monitor.qmpCommand(otherListen, "savevm", undefined, 100)).rejects.toThrow("no answer")
    expect(await qmp.status(otherListen)).toBe("running")
  })
})

describe("the qemu-ga channel", () => {
  let agent: FakeAgent
  let qgaChannel: QgaChannel
  let qgaListen = ""
  let open = true

  beforeEach(async () => {
    agent = new FakeAgent(resolve(dir, "qga-up.sock"))
    await agent.listen()
    qgaListen = resolve(dir, "qga.sock")
    open = true
    qgaChannel = new QgaChannel({ listen: qgaListen, upstream: agent.path, portOpen: async () => open })
    await qgaChannel.start()
  })

  afterEach(async () => {
    await qgaChannel.stop()
    await agent.close()
  })

  it("never connects to the agent before the guest opens its port", async () => {
    open = false
    agent.handler = () => ({ return: {} })
    const done = qga.call(qgaListen, { execute: "guest-ping" }, 5000)
    await sleep(500)
    expect(agent.connections).toBe(0)
    open = true
    expect(await done).toEqual({ return: {} })
    expect(agent.connections).toBe(1)
  })

  it("serves qga callers one at a time, each with its own sync", async () => {
    agent.handler = (req) => ({ return: `reply to ${String(req["execute"])}` })
    const [a, b] = await Promise.all([
      qga.call(qgaListen, { execute: "guest-info" }),
      qga.call(qgaListen, { execute: "guest-get-time" }),
    ])
    expect(a).toEqual({ return: "reply to guest-info" })
    expect(b).toEqual({ return: "reply to guest-get-time" })
    expect(agent.connections).toBe(2)
  })

  it("lets other callers in between the polls of a long exec", async () => {
    const t0 = Date.now()
    agent.handler = (req) => {
      if (req["execute"] === "guest-exec") return { return: { pid: 42 } }
      if (req["execute"] === "guest-exec-status") return { return: { exited: Date.now() - t0 > 1000, exitcode: 0 } }
      return { return: "pong" }
    }
    const order: string[] = []
    const exec = qga.exec(qgaListen, "cmd.exe", ["/c", "ver"], 10_000).then(() => order.push("exec"))
    await sleep(200)
    const ping = qga.call(qgaListen, { execute: "guest-ping" }).then(() => order.push("ping"))
    await Promise.all([exec, ping])
    expect(order).toEqual(["ping", "exec"])
  })

  it("closes a caller at once when the agent refuses the connection", async () => {
    await agent.close()
    const t0 = Date.now()
    const sock = connect(qgaListen)
    sock.on("error", () => undefined)
    sock.write(Buffer.from([0xff]))
    await new Promise<void>((r) => sock.on("close", () => r()))
    expect(Date.now() - t0).toBeLessThan(1500)
    agent = new FakeAgent(resolve(dir, "qga-up.sock"))
    await agent.listen()
  })
})
