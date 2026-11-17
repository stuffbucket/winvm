import { describe, expect, it } from "bun:test"

import { signalOf } from "../ui/src/features/winvm/stream"

const entry = (e: Record<string, unknown>, instance = "demo"): unknown => ({
  type: "entry",
  instance,
  entry: { t: "2026-11-16T10:00:00.000Z", instance, ...e },
  cursor: "c",
})

describe("what a line of the event stream means for the view", () => {
  it("re-reads everything when the stream connects or the instances change", () => {
    expect(signalOf({ type: "hello", instances: [], cursor: "c" })).toEqual({
      kind: "connected",
    })
    expect(signalOf({ type: "instances", instances: ["a"] })).toEqual({
      kind: "instances",
    })
    expect(signalOf({ type: "down", code: 1 })).toEqual({ kind: "down" })
  })

  it("re-reads an instance whose run state, operation or connection changed, or whose record has a gap", () => {
    for (const e of [
      { kind: "op", phase: "begin", operation: "stow" },
      { kind: "op", phase: "end", operation: "stow", ok: true },
      { kind: "sync", status: "running", running: true },
      { kind: "disconnected", reason: "qemu-closed" },
      { kind: "qmp", event: "STOP", data: null },
      { kind: "qmp", event: "RESUME", data: null },
      { kind: "qmp", event: "SHUTDOWN", data: { guest: true } },
      { kind: "qmp", event: "RESET", data: { guest: true } },
      { kind: "qmp", event: "SUSPEND", data: null },
      { kind: "qmp", event: "WAKEUP", data: null },
      { kind: "qmp", event: "GUEST_PANICKED", data: null },
      { kind: "qmp", event: "VSERPORT_CHANGE", data: { open: true } },
    ])
      expect(signalOf(entry(e))).toEqual({ kind: "changed", instance: "demo" })
    expect(signalOf({ type: "gap", instance: "demo", cursor: "c" })).toEqual({
      kind: "changed",
      instance: "demo",
    })
  })

  it("ignores what does not change the view, and anything it cannot read", () => {
    for (const e of [
      { kind: "qmp", event: "RTC_CHANGE", data: { offset: 1 } },
      { kind: "qmp", event: "POWERDOWN", data: null },
      { kind: "qmp", event: "MIGRATION", data: { status: "active" } },
      { kind: "service", what: "started" },
      { kind: "warning", what: "share notices" },
      {
        kind: "op",
        phase: "output",
        id: "op-1",
        operation: "reboot",
        stream: "out",
        text: "rebooting",
      },
    ])
      expect(signalOf(entry(e))).toBeNull()
    for (const junk of [
      null,
      "hello",
      7,
      {},
      { type: "entry" },
      { type: "gap" },
    ])
      expect(signalOf(junk)).toBeNull()
    expect(signalOf({ type: "end", cursor: "c" })).toBeNull()
  })
})
