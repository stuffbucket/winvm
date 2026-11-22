import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"

import { resolve } from "node:path"

import { pathsFor } from "../src/paths"
import { isRunning, pidOf } from "../src/qemu"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"

const NAME = "pidfile-test"
let home: string
let savedHome: string | undefined

beforeAll(() => {
  savedHome = process.env.WINVM_HOME
  home = mkdtempSync("/tmp/wvpid-")
  process.env.WINVM_HOME = home
  mkdirSync(pathsFor(NAME).dir, { recursive: true })
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
})

describe("pidOf", () => {
  afterEach(async () => {
    await releasePidfiles()
  })

  it("is null, not an error, when there is no pidfile (QEMU removed it as it exited)", () => {
    const p = pathsFor(NAME)
    rmSync(p.pid, { force: true })
    expect(pidOf(p)).toBeNull()
    expect(isRunning(p)).toBe(false)
  })

  it("is the process that holds the pidfile's lock", async () => {
    const p = pathsFor(NAME)
    const qemu = await lockPidfile(p.pid, "qemu-system-aarch64")
    expect(pidOf(p)).toBe(qemu.pid)
    expect(isRunning(p)).toBe(true)
  })

  it("is the lock holder even before it has written its pid", async () => {
    const p = pathsFor(NAME)
    const qemu = await lockPidfile(p.pid, "qemu-system-aarch64")
    writeFileSync(p.pid, "\n")
    expect(pidOf(p)).toBe(qemu.pid)
  })

  it("is null when the unlocked pidfile names a live process that is not this instance's QEMU (a reused pid)", async () => {
    const p = pathsFor(NAME)
    const stranger = await lockPidfile(resolve(home, "elsewhere.pid"), "cat")
    writeFileSync(p.pid, `${String(stranger.pid)}\n`)
    expect(pidOf(p)).toBeNull()
    expect(isRunning(p)).toBe(false)
    expect(existsSync(p.pid)).toBe(true)
  })

  it("is null when the unlocked pidfile names another instance's QEMU", async () => {
    const p = pathsFor(NAME)
    mkdirSync(pathsFor("other").dir, { recursive: true })
    const other = await lockPidfile(
      pathsFor("other").pid,
      "qemu-system-aarch64",
      "-pidfile",
      pathsFor("other").pid,
    )
    writeFileSync(p.pid, `${String(other.pid)}\n`)
    expect(pidOf(p)).toBeNull()
  })

  it("still counts an unlocked pidfile whose live process is this instance's QEMU (one an older winvm started)", async () => {
    const p = pathsFor(NAME)
    const legacy = await lockPidfile(
      resolve(home, "unrelated.lock"),
      "qemu-system-aarch64",
      "-name",
      `winvm-${NAME}`,
      "-pidfile",
      p.pid,
    )
    writeFileSync(p.pid, `${String(legacy.pid)}\n`)
    expect(pidOf(p)).toBe(legacy.pid)
  })

  it("is null for a stale pidfile, and removes it", () => {
    const p = pathsFor(NAME)
    writeFileSync(p.pid, "99999999\n")
    expect(pidOf(p)).toBeNull()
    expect(existsSync(p.pid)).toBe(false)
  })

  it("is null for a pidfile that names no single process (-1, 0 or 1)", () => {
    const p = pathsFor(NAME)
    for (const pid of ["-1", "0", "1"]) {
      writeFileSync(p.pid, `${pid}\n`)
      expect(pidOf(p)).toBeNull()
      expect(isRunning(p)).toBe(false)
    }
  })

  it("is null for an unlocked pidfile that does not hold a number", () => {
    const p = pathsFor(NAME)
    writeFileSync(p.pid, "\n")
    expect(pidOf(p)).toBeNull()
  })
})
