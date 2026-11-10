/**
 * `winvm destroy` against a state directory laid out by hand: no VM needed,
 * since destroy refuses a running instance and only ever deletes files.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import { destroy, prune } from "../src/commands"
import { readNote, writeNote } from "../src/notes"
import { instanceDir, pathsFor } from "../src/paths"
import { listSaves, saveDir, setSaveProtection } from "../src/saves"

let state = ""
let previousHome: string | undefined
let previousData: string | undefined

function makeInstance(name: string, saveNames: readonly string[]): void {
  mkdirSync(instanceDir(name), { recursive: true })
  writeFileSync(pathsFor(name).meta, JSON.stringify({ image: "win11-arm64", vnc: 9, created: new Date().toISOString() }))
  for (const s of saveNames) {
    mkdirSync(saveDir(name, s), { recursive: true })
    writeFileSync(resolve(saveDir(name, s), "manifest.json"), JSON.stringify({
      name: s, instance: name, kind: s === "stow" ? "stow" : "baseline", createdAt: new Date().toISOString(), bytes: 4096, compat: "abc", image: "win11-arm64",
    }))
    writeFileSync(resolve(saveDir(name, s), "vmstate.zst"), "x".repeat(4096))
  }
}

describe("destroy", () => {
  beforeEach(() => {
    previousHome = process.env["WINVM_HOME"]
    previousData = process.env["XDG_DATA_HOME"]
    state = mkdtempSync(resolve(tmpdir(), "winvm-destroy-"))
    process.env["WINVM_HOME"] = state
    // Notes live in the XDG data dir: never the real one.
    process.env["XDG_DATA_HOME"] = resolve(state, "data")
    spyOn(console, "log").mockImplementation(() => undefined)
    spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env["WINVM_HOME"]
    else process.env["WINVM_HOME"] = previousHome
    if (previousData === undefined) delete process.env["XDG_DATA_HOME"]
    else process.env["XDG_DATA_HOME"] = previousData
    rmSync(state, { recursive: true, force: true })
    mock.restore()
  })

  it("removes the instance's saves with it, and only its own", () => {
    makeInstance("gone", ["baseline", "stow"])
    makeInstance("other", ["baseline"])
    writeNote("gone", "baseline", { title: "first boot" })
    writeNote("other", "baseline", { title: "other's" })
    expect(destroy(parseArgs(["-i", "gone"]))).toBe(0)
    expect(readNote("gone", "baseline")).toBeNull()
    expect(readNote("other", "baseline")?.title).toBe("other's")
    expect(existsSync(instanceDir("gone"))).toBe(false)
    // Left behind, a new "gone" would recall the old stow on its first start.
    expect(listSaves("gone")).toEqual([])
    expect(existsSync(saveDir("other", "baseline"))).toBe(true)
    expect(existsSync(instanceDir("other"))).toBe(true)
  })

  it("keeps them with --keep-saves", () => {
    makeInstance("kept", ["baseline"])
    writeNote("kept", "baseline", { title: "first boot" })
    expect(destroy(parseArgs(["-i", "kept", "--keep-saves"]))).toBe(0)
    expect(existsSync(instanceDir("kept"))).toBe(false)
    expect(existsSync(saveDir("kept", "baseline"))).toBe(true)
    // The kept saves keep their notes.
    expect(readNote("kept", "baseline")?.title).toBe("first boot")
  })

  it("keeps protected checkpoints and all notes even without --keep-saves", () => {
    makeInstance("protected", ["baseline", "stow"])
    setSaveProtection("protected", "baseline", true)
    writeNote("protected", "baseline", { title: "Do not reclaim" })
    expect(destroy(parseArgs(["-i", "protected"]))).toBe(0)
    expect(existsSync(instanceDir("protected"))).toBe(false)
    expect(listSaves("protected")).toHaveLength(2)
    expect(readNote("protected", "baseline")?.title).toBe("Do not reclaim")
  })

  it("keeps unreadable checkpoints rather than guessing their protection state", () => {
    makeInstance("damaged", ["baseline"])
    writeFileSync(resolve(saveDir("damaged", "baseline"), "manifest.json"), "broken")
    expect(destroy(parseArgs(["-i", "damaged"]))).toBe(0)
    expect(existsSync(saveDir("damaged", "baseline"))).toBe(true)
  })

  it("prune leaves scratch instances with protected saves alone", () => {
    makeInstance("build-kept", ["baseline"])
    makeInstance("build-old", ["baseline"])
    setSaveProtection("build-kept", "baseline", true)
    writeNote("build-kept", "baseline", { title: "Important" })
    expect(prune(parseArgs([]))).toBe(0)
    expect(existsSync(instanceDir("build-kept"))).toBe(true)
    expect(readNote("build-kept", "baseline")?.title).toBe("Important")
    expect(existsSync(instanceDir("build-old"))).toBe(false)
    expect(listSaves("build-old")).toEqual([])
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
