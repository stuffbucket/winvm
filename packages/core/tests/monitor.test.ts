import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { QmpError, QmpNotDelivered, qmpCommand } from "../src/monitor"
import { type OpScope, runInOp } from "../src/opcontext"
import * as qmp from "../src/qmp"
import { FakeQmp } from "./fakes/qmp"

let dir: string
let fake: FakeQmp

beforeAll(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "winvm-monitor-"))
  fake = new FakeQmp(resolve(dir, "qmp.sock"))
  await fake.listen()
})

afterAll(async () => {
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  fake.greets = true
  fake.negotiateDelayMs = 0
  fake.handler = () => ({ return: {} })
  fake.commands.length = 0
})

const failure = async (p: Promise<unknown>): Promise<unknown> =>
  await p.then(
    () => null,
    (e: unknown) => e,
  )

describe("qmpCommand tells a request QEMU never acted on from one it may have", () => {
  it("returns QEMU's answer", async () => {
    fake.handler = () => ({ return: { ok: 1 } })
    expect(await qmpCommand(fake.path, "system_powerdown")).toEqual({ ok: 1 })
  })

  it("an error reply from QEMU means nothing happened", async () => {
    fake.handler = () => ({
      error: { class: "GenericError", desc: "not now" },
    })
    const e = await failure(qmpCommand(fake.path, "system_powerdown"))
    expect(e).toBeInstanceOf(QmpNotDelivered)
    expect((e as Error).message).toContain("not now")
  })

  it("no monitor to connect to means nothing was sent", async () => {
    const e = await failure(
      qmpCommand(
        resolve(dir, "missing.sock"),
        "system_powerdown",
        undefined,
        200,
      ),
    )
    expect(e).toBeInstanceOf(QmpNotDelivered)
  })

  it("a monitor that never greets means nothing was sent", async () => {
    fake.greets = false
    const e = await failure(
      qmpCommand(fake.path, "system_powerdown", undefined, 200),
    )
    expect(e).toBeInstanceOf(QmpNotDelivered)
    expect(fake.commands).not.toContain("system_powerdown")
  })

  it("no answer after the request was written is not a refusal: QEMU may have acted on it", async () => {
    fake.handler = (cmd) =>
      cmd.execute === "system_powerdown" ? null : { return: {} }
    const e = await failure(
      qmpCommand(fake.path, "system_powerdown", undefined, 200),
    )
    expect(e).toBeInstanceOf(QmpError)
    expect(e).not.toBeInstanceOf(QmpNotDelivered)
  })
})

describe("an op that ends while its QMP client negotiates", () => {
  const scopeFor = (signal: AbortSignal): OpScope => ({
    id: "op-1",
    operation: "resume",
    signal,
    write: () => undefined,
    remount: () => undefined,
    irreversibleAt: null,
    calls: 0,
  })

  const slowGreeting = (): void => {
    fake.negotiateDelayMs = 200
  }

  for (const [label, send] of [
    [
      "qmpCommand",
      async (): Promise<unknown> => await qmpCommand(fake.path, "cont"),
    ],
    [
      "qmp.execute",
      async (): Promise<unknown> => await qmp.execute(fake.path, "cont"),
    ],
  ] as const)
    it(`never writes the command (${label})`, async () => {
      slowGreeting()
      const ac = new AbortController()
      const asked = runInOp(scopeFor(ac.signal), send)
      setTimeout(() => {
        ac.abort("host-end")
      }, 50)
      await expect(asked).rejects.toThrow("the Mac is shutting down")
      await Bun.sleep(300)
      expect(fake.commands).not.toContain("cont")
    })
})
