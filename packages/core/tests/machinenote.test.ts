/**
 * The note on a machine (machinenote.ts) and `winvm note`, against temporary
 * data directories: no VM, and never the real home.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import { MAX_NOTE_CHARS, forgetMachineNote, machineNotePath, noteCmd, readMachineNote, removeMachineNote, writeMachineNote } from "../src/machinenote"
import { notePath, writeNote } from "../src/notes"
import { removeAllSaves } from "../src/saves"

const VARS = ["WINVM_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const
let root = ""
let saved: Record<string, string | undefined> = {}
let out: string[] = []
let errs: string[] = []

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]))
  root = mkdtempSync(resolve(tmpdir(), "winvm-machine-note-"))
  process.env["WINVM_HOME"] = resolve(root, "state")
  process.env["XDG_DATA_HOME"] = resolve(root, "data")
  process.env["XDG_CONFIG_HOME"] = resolve(root, "config")
  out = []
  errs = []
  spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")))
  spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(" ")))
})

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  rmSync(root, { recursive: true, force: true })
  mock.restore()
})

describe("a machine's note", () => {
  it("lives in the XDG data dir, one file per instance, apart from the notes on saves", () => {
    expect(machineNotePath("dev")).toBe(resolve(root, "data/winvm/machine-notes/dev.json"))
    expect(machineNotePath("dev")).not.toBe(notePath("dev", "dev"))
  })

  it("refuses names that would leave the directory", () => {
    for (const i of ["../x", ".x", "a/b", "a\\b", ""]) expect(() => machineNotePath(i)).toThrow()
  })

  it("reads back what was written, with the time", () => {
    const at = new Date("2026-11-03T09:00:00.000Z")
    expect(writeMachineNote("dev", "Office is not installed.\nLicense key in the drawer.", process.env, at)).toEqual({
      text: "Office is not installed.\nLicense key in the drawer.",
      updatedAt: "2026-11-03T09:00:00.000Z",
    })
    expect(readMachineNote("dev")?.text).toBe("Office is not installed.\nLicense key in the drawer.")
    expect(JSON.parse(readFileSync(machineNotePath("dev"), "utf8"))).toEqual({
      text: "Office is not installed.\nLicense key in the drawer.",
      updatedAt: "2026-11-03T09:00:00.000Z",
    })
  })

  it("keeps each machine's note to itself", () => {
    writeMachineNote("a", "one")
    writeMachineNote("b", "two")
    expect(readMachineNote("a")?.text).toBe("one")
    expect(readMachineNote("b")?.text).toBe("two")
    expect(readMachineNote("c")).toBeNull()
  })

  it("is no file once there is nothing in it", () => {
    writeMachineNote("dev", "something")
    expect(writeMachineNote("dev", "  \n ")).toBeNull()
    expect(existsSync(machineNotePath("dev"))).toBe(false)
    expect(readMachineNote("dev")).toBeNull()
  })

  it("is cut at a limit, so a runaway paste cannot fill the disk", () => {
    const n = writeMachineNote("dev", "x".repeat(MAX_NOTE_CHARS + 50))
    expect(n?.text.length).toBe(MAX_NOTE_CHARS)
  })

  it("reads as none when the file is broken, and takes the file's time when its own is", () => {
    mkdirSync(resolve(machineNotePath("dev"), ".."), { recursive: true })
    writeFileSync(machineNotePath("dev"), "{not json")
    expect(readMachineNote("dev")).toBeNull()
    writeFileSync(machineNotePath("dev"), JSON.stringify({ text: "kept", updatedAt: "yesterday" }))
    const n = readMachineNote("dev")
    expect(n?.text).toBe("kept")
    expect(Number.isNaN(Date.parse(n?.updatedAt ?? ""))).toBe(false)
  })

  it("goes with the machine, but not with the notes on its saves", () => {
    writeMachineNote("dev", "mine")
    writeNote("dev", "clean", { text: "a save" })
    removeAllSaves("dev")
    expect(existsSync(notePath("dev", "clean"))).toBe(false)
    expect(readMachineNote("dev")?.text).toBe("mine")
    forgetMachineNote("dev")
    expect(readMachineNote("dev")).toBeNull()
    expect(() => forgetMachineNote("../x")).not.toThrow()
    expect(() => removeMachineNote("dev")).not.toThrow()
  })
})

describe("winvm note", () => {
  const run = (...argv: string[]): number => noteCmd(parseArgs(["note", ...argv]), () => "from stdin\n\n")

  it("says there is none, then writes, prints and clears", () => {
    expect(run("-i", "dev")).toBe(0)
    expect(out.at(-1)).toBe('instance "dev" has no note')
    expect(run("-i", "dev", "--text=Check the display size")).toBe(0)
    expect(readMachineNote("dev")?.text).toBe("Check the display size")
    expect(run("-i", "dev")).toBe(0)
    expect(out.at(-1)).toBe("Check the display size")
    expect(run("-i", "dev", "--clear")).toBe(0)
    expect(readMachineNote("dev")).toBeNull()
  })

  it("prints JSON for scripts: the note, or null", () => {
    run("-i", "dev", "--json")
    expect(JSON.parse(out.at(-1) ?? "")).toBeNull()
    run("-i", "dev", "--text=hi", "--json")
    expect(JSON.parse(out.at(-1) ?? "").text).toBe("hi")
  })

  it("reads text from stdin with -", () => {
    run("-i", "dev", "--text=-")
    expect(readMachineNote("dev")?.text).toBe("from stdin")
  })

  it("takes a text that starts with a dash, in the one-word form", () => {
    run("-i", "dev", "--text=- first thing")
    expect(readMachineNote("dev")?.text).toBe("- first thing")
  })

  it("refuses --clear with --text, a stray word and a bad name", () => {
    expect(run("-i", "dev", "--clear", "--text=x")).toBe(2)
    expect(run("-i", "dev", "extra")).toBe(2)
    expect(run("-i", "../x", "--text=x")).toBe(2)
    expect(errs.length).toBe(3)
  })
})
