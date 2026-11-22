import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { lockFrom, lockState } from "../src/pidlock"
import { signalProcess } from "../src/proc"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"

let dir = ""

beforeEach(() => {
  dir = mkdtempSync("/tmp/wvlk-")
})

afterEach(async () => {
  await releasePidfiles()
  rmSync(dir, { recursive: true, force: true })
})

describe("lockState", () => {
  it("is missing for no file and free for a file nobody locks", () => {
    const file = resolve(dir, "qemu.pid")
    expect(lockState(file)).toBe("missing")
    writeFileSync(file, "123\n")
    expect(lockState(file)).toBe("free")
  })

  it("names the process that holds the lock, and is free once it has gone", async () => {
    const file = resolve(dir, "qemu.pid")
    const holder = await lockPidfile(file)
    expect(lockState(file)).toEqual({ held: holder.pid })
    holder.proc.kill("SIGKILL")
    await holder.proc.exited
    expect(lockState(file)).toBe("free")
  })
})

const layouts = {
  darwin: { bytes: 24, typeAt: 20, pidAt: 16, write: 3, free: 2 },
  linux: { bytes: 32, typeAt: 0, pidAt: 24, write: 1, free: 2 },
} as const

function flock(
  platform: keyof typeof layouts,
  type: "write" | "free",
  pid: number,
): DataView {
  const l = layouts[platform]
  const view = new DataView(new ArrayBuffer(l.bytes))
  view.setInt16(l.typeAt, l[type], true)
  view.setInt32(l.pidAt, pid, true)
  return view
}

describe("reading a lock the kernel reports", () => {
  it("names a holder only when it is one process", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(lockFrom(flock(platform, "write", 4242), platform)).toEqual({
        held: 4242,
      })
      expect(lockFrom(flock(platform, "free", 0), platform)).toBe("free")
      expect(lockFrom(flock(platform, "write", -1), platform)).toBe("unknown")
      expect(lockFrom(flock(platform, "write", 0), platform)).toBe("unknown")
    }
    expect(lockFrom(flock("linux", "write", 4242), "freebsd")).toBe("unknown")
  })
})

describe("signalProcess", () => {
  it("signals one real process, and never -1, 0 or 1", () => {
    for (const pid of [-1, 0, 1, Number.NaN, 1.5])
      expect(signalProcess(pid, 0)).toBe(false)
    expect(signalProcess(process.pid, 0)).toBe(true)
  })
})
