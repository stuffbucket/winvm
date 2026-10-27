import { describe, expect, it } from "bun:test"

import { controls, detailRows, displaySize, facts, parseChecks, parseConnection, parseStatus, phase, startSteps } from "../ui/src/model"

const base = {
  name: "default",
  state: "running",
  vmStatus: "running",
  image: "win11",
  snapshotsCapable: true,
  pid: 4242,
  uptimeSeconds: 3725,
  cpus: 4,
  memoryMiB: 8192,
  display: 1,
  screen: "virtio-gpu 1280x800",
  vncPort: 5901,
  websocketPort: 5701,
  overlayBytes: 3 * 1024 ** 3,
  guest: { agent: "ok", agentVersion: "9.2.0", os: "Windows 11 Pro 24H2", clockOffsetMs: 12 },
  saves: { count: 2, bytes: 5 * 1024 ** 3, latest: null, latestBaseline: null },
  watcher: null,
  service: { pid: 4243 },
  serviceExpected: true,
  notes: [],
  timeMachine: "ok    Time Machine: off",
}

const one = (over: Record<string, unknown> = {}) => {
  const s = parseStatus(JSON.stringify({ ...base, ...over }))?.[0]
  if (s === undefined) throw new Error("status did not parse")
  return s
}

describe("parseStatus", () => {
  it("reads one instance", () => {
    expect(parseStatus(JSON.stringify(base))?.map((s) => s.name)).toEqual(["default"])
  })

  it("reads the list printed for several instances", () => {
    const got = parseStatus(JSON.stringify({ instances: [base, { ...base, name: "ci" }], timeMachine: "" }))
    expect(got?.map((s) => s.name)).toEqual(["default", "ci"])
  })

  it("is null for output that is not status", () => {
    expect(parseStatus("error: something")).toBeNull()
    expect(parseStatus(JSON.stringify({ name: "x" }))).toBeNull()
  })
})

describe("phase", () => {
  it("is starting while the agent has not answered", () => {
    expect(phase(one({ guest: { ...base.guest, agent: "silent" } }))).toBe("starting")
  })

  it("is running once the agent answers", () => {
    expect(phase(one())).toBe("running")
  })

  it("follows the state otherwise", () => {
    expect(phase(one({ state: "stopped", guest: null, pid: null }))).toBe("stopped")
  })
})

describe("controls", () => {
  it("offers start only when stopped", () => {
    expect(controls("stopped", false)).toEqual({ start: true, shutDown: false, restart: false, pause: false, resume: false, screen: false })
  })

  it("offers shut down, restart, pause and the screen when running", () => {
    expect(controls("running", false)).toEqual({ start: false, shutDown: true, restart: true, pause: true, resume: false, screen: true })
  })

  it("offers resume instead of pause when paused", () => {
    const c = controls("paused", false)
    expect([c.pause, c.resume, c.restart]).toEqual([false, true, false])
  })

  it("offers start for a missing instance, which creates it", () => {
    expect(controls("missing", false).start).toBe(true)
  })

  it("offers nothing that changes state while a command runs", () => {
    const c = controls("running", true)
    expect([c.start, c.shutDown, c.restart, c.pause, c.resume, c.screen]).toEqual([false, false, false, false, false, true])
  })
})

describe("detailRows", () => {
  it("describes a running guest in words", () => {
    expect(detailRows(one())).toEqual([
      { key: "detail.windows", value: "Windows 11 Pro 24H2" },
      { key: "detail.uptime", value: "1 h 2 min" },
      { key: "detail.hardware", value: "4 vCPU · 8 GiB" },
      { key: "detail.image", value: "win11" },
      { key: "detail.screen", value: "1280 × 800 (virtio-gpu)" },
      { key: "detail.disk", value: "3.0 GiB" },
      { key: "detail.saves", value: "2 · 5.0 GiB" },
    ])
  })

  it("leaves out what a stopped guest cannot say", () => {
    const rows = detailRows(one({ state: "stopped", guest: null, pid: null, uptimeSeconds: null }))
    expect(rows.map((r) => r.key)).toEqual(["detail.hardware", "detail.image", "detail.screen", "detail.disk", "detail.saves"])
  })
})

describe("startSteps", () => {
  const states = (steps: ReturnType<typeof startSteps>): string[] => steps.map((s) => `${s.key}:${s.state}`)

  it("prepares the disk first for an instance that does not exist yet", () => {
    expect(states(startSteps(true, one({ state: "missing", guest: null, pid: null })))).toEqual([
      "step.disk:current",
      "step.machine:todo",
      "step.windows:todo",
    ])
  })

  it("skips the disk for an instance that exists", () => {
    expect(states(startSteps(false, one({ state: "stopped", guest: null, pid: null })))).toEqual([
      "step.machine:current",
      "step.windows:todo",
    ])
  })

  it("is starting Windows once the machine runs and the agent has not answered", () => {
    expect(states(startSteps(true, one({ guest: { ...base.guest, agent: "silent" } })))).toEqual([
      "step.disk:done",
      "step.machine:done",
      "step.windows:current",
    ])
  })

  it("is all done when the agent answers", () => {
    expect(states(startSteps(false, one()))).toEqual(["step.machine:done", "step.windows:done"])
  })
})

describe("facts", () => {
  it("lists what the instance is, as message keys and values", () => {
    expect(facts(one())).toEqual([
      { key: "fact.image", values: { name: "win11" } },
      { key: "fact.cpus", values: { count: 4 } },
      { key: "fact.memory", values: { size: "8 GiB" } },
      { key: "fact.changes", values: { size: "3.0 GiB" } },
      { key: "fact.saves", values: { count: 2 } },
    ])
  })

  it("leaves out what is unknown and saves when there are none", () => {
    const got = facts(one({ image: null, cpus: null, overlayBytes: null, saves: { count: 0, bytes: 0 } }))
    expect(got.map((f) => f.key)).toEqual(["fact.memory"])
  })
})

describe("displaySize", () => {
  it("reads a virtio-gpu size", () => {
    expect(displaySize("virtio-gpu 1280x800")).toEqual({ width: 1280, height: 800, device: "virtio-gpu" })
  })

  it("reads the firmware framebuffer", () => {
    expect(displaySize("ramfb (firmware framebuffer, 800x600)")).toEqual({ width: 800, height: 600, device: "ramfb" })
  })

  it("is the firmware framebuffer's 800x600 when unknown", () => {
    expect(displaySize(null)).toEqual({ width: 800, height: 600, device: null })
  })
})

describe("parseChecks", () => {
  it("reads doctor --json", () => {
    const out = JSON.stringify({ ready: false, checks: [{ label: "runtime (not installed)", ok: false, hint: "winvm setup" }], timeMachine: "" })
    expect(parseChecks(out)?.ready).toBe(false)
  })

  it("is null for text output", () => {
    expect(parseChecks("ok    macOS 15.1")).toBeNull()
  })
})

describe("parseConnection", () => {
  it("reads open --json", () => {
    const out = JSON.stringify({ display: 1, vncPort: 5901, websocketPort: 5701, password: "abcd1234" })
    expect(parseConnection(out)).toEqual({ display: 1, vncPort: 5901, websocketPort: 5701, password: "abcd1234" })
  })

  it("is null without a websocket port", () => {
    expect(parseConnection(JSON.stringify({ display: 1 }))).toBeNull()
  })
})
