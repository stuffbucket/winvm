/**
 * Input sent through QMP must never be left held: a session that ends early
 * lets go of what it pressed (input.ts HeldInput / withInput).
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { HeldInput, absEv, btnEv, keyEv, send, withInput } from "../src/input"
import { FakeQmp } from "./fakes/qmp"

describe("HeldInput", () => {
  it("holds what went down and forgets what came up", () => {
    const h = new HeldInput()
    h.track([keyEv("ctrl", true), keyEv("alt", true), btnEv("left", true), absEv("x", 5)])
    h.track([keyEv("alt", false)])
    expect(h.releases()).toEqual([btnEv("left", false), keyEv("ctrl", false)])
  })

  it("is empty when everything was released", () => {
    const h = new HeldInput()
    h.track([keyEv("a", true)])
    h.track([keyEv("a", false)])
    expect(h.releases()).toEqual([])
  })
})

describe("withInput", () => {
  let dir = ""
  let qmp: FakeQmp
  const sent: unknown[][] = []

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "winvm-input-"))
    qmp = new FakeQmp(resolve(dir, "q.sock"))
    sent.length = 0
    qmp.handler = (cmd) => {
      if (cmd["execute"] === "input-send-event") sent.push((cmd["arguments"] as { events: unknown[] }).events)
      return { return: {} }
    }
    await qmp.listen()
  })

  afterEach(async () => {
    await qmp.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("lets go of a held key and button when a later step fails", async () => {
    await expect(
      withInput(qmp.path, async (q) => {
        await send(q, [keyEv("ctrl", true)])
        await send(q, [btnEv("left", true)])
        throw new Error("the step after the press failed")
      }),
    ).rejects.toThrow("the step after the press failed")
    // Last pressed first.
    expect(sent.at(-1)).toEqual([btnEv("left", false), keyEv("ctrl", false)])
  })

  it("sends nothing extra when the session released its own", async () => {
    await withInput(qmp.path, async (q) => {
      await send(q, [keyEv("a", true)])
      await send(q, [keyEv("a", false)])
    })
    expect(sent).toEqual([[keyEv("a", true)], [keyEv("a", false)]])
  })

  it("retries a release that did not get through", async () => {
    let failNext = false
    qmp.handler = (cmd) => {
      if (cmd["execute"] !== "input-send-event") return { return: {} }
      const events = (cmd["arguments"] as { events: unknown[] }).events
      sent.push(events)
      if (failNext) {
        failNext = false
        return { error: { class: "GenericError", desc: "nope" } }
      }
      return { return: {} }
    }
    await expect(
      withInput(qmp.path, async (q) => {
        await send(q, [keyEv("shift", true)])
        failNext = true
        await send(q, [keyEv("shift", false)])
      }),
    ).rejects.toThrow()
    expect(sent.at(-1)).toEqual([keyEv("shift", false)])
    expect(sent).toHaveLength(3)
  })
})
