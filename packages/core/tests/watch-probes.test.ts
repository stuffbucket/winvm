import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { resolve } from "node:path"

import { QmpChannel } from "../src/broker"
import { withQmp } from "../src/monitor"
import { probeMonitor } from "../src/watch"
import { FakeQmp } from "./fakes/qmp"

let dir: string
let fake: FakeQmp
let channel: QmpChannel
let listen: string

beforeEach(async () => {
  dir = mkdtempSync("/tmp/wvwp-")
  fake = new FakeQmp(resolve(dir, "up.sock"))
  await fake.listen()
  listen = resolve(dir, "qmp.sock")
  channel = new QmpChannel({ listen, upstream: fake.path })
  await channel.start()
})

afterEach(async () => {
  await channel.stop()
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("watcher monitor sampling", () => {
  it("keeps frozen state and connected viewers in the sample", async () => {
    for (const state of ["running", "paused", "suspended", "postmigrate"]) {
      fake.handler = (cmd) => cmd["execute"] === "query-status"
        ? { return: { status: state } }
        : { return: { clients: [{}, {}] } }
      const sample = await probeMonitor(listen)
      expect(sample.frozen).toBe(state !== "running")
      expect(sample.clients).toBe(2)
      expect(sample.ms).not.toBeNull()
    }
  })

  it("keeps probe failures independent: an unknown viewer count is not no viewers", async () => {
    fake.handler = (cmd) => cmd["execute"] === "query-status"
      ? { return: { status: "paused" } }
      : { error: { class: "GenericError", desc: "VNC unavailable" } }
    expect(await probeMonitor(listen)).toMatchObject({ frozen: true, clients: null })

    fake.handler = (cmd) => cmd["execute"] === "query-status"
      ? { error: { class: "GenericError", desc: "status unavailable" } }
      : { return: { clients: [] } }
    expect(await probeMonitor(listen)).toEqual({ frozen: null, ms: null, clients: 0 })
  })

  it("treats missing fields as unknown, but disabled VNC as no viewers", async () => {
    fake.handler = () => ({ return: {} })
    expect(await probeMonitor(listen)).toMatchObject({ frozen: null, clients: null })
    fake.handler = (cmd) => cmd["execute"] === "query-status"
      ? { return: { status: "running" } }
      : { return: { enabled: false } }
    expect(await probeMonitor(listen)).toMatchObject({ frozen: false, clients: 0 })
  })

  it("times out behind a held broker client, drops the queued probes, and recovers", async () => {
    let admitted!: () => void
    const ready = new Promise<void>((r) => { admitted = r })
    let release!: () => void
    const released = new Promise<void>((r) => { release = r })
    const held = withQmp(listen, async () => {
      admitted()
      await released
    })
    await ready
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        probeMonitor(listen, 80),
        new Promise<null>((r) => { timer = setTimeout(() => r(null), 1500) }),
      ])
      expect(result).toEqual({ frozen: null, ms: null, clients: null })
      // Neither timed-out caller was admitted or sent a command to QEMU.
      expect(fake.commands).toEqual(["qmp_capabilities"])
    } finally {
      clearTimeout(timer)
      release()
      await held
    }
    fake.handler = (cmd) => cmd["execute"] === "query-status"
      ? { return: { status: "running" } }
      : { return: { clients: [{}] } }
    expect(await probeMonitor(listen)).toMatchObject({ frozen: false, clients: 1 })
    expect(fake.commands).toEqual(["qmp_capabilities", "query-status", "query-vnc"])
    expect(fake.connections).toBe(1)
  })

  it("does not run the boot-time connect retry loop for a missing socket", async () => {
    expect(await probeMonitor(resolve(dir, "missing.sock"), 80)).toEqual({ frozen: null, ms: null, clients: null })
    expect(fake.commands.filter((c) => c !== "qmp_capabilities")).toEqual([])
  })
})
