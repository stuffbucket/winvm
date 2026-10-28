/**
 * Notes on saves, and `winvm saves note`, against temporary state and data
 * directories: no VM, and never the real home.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import { copyNote, notePath, notesDir, readNote, removeNote, removeNotes, writeNote } from "../src/notes"
import { list, note } from "../src/savecmds"
import { removeAllSaves, removeSave, saveDir } from "../src/saves"

const VARS = ["WINVM_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const
let root = ""
let saved: Record<string, string | undefined> = {}
let out: string[] = []
let errs: string[] = []

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]))
  root = mkdtempSync(resolve(tmpdir(), "winvm-notes-"))
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

/** A save directory with a valid manifest and nothing else: enough for everything here. */
function makeSave(instance: string, name: string): void {
  mkdirSync(saveDir(instance, name), { recursive: true })
  const m = { name, instance, kind: "manual", createdAt: "2026-10-28T10:00:00.000Z", bytes: 1, compat: "abc", image: "win11-arm64" }
  writeFileSync(resolve(saveDir(instance, name), "manifest.json"), JSON.stringify(m))
}

describe("notes", () => {
  it("live in the XDG data dir, one file per save", () => {
    expect(notePath("dev", "clean")).toBe(resolve(root, "data/winvm/notes/dev/clean.json"))
    expect(notesDir("dev")).toBe(resolve(root, "data/winvm/notes/dev"))
  })

  it("refuse names that would leave the notes directory", () => {
    for (const s of ["../x", ".hidden", "a/b", ""]) expect(() => notePath("dev", s)).toThrow()
    for (const i of ["../x", ".x", "a/b", ""]) expect(() => notesDir(i)).toThrow()
  })

  it("read back what was written, pretty-printed, with the time", () => {
    const at = new Date("2026-10-28T12:00:00.000Z")
    const n = writeNote("dev", "clean", { title: "  Clean install ", text: "before Office", tags: [" a", "b", "a", ""] }, process.env, at)
    expect(n).toEqual({ title: "Clean install", text: "before Office", tags: ["a", "b"], updatedAt: at.toISOString() })
    expect(readNote("dev", "clean")).toEqual(n)
    const raw = readFileSync(notePath("dev", "clean"), "utf8")
    expect(raw.endsWith("}\n")).toBe(true)
    expect(raw).toContain('\n  "title": "Clean install"')
  })

  it("merge a change into what is there", () => {
    writeNote("dev", "clean", { title: "T", text: "x", tags: ["a"] })
    expect(writeNote("dev", "clean", { tags: ["b"] })).toMatchObject({ title: "T", text: "x", tags: ["b"] })
    expect(writeNote("dev", "clean", { title: "" })).toMatchObject({ title: null, text: "x", tags: ["b"] })
  })

  it("delete the file once nothing is left in it", () => {
    writeNote("dev", "clean", { title: "T" })
    const n = writeNote("dev", "clean", { title: null, text: "   " })
    expect(n).toMatchObject({ title: null, text: "", tags: [] })
    expect(existsSync(notePath("dev", "clean"))).toBe(false)
    expect(readNote("dev", "clean")).toBeNull()
  })

  it("read a hand-edited note leniently, and an unreadable one as none", () => {
    mkdirSync(notesDir("dev"), { recursive: true })
    writeFileSync(notePath("dev", "a"), JSON.stringify({ title: 3, tags: ["x", 4, "x"] }))
    const n = readNote("dev", "a")
    expect(n).toMatchObject({ title: null, text: "", tags: ["x"] })
    expect(Number.isNaN(Date.parse(n?.updatedAt ?? ""))).toBe(false)
    writeFileSync(notePath("dev", "b"), "{ not json")
    expect(readNote("dev", "b")).toBeNull()
    writeFileSync(notePath("dev", "c"), "[]")
    expect(readNote("dev", "c")).toBeNull()
    expect(readNote("dev", "missing")).toBeNull()
  })

  it("remove one, or all of an instance's", () => {
    writeNote("dev", "a", { text: "1" })
    writeNote("dev", "b", { text: "2" })
    writeNote("other", "a", { text: "3" })
    removeNote("dev", "a")
    expect(readNote("dev", "a")).toBeNull()
    expect(readNote("dev", "b")?.text).toBe("2")
    removeNotes("dev")
    expect(existsSync(notesDir("dev"))).toBe(false)
    expect(readNote("other", "a")?.text).toBe("3")
  })

  it("copy to another instance, and a copy of no note clears the destination's", () => {
    writeNote("src", "golden", { title: "G" })
    copyNote("src", "dst", "golden")
    expect(readNote("dst", "golden")?.title).toBe("G")
    removeNote("src", "golden")
    copyNote("src", "dst", "golden")
    expect(readNote("dst", "golden")).toBeNull()
  })
})

describe("notes follow their saves", () => {
  it("go with `removeSave`", () => {
    makeSave("dev", "clean")
    writeNote("dev", "clean", { title: "T" })
    writeNote("dev", "kept", { title: "K" })
    removeSave("dev", "clean")
    expect(readNote("dev", "clean")).toBeNull()
    expect(readNote("dev", "kept")?.title).toBe("K")
  })

  it("all go with `removeAllSaves`, and only that instance's", () => {
    makeSave("dev", "clean")
    writeNote("dev", "clean", { title: "T" })
    writeNote("other", "clean", { title: "O" })
    removeAllSaves("dev")
    expect(existsSync(notesDir("dev"))).toBe(false)
    expect(readNote("other", "clean")?.title).toBe("O")
  })
})

describe("winvm saves note", () => {
  const run = (...argv: string[]): number => list(parseArgs(["note", ...argv]))

  it("says there is no note, as text or JSON null", () => {
    makeSave("dev", "clean")
    expect(run("-i", "dev", "clean")).toBe(0)
    expect(out).toEqual(['save "clean" has no note'])
    out.length = 0
    expect(run("-i", "dev", "clean", "--json")).toBe(0)
    expect(out).toEqual(["null"])
  })

  it("writes and merges the fields given, and prints the note as JSON", () => {
    makeSave("dev", "clean")
    expect(run("-i", "dev", "clean", "--title", "Clean install", "--tags", "win11, clean,win11")).toBe(0)
    expect(out).toEqual(['updated the note on save "clean"'])
    out.length = 0
    expect(run("-i", "dev", "clean", "--text", "before Office", "--json")).toBe(0)
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>
    expect(printed).toMatchObject({ title: "Clean install", text: "before Office", tags: ["win11", "clean"] })
    expect(readNote("dev", "clean")).toEqual(printed as never)
  })

  it("shows a note as text", () => {
    makeSave("dev", "clean")
    writeNote("dev", "clean", { title: "T", text: "body", tags: ["a", "b"] })
    expect(run("-i", "dev", "clean")).toBe(0)
    expect(out[0]).toBe("title: T")
    expect(out[1]).toBe("tags:  a, b")
    expect(out.at(-1)).toBe("\nbody")
  })

  it("reads the text from standard input with --text -", () => {
    makeSave("dev", "clean")
    expect(note(parseArgs(["note", "-i", "dev", "clean", "--text", "-"]), () => "from stdin\nline two\n\n")).toBe(0)
    expect(readNote("dev", "clean")?.text).toBe("from stdin\nline two")
  })

  it("takes the app's --key=value form, markdown starting with - included, and = with nothing clears", () => {
    makeSave("dev", "clean")
    expect(run("-i", "dev", "clean", "--title=Clean", "--text=- one\n- two", "--tags=a,b", "--json")).toBe(0)
    expect(JSON.parse(out.join("\n"))).toMatchObject({ title: "Clean", text: "- one\n- two", tags: ["a", "b"] })
    expect(run("-i", "dev", "clean", "--title=")).toBe(0)
    expect(readNote("dev", "clean")).toMatchObject({ title: null, text: "- one\n- two", tags: ["a", "b"] })
    expect(run("-i", "dev", "clean", "--text=", "--tags=")).toBe(0)
    expect(existsSync(notePath("dev", "clean"))).toBe(false)
  })

  it("clears the note, and --clear with fields replaces it", () => {
    makeSave("dev", "clean")
    writeNote("dev", "clean", { title: "T", text: "old", tags: ["a"] })
    expect(run("-i", "dev", "clean", "--clear", "--title", "New")).toBe(0)
    expect(readNote("dev", "clean")).toMatchObject({ title: "New", text: "", tags: [] })
    out.length = 0
    expect(run("-i", "dev", "clean", "--clear")).toBe(0)
    expect(out).toEqual(['deleted the note on save "clean"'])
    expect(existsSync(notePath("dev", "clean"))).toBe(false)
  })

  it("fails for a save that does not exist, or no save named", () => {
    expect(run("-i", "dev", "nope", "--title", "x")).toBe(1)
    expect(errs[0]).toContain('instance "dev" has no save "nope"')
    expect(existsSync(notePath("dev", "nope"))).toBe(false)
    expect(run("-i", "dev")).toBe(1)
    expect(errs[1]).toContain("usage: winvm saves note")
    expect(run("-i", "dev", "../escape", "--title", "x")).toBe(1)
  })

  it("`saves rm` says the note went too", () => {
    makeSave("dev", "a")
    makeSave("dev", "b")
    writeNote("dev", "a", { title: "T" })
    expect(list(parseArgs(["rm", "-i", "dev", "a"]))).toBe(0)
    expect(list(parseArgs(["rm", "-i", "dev", "b"]))).toBe(0)
    expect(out).toEqual(['deleted save "a" and its note', 'deleted save "b"'])
    expect(readNote("dev", "a")).toBeNull()
  })

  it("`saves --json` carries the note and the screenshot paths", () => {
    makeSave("dev", "clean")
    writeFileSync(resolve(saveDir("dev", "clean"), "thumb.png"), "png")
    writeNote("dev", "clean", { title: "Clean" })
    expect(list(parseArgs(["-i", "dev", "--json"]))).toBe(0)
    const [e] = JSON.parse(out.join("\n")) as Record<string, unknown>[]
    expect(e).toMatchObject({ name: "clean", format: "zstd", title: "Clean", screenshot: null })
    expect(e?.["thumbnail"]).toBe(resolve(saveDir("dev", "clean"), "thumb.png"))
    expect((e?.["notes"] as Record<string, unknown>)["title"]).toBe("Clean")
  })
})
