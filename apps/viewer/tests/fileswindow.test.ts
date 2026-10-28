import { describe, expect, it } from "bun:test"
import { z } from "zod"

import type { Entry, Sort } from "../ui/src/features/files/files"
import { finderDate, isWithin, nameProblem, parentPath, samePath, sortEntries } from "../ui/src/features/files/files"
import { glyphOf, kindLabel, kindOf } from "../ui/src/features/files/kinds"
import { parseReply, unreachable } from "../ui/src/features/files/ops"

describe("the Files window's model", () => {
  const e = (name: string, dir: boolean, size: number | null, modified: number | null): Entry => ({ name, dir, size, modified, hidden: false })
  const entries = [e("b.txt", false, 10, 3), e("Zeta", true, null, 1), e("a10.log", false, 30, 2), e("a2.png", false, 20, null), e("alpha", true, null, 5)]
  const kind = (x: Entry): string => kindLabel(x.name, x.dir, (k, v) => `${k}:${v?.["ext"] ?? ""}`)

  it("sorts by a column with folders always first, and reverses", () => {
    const names = (s: Sort): string[] => sortEntries(entries, s, kind).map((x) => x.name)
    expect(names({ key: "name", descending: false })).toEqual(["alpha", "Zeta", "a2.png", "a10.log", "b.txt"])
    expect(names({ key: "name", descending: true })).toEqual(["Zeta", "alpha", "b.txt", "a10.log", "a2.png"])
    expect(names({ key: "size", descending: true })).toEqual(["alpha", "Zeta", "a10.log", "a2.png", "b.txt"])
    expect(names({ key: "modified", descending: false })).toEqual(["Zeta", "alpha", "a10.log", "b.txt", "a2.png"])
    expect(names({ key: "modified", descending: true })).toEqual(["alpha", "Zeta", "b.txt", "a10.log", "a2.png"])
  })

  it("words dates as Finder does, at three widths", () => {
    // ICU puts a narrow no-break space before AM/PM in some versions; either reads the same.
    const label = (k: string, v?: Record<string, string>): string => `${k}|${Object.values(v ?? {}).join("|")}`.replace(/\u202f/g, " ")
    const now = new Date(2026, 9, 28, 15, 0).getTime()
    const today = finderDate(new Date(2026, 9, 28, 13, 33).getTime(), now, label, "en-US")
    expect(today.long).toBe("files.date.today|1:33 PM")
    expect(today.short).toBe("files.date.todayShort|")
    expect(finderDate(new Date(2026, 9, 27, 23, 59).getTime(), now, label, "en-US").long).toStartWith("files.date.yesterday|")
    const old = finderDate(new Date(2026, 9, 19, 14, 2).getTime(), now, label, "en-US")
    expect(old.long).toBe("files.date.other|Oct 19, 2026|2:02 PM")
    expect(old.short).toBe("10/19/26")
  })

  it("says why Windows would refuse a name", () => {
    expect(nameProblem("report.txt")).toBeNull()
    expect(nameProblem("")).toBe("empty")
    expect(nameProblem("a/b")).toBe("chars")
    expect(nameProblem("what?")).toBe("chars")
    expect(nameProblem("CON")).toBe("reserved")
    expect(nameProblem("nul.txt")).toBe("reserved")
    expect(nameProblem("trailing.")).toBe("ends")
    expect(nameProblem("space ")).toBe("ends")
  })

  it("knows when a folder would go inside itself", () => {
    expect(isWithin("C:\\Users\\me\\Desktop\\x", "C:\\Users\\me\\Desktop")).toBe(true)
    expect(isWithin("c:\\users\\ME\\desktop", "C:\\Users\\me\\Desktop\\")).toBe(true)
    expect(isWithin("C:\\Users\\me\\Desktop2", "C:\\Users\\me\\Desktop")).toBe(false)
    expect(samePath("C:\\", "c:")).toBe(true)
    expect(parentPath("C:\\Users\\me")).toBe("C:\\Users")
    expect(parentPath("C:\\Users")).toBe("C:\\")
  })

  it("gives each kind of file its glyph and words", () => {
    expect(kindOf("Setup.MSI", false)).toBe("installer")
    expect(kindOf("notes", false)).toBe("other")
    expect(kindOf("x.txt", true)).toBe("folder")
    expect(glyphOf("profile.ps1", false)).not.toBe(glyphOf("run.bat", false))
    expect(glyphOf("Projects", true)).toBe("\u{F4D3}")
    const label = (k: string, v?: Record<string, string>): string => `${k}:${v?.["ext"] ?? ""}`
    expect(kindLabel("a.png", false, label)).toBe("files.kind.image:PNG")
    expect(kindLabel("a.xyz", false, label)).toBe("files.kind.other:XYZ")
    expect(kindLabel("README", false, label)).toBe("files.kind.plain:")
  })
})

describe("the agent's answers", () => {
  const Path = z.object({ path: z.string() })

  it("reads a result, or why it failed by the agent's code", () => {
    expect(parseReply({ status: 200, body: { path: "C:\\x\\New folder" } }, Path)).toEqual({ ok: true, value: { path: "C:\\x\\New folder" } })
    expect(parseReply({ status: 409, body: { error: "already exists: C:\\x", code: "exists" } }, Path)).toEqual({
      ok: false,
      code: "exists",
      detail: "already exists: C:\\x",
    })
    expect(parseReply({ status: 400, body: { error: "odd", code: "weird" } }, Path)).toMatchObject({ ok: false, code: "other" })
    expect(parseReply({ status: 500, body: "boom" }, Path)).toEqual({ ok: false, code: "other", detail: "500 boom" })
    // A success that isn't the shape asked for is a failure, not a lie.
    expect(parseReply({ status: 200, body: { nope: 1 } }, Path)).toMatchObject({ ok: false, code: "other" })
  })

  it("tells a machine that isn't running from other ways of not reaching it", () => {
    expect(unreachable(new Error('::error::instance "x" is not running — `winvm start -i x`')).code).toBe("notrunning")
    expect(unreachable("connection refused").code).toBe("other")
  })
})
