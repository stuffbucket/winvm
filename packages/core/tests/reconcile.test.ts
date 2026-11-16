import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { ManagementError } from "../src/lifecycle"
import { pathsFor } from "../src/paths"
import { managementOf, reconcileInstances } from "../src/reconcile"

let home = ""
let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync(resolve(tmpdir(), "winvm-rec-"))
  process.env.WINVM_HOME = home
  const p = pathsFor("vm")
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify({ image: "x", vnc: 1, created: "" }))
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

describe("whether an instance needs a repair", () => {
  it("is current for a stopped guest that left nothing behind", () => {
    expect(managementOf("vm", { stale: () => [] })).toBe("current")
  })

  it("is a repair when a guest that is gone left its drives mounted", () => {
    expect(managementOf("vm", { stale: () => ["/Volumes/vm-c"] })).toBe(
      "repair",
    )
  })

  it("is unknown, not a guess, when it cannot be read", () => {
    expect(
      managementOf("vm", {
        stale: () => {
          throw new Error("mount table unreadable")
        },
      }),
    ).toBe("unknown")
  })
})

describe("reconciling instances", () => {
  it("sweeps and reconciles every instance, carries on past one that fails, and says so in its exit code", async () => {
    const swept: string[] = []
    const done: string[] = []
    const said = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const code = await reconcileInstances(["a", "b", "c"], {
        sweep: (n) => {
          swept.push(n)
          return []
        },
        reconcile: async (n) => {
          if (n === "b")
            throw new ManagementError("service-replace", `b would not start`)
          done.push(n)
          return await Promise.resolve({
            changed: false,
            servicePid: null,
            watcherPid: null,
          })
        },
      })
      expect(code).toBe(1)
      expect(swept).toEqual(["a", "b", "c"])
      expect(done).toEqual(["a", "c"])
      expect(said.mock.calls.flat().join("\n")).toContain(
        "::error::b would not start",
      )
    } finally {
      said.mockRestore()
    }
  })

  it("says when a repair was put off, and how to finish it", async () => {
    const said = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const code = await reconcileInstances(["a"], {
        sweep: () => [],
        reconcile: async () =>
          await Promise.resolve({
            changed: false,
            servicePid: 1,
            watcherPid: 2,
            deferred: "autosaving" as const,
          }),
      })
      expect(code).toBe(0)
      const text = said.mock.calls.flat().join("\n")
      expect(text).toContain("autosaving")
      expect(text).toContain("winvm reconcile -i a")
    } finally {
      said.mockRestore()
    }
  })
})
