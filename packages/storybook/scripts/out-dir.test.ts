import { afterAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { entriesOf, MARKER, prepareOut, refusal, resolveOut } from "./out-dir"

const guarded = {
  home: "/Users/you",
  repo: "/Users/you/src/winvm",
  storybook: "/Users/you/src/winvm/packages/storybook",
}

const scratch = mkdtempSync(join(tmpdir(), "shots-out-"))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe("resolveOut", () => {
  it("resolves a relative path against where the command was run", () => {
    expect(resolveOut("review", "/Users/you/src/winvm")).toBe(
      "/Users/you/src/winvm/review",
    )
  })

  it("keeps an absolute path", () => {
    expect(resolveOut("/tmp/shots/", "/elsewhere")).toBe("/tmp/shots")
  })
})

describe("refusal", () => {
  it("refuses a filesystem root", () => {
    expect(refusal("/", guarded, null)).toContain("filesystem root")
  })

  it("refuses the home, repository and package directories", () => {
    for (const path of Object.values(guarded))
      expect(refusal(path, guarded, null)).not.toBeNull()
  })

  it("refuses any directory that contains a guarded one", () => {
    expect(refusal("/Users", guarded, null)).toContain("home")
    expect(refusal("/Users/you/src", guarded, null)).toContain("repo")
  })

  it("accepts a missing directory inside the repository", () => {
    expect(
      refusal("/Users/you/src/winvm/packages/storybook/shots", guarded, null),
    ).toBeNull()
  })

  it("accepts an empty directory and one holding only earlier output", () => {
    expect(refusal("/tmp/a", guarded, [])).toBeNull()
    expect(
      refusal("/tmp/a", guarded, ["light", "dark", "index.html", "index.md"]),
    ).toBeNull()
  })

  it("accepts a directory carrying the marker whatever else it holds", () => {
    expect(refusal("/tmp/a", guarded, [MARKER, "notes.txt"])).toBeNull()
  })

  it("refuses a directory holding anything else", () => {
    expect(refusal("/tmp/a", guarded, ["light", "notes.txt"])).toContain(
      "notes.txt",
    )
  })

  it("refuses a path that is a file", () => {
    const file = join(scratch, "file.png")
    writeFileSync(file, "")
    expect(refusal(file, guarded, entriesOf(file))).toContain("not a directory")
  })
})

describe("prepareOut", () => {
  const out = join(scratch, "out")
  const seed = (): void => {
    for (const dir of ["light", "dark", "keep"])
      mkdirSync(join(out, dir), { recursive: true })
    for (const file of ["index.html", "index.md", "light/a.png", "keep/b"])
      writeFileSync(join(out, file), "")
  }

  it("removes only what an earlier run wrote, and leaves its marker", () => {
    seed()
    prepareOut(out, true)
    expect(entriesOf(out)?.sort()).toEqual([MARKER, "keep"])
    expect(existsSync(join(out, "keep", "b"))).toBe(true)
  })

  it("keeps earlier screenshots when only some stories are taken", () => {
    seed()
    prepareOut(out, false)
    expect(existsSync(join(out, "light", "a.png"))).toBe(true)
    expect(existsSync(join(out, "index.md"))).toBe(false)
  })
})
