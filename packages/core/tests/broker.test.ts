/**
 * The control service's channel broker, against fake QEMU sockets: no VM.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { QmpChannel } from "../src/broker"
import * as monitor from "../src/monitor"
import * as qmp from "../src/qmp"
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
})
