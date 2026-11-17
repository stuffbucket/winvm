import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { lockState } from "../src/pidlock"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"

let dir = ""

beforeEach(() => {
  dir = mkdtempSync("/tmp/wvlk-")
})

afterEach(() => {
  releasePidfiles()
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
