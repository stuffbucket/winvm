/**
 * Whether QEMU runs, from its pidfile (qemu.ts pidOf): no pidfile, a stale one
 * and a live one. QEMU removes its pidfile as it exits, so a missing file is
 * "not running", never an error.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { pathsFor } from "../src/paths"
import { isRunning, pidOf } from "../src/qemu"

const NAME = "pidfile-test"
let home: string
let savedHome: string | undefined

beforeAll(() => {
  savedHome = process.env["WINVM_HOME"]
  home = mkdtempSync("/tmp/wvpid-")
  process.env["WINVM_HOME"] = home
  mkdirSync(pathsFor(NAME).dir, { recursive: true })
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env["WINVM_HOME"]
  else process.env["WINVM_HOME"] = savedHome
})

describe("pidOf", () => {
  it("is null, not an error, when there is no pidfile (QEMU removed it as it exited)", () => {
    const p = pathsFor(NAME)
    rmSync(p.pid, { force: true })
    expect(pidOf(p)).toBeNull()
    expect(isRunning(p)).toBe(false)
  })

  it("is the pid of a live process", () => {
    const p = pathsFor(NAME)
    writeFileSync(p.pid, `${String(process.pid)}\n`)
    expect(pidOf(p)).toBe(process.pid)
    expect(isRunning(p)).toBe(true)
  })

  it("is null for a stale pidfile, and removes it", () => {
    const p = pathsFor(NAME)
    // Far above any pid macOS hands out.
    writeFileSync(p.pid, "99999999\n")
    expect(pidOf(p)).toBeNull()
    expect(existsSync(p.pid)).toBe(false)
  })

  it("is null for a pidfile that does not hold a number", () => {
    const p = pathsFor(NAME)
    writeFileSync(p.pid, "\n")
    expect(pidOf(p)).toBeNull()
  })
})
