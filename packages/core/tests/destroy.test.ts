/**
 * `winvm destroy` against a state directory laid out by hand: no VM needed,
 * since destroy refuses a running instance and only ever deletes files.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import { destroy } from "../src/commands"
import { instanceDir, pathsFor } from "../src/paths"
import { saveDir, savesDir } from "../src/saves"

let state = ""
let previousHome: string | undefined

function makeInstance(name: string, saveNames: readonly string[]): void {
  mkdirSync(instanceDir(name), { recursive: true })
  writeFileSync(pathsFor(name).meta, JSON.stringify({ image: "win11-arm64", vnc: 9, created: new Date().toISOString() }))
  for (const s of saveNames) {
    mkdirSync(saveDir(name, s), { recursive: true })
    writeFileSync(resolve(saveDir(name, s), "manifest.json"), "{}")
    writeFileSync(resolve(saveDir(name, s), "vmstate.zst"), "x".repeat(4096))
  }
}

describe("destroy", () => {
  beforeEach(() => {
    previousHome = process.env["WINVM_HOME"]
    state = mkdtempSync(resolve(tmpdir(), "winvm-destroy-"))
    process.env["WINVM_HOME"] = state
    spyOn(console, "log").mockImplementation(() => undefined)
    spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env["WINVM_HOME"]
    else process.env["WINVM_HOME"] = previousHome
    rmSync(state, { recursive: true, force: true })
    mock.restore()
  })

  it("removes the instance's saves with it, and only its own", () => {
    makeInstance("gone", ["baseline", "stow"])
    makeInstance("other", ["baseline"])
    expect(destroy(parseArgs(["-i", "gone"]))).toBe(0)
    expect(existsSync(instanceDir("gone"))).toBe(false)
    // Left behind, a new "gone" would recall the old stow on its first start.
    expect(existsSync(savesDir("gone"))).toBe(false)
    expect(existsSync(saveDir("other", "baseline"))).toBe(true)
    expect(existsSync(instanceDir("other"))).toBe(true)
  })

  it("keeps them with --keep-saves", () => {
    makeInstance("kept", ["baseline"])
    expect(destroy(parseArgs(["-i", "kept", "--keep-saves"]))).toBe(0)
    expect(existsSync(instanceDir("kept"))).toBe(false)
    expect(existsSync(saveDir("kept", "baseline"))).toBe(true)
  })

  it("is fine with an instance that never had saves", () => {
    makeInstance("bare", [])
    expect(destroy(parseArgs(["--keep-saves", "-i", "bare"]))).toBe(0)
    expect(existsSync(instanceDir("bare"))).toBe(false)
  })

  it("refuses an unknown instance and touches nothing", () => {
    makeInstance("x", ["baseline"])
    rmSync(pathsFor("x").meta)
    expect(destroy(parseArgs(["-i", "x"]))).toBe(1)
    expect(existsSync(saveDir("x", "baseline"))).toBe(true)
  })
})
