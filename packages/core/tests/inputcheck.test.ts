/**
 * What the input-path check says about a machine whose mouse or keyboard
 * "stopped working", and the watcher's quiet timeline of it (inputcheck.ts).
 */
import { describe, expect, it } from "bun:test"

import type { InputProbe, Timed } from "../src/inputcheck"
import { LATE_TICK_MS, LivenessLog, SLOW_MONITOR_MS, judgeInput, parseHidIdleSeconds } from "../src/inputcheck"

const ok = <T>(value: T, ms = 12): Timed<T> => ({ ms, value })
const probe = (over: Partial<InputProbe> = {}): InputProbe => ({
  pid: 4242,
  processState: "S",
  status: ok("running"),
  vncClients: ok(1),
  mice: ok([{ name: "QEMU USB Tablet", current: true, absolute: true }]),
  ...over,
})
const titles = (p: InputProbe): string[] => judgeInput(p).map((f) => f.title)

describe("judgeInput", () => {
  it("says everything on the host side is fine, and where else to look", () => {
    const f = judgeInput(probe())
    expect(f).toHaveLength(1)
    expect(f[0]?.level).toBe("ok")
    expect(f[0]?.detail).toContain("in the guest")
  })

  it("names a stopped process", () => {
    expect(titles(probe({ processState: "T" }))[0]).toContain("stopped by a signal")
  })

  it("calls a monitor that does not answer a stalled main loop and says how to capture it", () => {
    const f = judgeInput(probe({ status: { ms: null, value: null, error: "qmp: no greeting in 5000 ms" } }))
    expect(f[0]?.title).toContain("did not answer")
    expect(f[0]?.detail).toContain("sample 4242 3")
  })

  it("flags a slow answer, not just a missing one", () => {
    expect(titles(probe({ status: ok("running", SLOW_MONITOR_MS + 1) }))[0]).toContain("answered slowly")
  })

  it("says a paused machine drops input", () => {
    expect(titles(probe({ status: ok("paused") }))[0]).toContain("paused")
  })

  it("notices no viewer connected", () => {
    expect(titles(probe({ vncClients: ok(0) }))[0]).toContain("no viewer")
  })

  it("notices a pointer that is not absolute, or none at all", () => {
    expect(titles(probe({ mice: ok([{ name: "QEMU PS/2 Mouse", current: true, absolute: false }]) }))[0]).toContain("not absolute")
    expect(titles(probe({ mice: ok([]) }))[0]).toContain("no pointer device")
  })

  it("has nothing to say about a machine that is not running", () => {
    expect(titles(probe({ pid: null }))).toEqual(["QEMU is not running"])
  })
})

describe("LivenessLog", () => {
  const at = (s: number): number => 1_700_000_000_000 + s * 1000

  it("is silent while nothing changes", () => {
    const log = new LivenessLog()
    expect(log.observe({ at: at(0), monitorMs: 10, clients: 1 })).toEqual([])
    expect(log.observe({ at: at(15), monitorMs: 20, clients: 1 })).toEqual([])
  })

  it("notes a viewer dropping and coming back", () => {
    const log = new LivenessLog()
    log.observe({ at: at(0), monitorMs: 10, clients: 1 })
    expect(log.observe({ at: at(15), monitorMs: 10, clients: 0 })[0]).toContain("1 -> 0")
    expect(log.observe({ at: at(30), monitorMs: 10, clients: 1 })[0]).toContain("0 -> 1")
  })

  it("keeps the last viewer count through a tick the monitor could not answer", () => {
    const log = new LivenessLog()
    log.observe({ at: at(0), monitorMs: 10, clients: 1 })
    expect(log.observe({ at: at(15), monitorMs: null, clients: null }).join()).not.toContain("viewer")
    // Back with the same count: only the monitor's recovery is news.
    expect(log.observe({ at: at(30), monitorMs: 10, clients: 1 })).toEqual(["monitor: answering normally again after 15 s (10 ms)"])
  })

  it("logs a slow monitor once, with the process state, and its recovery", () => {
    const log = new LivenessLog()
    const first = log.observe({ at: at(0), monitorMs: 4200, clients: 1, processState: "U" })
    expect(first).toHaveLength(1)
    expect(first[0]).toContain("4200 ms")
    expect(first[0]).toContain("state U")
    expect(log.observe({ at: at(15), monitorMs: null, clients: 1 })).toEqual([])
    expect(log.observe({ at: at(30), monitorMs: 9, clients: 1 })[0]).toContain("normally again after 30 s")
  })

  it("notes a tick that came late: the Mac stood still, and QEMU with it", () => {
    const log = new LivenessLog(15_000)
    expect(log.observe({ at: at(0), monitorMs: 3, clients: 1 })).toEqual([])
    // 15 s tick, jitter of a second: nothing to say.
    expect(log.observe({ at: at(16), monitorMs: 3, clients: 1 })).toEqual([])
    const late = log.observe({ at: at(16 + 15 + 3.5), monitorMs: 3, clients: 1 })
    expect(late).toHaveLength(1)
    expect(late[0]).toContain("3.5 s late")
    expect(late[0]).toContain("pmset")
    expect(LATE_TICK_MS).toBeLessThan(3500)
  })

  it("does not call the time of its own save or stow a stall of the Mac", () => {
    const log = new LivenessLog(15_000)
    log.observe({ at: at(0), monitorMs: 3, clients: 0 })
    log.rebase(at(40)) // a 40 s action ended here
    expect(log.observe({ at: at(55), monitorMs: 3, clients: 0 })).toEqual([])
  })
})

describe("parseHidIdleSeconds", () => {
  it("reads ioreg's nanoseconds as seconds", () => {
    expect(parseHidIdleSeconds('    | |     "HIDIdleTime" = 1067308458\n')).toBeCloseTo(1.067, 3)
  })
  it("says nothing when the figure is missing", () => {
    expect(parseHidIdleSeconds("no such thing")).toBeNull()
  })
})
