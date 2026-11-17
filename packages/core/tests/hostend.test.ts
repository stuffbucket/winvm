import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
  effectiveConfig,
  parseAssignment,
  writeAssignments,
} from "../src/config"
import {
  type Busy,
  type HostEndFacts,
  type HostEndSeams,
  hostEndPlan,
  runHostEnd,
} from "../src/hostend"
import { StowNotRecallable } from "../src/saves"

const GIB = 1024 ** 3

const idle: HostEndFacts = {
  action: "stow",
  ephemeral: false,
  installMedia: false,
  unsaveable: null,
  freeBytes: 100 * GIB,
  needBytes: 5 * GIB,
  busy: null,
}

const busy = (
  operation: string,
  automatic = false,
  irreversible = false,
): Busy => ({
  operation,
  automatic,
  irreversible,
})

describe("what the service does when the Mac shuts down", () => {
  it("stows an idle guest", () => {
    expect(hostEndPlan(idle)).toEqual({
      first: "none",
      end: "stow",
      reason: null,
    })
  })

  it("quits an ephemeral guest or an installer, whose disks are not kept", () => {
    expect(hostEndPlan({ ...idle, ephemeral: true })).toMatchObject({
      end: "quit",
    })
    expect(hostEndPlan({ ...idle, installMedia: true })).toMatchObject({
      end: "quit",
    })
  })

  it("shuts down a guest that cannot be saved, saying why", () => {
    const plan = hostEndPlan({
      ...idle,
      unsaveable: "the image predates virtio boot",
    })
    expect(plan.end).toBe("shutdown")
    expect(plan.reason).toContain("virtio boot")
  })

  it("shuts down when hostEnd.action says so", () => {
    expect(hostEndPlan({ ...idle, action: "shutdown" })).toMatchObject({
      end: "shutdown",
      reason: "hostEnd.action is shutdown",
    })
  })

  it("shuts down when the disk has less room than the RAM in use plus 1 GiB", () => {
    const plan = hostEndPlan({ ...idle, freeBytes: 4 * GIB })
    expect(plan.end).toBe("shutdown")
    expect(plan.reason).toContain("free")
    expect(hostEndPlan({ ...idle, freeBytes: null }).end).toBe("stow")
  })

  it("cancels an autosave in flight, then stows", () => {
    expect(hostEndPlan({ ...idle, busy: busy("save", true) })).toEqual({
      first: "cancel",
      end: "stow",
      reason: null,
    })
  })

  it("waits for a stow or a save the user started", () => {
    expect(hostEndPlan({ ...idle, busy: busy("stow") }).first).toBe("wait")
    expect(hostEndPlan({ ...idle, busy: busy("save") }).first).toBe("wait")
  })

  it("lets a stop past its point of no return finish, and never stows a guest that is shutting down", () => {
    expect(
      hostEndPlan({ ...idle, busy: busy("stop", false, true) }),
    ).toMatchObject({ first: "wait", end: "shutdown" })
  })
})

interface Run {
  readonly calls: string[]
  readonly notes: Record<string, unknown>[]
  seams: HostEndSeams
  running: boolean
  holder: Busy | null
  clock: number
}

function run(
  facts: HostEndFacts,
  o: {
    readonly stow?: (r: Run) => Promise<void>
    readonly onCancel?: (r: Run) => void
  } = {},
): Run {
  const r: Run = {
    calls: [],
    notes: [],
    running: true,
    holder: facts.busy,
    clock: 0,
    seams: {
      facts: () => facts,
      running: () => r.running,
      busy: () => r.holder,
      cancel: async () => {
        r.calls.push("cancel")
        o.onCancel?.(r)
        await Promise.resolve()
      },
      stow: async () => {
        r.calls.push("stow")
        if (o.stow !== undefined) await o.stow(r)
        r.running = false
      },
      handBack: async (end, reason) => {
        r.calls.push(`hand back ${end}: ${reason}`)
        await Promise.resolve()
      },
      note: (fields) => {
        r.notes.push(fields)
      },
      now: () => r.clock,
      sleep: async (ms) => {
        r.clock += ms
        await Promise.resolve()
      },
    },
  }
  return r
}

describe("running the host end", () => {
  it("stows an idle guest and records the plan and the outcome", async () => {
    const r = run(idle)
    expect(await runHostEnd(60_000, r.seams)).toBe("stowed")
    expect(r.calls).toEqual(["stow"])
    expect(r.notes[0]).toMatchObject({
      what: "host-end",
      step: "plan",
      end: "stow",
    })
    expect(r.notes.at(-1)).toMatchObject({ what: "host-end", step: "stowed" })
  })

  it("cancels an autosave, waits for its lease, then stows", async () => {
    const r = run(
      { ...idle, busy: busy("save", true) },
      {
        onCancel: (x) => {
          x.holder = null
        },
      },
    )
    expect(await runHostEnd(60_000, r.seams)).toBe("stowed")
    expect(r.calls).toEqual(["cancel", "stow"])
  })

  it("waits for the user's stow and does nothing more once QEMU is gone", async () => {
    const r = run({ ...idle, busy: busy("stow") })
    r.seams = {
      ...r.seams,
      sleep: async (ms) => {
        r.clock += ms
        if (r.clock >= 3000) {
          r.running = false
          r.holder = null
        }
        await Promise.resolve()
      },
    }
    expect(await runHostEnd(60_000, r.seams)).toBe("ended-by-op")
    expect(r.calls).toEqual([])
  })

  it("cancels a user save it can no longer wait for, then stows", async () => {
    const r = run(
      { ...idle, busy: busy("save") },
      {
        onCancel: (x) => {
          x.holder = null
        },
      },
    )
    expect(await runHostEnd(20_000, r.seams)).toBe("stowed")
    expect(r.calls).toEqual(["cancel", "stow"])
    expect(r.clock).toBeGreaterThanOrEqual(5000)
  })

  it("hands the host end back for a shutdown when the stow fails, with the reason", async () => {
    const r = run(idle, {
      stow: async () => {
        await Promise.resolve()
        throw new Error("migration failed: disk full")
      },
    })
    expect(await runHostEnd(60_000, r.seams)).toBe("handed-back")
    expect(r.calls).toEqual([
      "stow",
      "hand back shutdown: stow failed: migration failed: disk full",
    ])
  })

  it("hands back a shutdown, as a decision, when createSave refuses a stow no recall could take", async () => {
    const r = run(idle, {
      stow: async () => {
        await Promise.resolve()
        throw new StowNotRecallable(
          "source",
          "11.0.0+patches:p1",
          "11.1.2+patches:p2",
        )
      },
    })
    expect(await runHostEnd(60_000, r.seams)).toBe("handed-back")
    expect(r.calls).toEqual([
      "stow",
      "hand back shutdown: the running QEMU 11.0.0 is not this winvm's QEMU 11.1.2, so no recall could take its stow",
    ])
  })

  it("hands back a quit for an ephemeral guest and a shutdown for one it may not stow", async () => {
    const quit = run({ ...idle, ephemeral: true })
    expect(await runHostEnd(60_000, quit.seams)).toBe("handed-back")
    expect(quit.calls).toEqual([
      "hand back quit: the guest runs with -snapshot, so its disk changes are not kept",
    ])
    const shutdown = run({ ...idle, action: "shutdown" })
    await runHostEnd(60_000, shutdown.seams)
    expect(shutdown.calls).toEqual([
      "hand back shutdown: hostEnd.action is shutdown",
    ])
  })

  it("hands back a shutdown when another operation still holds the guest at the deadline", async () => {
    const r = run({ ...idle, busy: busy("load") })
    expect(await runHostEnd(10_000, r.seams)).toBe("handed-back")
    expect(r.calls).toEqual(["hand back shutdown: load still holds the guest"])
  })
})

describe("hostEnd.action", () => {
  let home = ""
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env.WINVM_HOME
    home = mkdtempSync(resolve(tmpdir(), "winvm-hostend-"))
    process.env.WINVM_HOME = home
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.WINVM_HOME
    else process.env.WINVM_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })

  it("is stow unless set to shutdown, and refuses anything else", () => {
    expect(effectiveConfig("h")["hostEnd.action"]).toBe("stow")
    writeAssignments("h", [parseAssignment("hostEnd.action=shutdown")])
    expect(effectiveConfig("h")["hostEnd.action"]).toBe("shutdown")
    expect(() => parseAssignment("hostEnd.action=nothing")).toThrow(
      "stow, shutdown",
    )
  })
})
