import { describe, expect, it } from "bun:test"

import { childPath, clickSelect, crumbs, findByPrefix, formatBytes, freeName, isListing, leafName, parseListing } from "../ui/src/features/files/files"

const listing = {
  path: "C:\\Users\\me\\Desktop",
  parent: "C:\\Users\\me",
  entries: [
    { name: "Projects", dir: true, size: null, modified: 1_700_000_000_000, hidden: false },
    { name: "notes.txt", dir: false, size: 12_345, modified: null, hidden: false },
  ],
  total: 2,
  places: [{ kind: "desktop", name: "Desktop", path: "C:\\Users\\me\\Desktop" }],
}

describe("winvm dir --json", () => {
  it("reads a listing", () => {
    const l = parseListing(JSON.stringify(listing))
    expect(isListing(l)).toBe(true)
    expect(isListing(l) && l.entries[1]?.size).toBe(12_345)
  })

  it("reads why a folder didn't open, by the code the agent gave", () => {
    expect(parseListing(JSON.stringify({ error: "agent GET /fs/list: 403 access denied: C:\\x", code: "denied" }))).toEqual({
      code: "denied",
      detail: "agent GET /fs/list: 403 access denied: C:\\x",
    })
    expect(parseListing(JSON.stringify({ error: "boom", code: null }))).toEqual({ code: "other", detail: "boom" })
    expect(parseListing("", "::error::no agent")).toEqual({ code: "other", detail: "::error::no agent" })
  })
})

describe("Windows paths", () => {
  it("splits a path into crumbs, the drive's root first", () => {
    expect(crumbs("C:\\Users\\me")).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "me", path: "C:\\Users\\me" },
    ])
    expect(crumbs("C:\\")).toEqual([{ name: "C:", path: "C:\\" }])
  })

  it("names and joins", () => {
    expect(leafName("C:\\Users\\me\\Desktop")).toBe("Desktop")
    expect(leafName("C:\\")).toBe("C:")
    expect(childPath("C:\\", "work")).toBe("C:\\work")
    expect(childPath("C:\\work", "a.txt")).toBe("C:\\work\\a.txt")
  })

  it("picks a free name as Explorer does, ignoring case", () => {
    const taken = new Set(["report.txt", "Report (2).TXT", "Data"])
    expect(freeName("other.txt", taken)).toBe("other.txt")
    expect(freeName("REPORT.txt", taken)).toBe("REPORT (3).txt")
    expect(freeName("data", taken, true)).toBe("data (2)")
    expect(freeName(".profile", new Set([".profile"]))).toBe(".profile (2)")
  })
})

describe("display", () => {
  it("shows sizes in powers of 1000, as Finder does", () => {
    expect(formatBytes(812, "en-US")).toBe("812 bytes")
    expect(formatBytes(12_345, "en-US")).toBe("12 kB")
    expect(formatBytes(3_456_789, "en-US")).toBe("3.5 MB")
    expect(formatBytes(1_000, "en-US")).toBe("1 kB")
  })
})

describe("selection", () => {
  it("picks one on a click, toggles with ⌘, takes a range with ⇧", () => {
    const one = clickSelect(new Set(), null, 2, { toggle: false, range: false })
    expect([...one.selected]).toEqual([2])
    const toggled = clickSelect(one.selected, one.anchor, 4, { toggle: true, range: false })
    expect([...toggled.selected].sort()).toEqual([2, 4])
    const range = clickSelect(toggled.selected, 2, 5, { toggle: false, range: true })
    expect([...range.selected].sort()).toEqual([2, 3, 4, 5])
    expect(range.anchor).toBe(2)
    const back = clickSelect(range.selected, 2, 0, { toggle: false, range: true })
    expect([...back.selected].sort()).toEqual([0, 1, 2])
  })

  it("jumps to the next name starting with what was typed, wrapping", () => {
    const names = ["apple", "Banana", "berry", "cherry"]
    expect(findByPrefix(names, "b", 0)).toBe(1)
    expect(findByPrefix(names, "b", 2)).toBe(2)
    expect(findByPrefix(names, "a", 3)).toBe(0)
    expect(findByPrefix(names, "ber", 1)).toBe(2)
    expect(findByPrefix(names, "z", 0)).toBeNull()
  })
})
