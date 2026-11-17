import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import { readNote, writeNote } from "../src/notes"
import { withOperation } from "../src/operation"
import { pathsFor } from "../src/paths"
import { savesCmd } from "../src/savecmds"
import {
  createSave,
  FILES,
  parseManifest,
  readSave,
  removeAllSaves,
  removeSave,
  saveDir,
  setSaveProtection,
} from "../src/saves"
import { realActions } from "../src/watch"

const ENV = ["WINVM_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const
let before: Record<string, string | undefined> = {}
let dir = ""
let output: string[] = []
let errors: string[] = []

beforeEach(() => {
  before = Object.fromEntries(ENV.map((v) => [v, process.env[v]]))
  dir = mkdtempSync(resolve(tmpdir(), "winvm-protection-"))
  process.env.WINVM_HOME = resolve(dir, "state")
  process.env.XDG_DATA_HOME = resolve(dir, "data")
  process.env.XDG_CONFIG_HOME = resolve(dir, "config")
  output = []
  errors = []
  spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    output.push(a.map(String).join(" "))
  })
  spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "))
  })
})
afterEach(() => {
  for (const v of ENV) {
    if (before[v] === undefined) delete process.env[v]
    else process.env[v] = before[v]
  }
  rmSync(dir, { recursive: true, force: true })
  mock.restore()
})

const file = (name: string): string =>
  resolve(saveDir("dev", name), FILES.manifest)
function make(name = "clean", extra: Record<string, unknown> = {}): void {
  mkdirSync(saveDir("dev", name), { recursive: true })
  writeFileSync(
    file(name),
    JSON.stringify({
      name,
      instance: "dev",
      kind: "manual",
      createdAt: "2026-10-28T10:00:00.000Z",
      bytes: 42,
      compat: "abc",
      image: "win11-arm64",
      format: "mapped",
      ramFile: FILES.ramMapped,
      custom: { futureField: true },
      ...extra,
    }),
  )
  writeFileSync(
    resolve(saveDir("dev", name), FILES.ramMapped),
    "untouched state",
  )
}
function makeInstance(): void {
  mkdirSync(pathsFor("dev").dir, { recursive: true })
  writeFileSync(
    pathsFor("dev").meta,
    JSON.stringify({
      image: "win11-arm64",
      vnc: 9,
      created: "2026-10-28T10:00:00.000Z",
    }),
  )
}
const cli = async (...argv: string[]): Promise<number> =>
  await savesCmd(parseArgs(["-i", "dev", ...argv]))

describe("snapshot protection", () => {
  it("locks/unlocks stopped snapshots atomically, retaining compatibility, files, notes and unknown metadata", async () => {
    make()
    writeNote("dev", "clean", { title: "Clean", text: "keep this" })
    const old = parseManifest(readFileSync(file("clean"), "utf8"))
    expect(await setSaveProtection("dev", "clean", true)).toEqual({
      ...old,
      protected: true,
    })
    expect(readSave("dev", "clean")?.protected).toBe(true)
    expect(
      readFileSync(resolve(saveDir("dev", "clean"), FILES.ramMapped), "utf8"),
    ).toBe("untouched state")
    expect(readNote("dev", "clean")?.text).toBe("keep this")
    expect(await setSaveProtection("dev", "clean", false)).toEqual({
      ...old,
      protected: false,
    })
    expect(existsSync(`${file("clean")}.tmp-${String(process.pid)}`)).toBe(
      false,
    )
  })

  it("rejects one-shot stow protection, but permits clearing it on an externally protected stow", async () => {
    make("stow", { kind: "stow" })
    await expect(setSaveProtection("dev", "stow", true)).rejects.toThrow(
      /one-shot/,
    )
    make("stow", { kind: "stow", protected: true })
    expect((await setSaveProtection("dev", "stow", false)).protected).toBe(
      false,
    )
  })

  it("does not replace a protected snapshot even with the save readiness override", async () => {
    make("clean", { protected: true })
    await expect(
      createSave("dev", { name: "clean", kind: "manual" }),
    ).rejects.toThrow(/protected/)
    expect(readSave("dev", "clean")?.protected).toBe(true)
    expect(
      readFileSync(resolve(saveDir("dev", "clean"), FILES.ramMapped), "utf8"),
    ).toBe("untouched state")
  })

  it("manual deletion requires unprotecting or explicit --force, retaining notes on refusal", async () => {
    make("clean", { protected: true })
    writeNote("dev", "clean", { title: "Kept" })
    expect(await cli("rm", "clean")).toBe(1)
    expect(errors.join("\n")).toContain("--force")
    expect(readNote("dev", "clean")?.title).toBe("Kept")
    expect(await cli("rm", "clean", "--force")).toBe(0)
    expect(readSave("dev", "clean")).toBeNull()
    expect(readNote("dev", "clean")).toBeNull()
  })

  it("the CLI lists and changes protection, then allows ordinary deletion", async () => {
    make()
    expect(await cli("protect", "clean", "--json")).toBe(0)
    expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
      protected: true,
      compat: "abc",
      format: "mapped",
    })
    expect(await cli()).toBe(0)
    expect(output.join("\n")).toContain("PROTECTED")
    expect(await cli("--json")).toBe(0)
    expect((JSON.parse(output.pop() ?? "null") as unknown[])[0]).toMatchObject({
      protected: true,
    })
    expect(await cli("unprotect", "clean")).toBe(0)
    expect(await cli("rm", "clean")).toBe(0)
  })

  it("will not bulk-delete any files or notes when one snapshot is protected", () => {
    make("a")
    make("b", { protected: true })
    writeNote("dev", "a", { title: "A" })
    expect(() => {
      removeAllSaves("dev")
    }).toThrow(/protected/)
    expect(readSave("dev", "a")).not.toBeNull()
    expect(readSave("dev", "b")).not.toBeNull()
    expect(readNote("dev", "a")?.title).toBe("A")
  })

  it("fails closed on damaged manifests; only explicit forced deletion removes them", async () => {
    make()
    writeFileSync(file("clean"), '{"protected":true')
    expect(() => {
      removeSave("dev", "clean")
    }).toThrow()
    expect(() => {
      removeAllSaves("dev")
    }).toThrow()
    expect(await cli("rm", "clean")).toBe(1)
    expect(await cli("rm", "clean", "--force")).toBe(0)
  })

  it("refuses protect/unprotect while another command holds the instance", async () => {
    makeInstance()
    make()
    let release: () => void = () => undefined
    const held = withOperation("dev", "load", async () => {
      await new Promise<void>((r) => {
        release = r
      })
    })
    await new Promise((r) => setTimeout(r, 20))
    try {
      expect(await cli("protect", "clean")).toBe(1)
      expect(errors.join("\n")).toContain("busy")
      expect(readSave("dev", "clean")?.protected).toBeUndefined()
    } finally {
      release()
      await held
    }
    expect(await cli("protect", "clean")).toBe(0)
    expect(readSave("dev", "clean")?.protected).toBe(true)
    expect(existsSync(pathsFor("dev").lease)).toBe(false)
  })

  it("rotation rechecks sampled victims under the lease, retaining newly protected/replaced/damaged saves", async () => {
    make("locked", { kind: "auto" })
    make("replaced", { kind: "manual" })
    make("damaged", { kind: "auto" })
    make("victim", { kind: "auto" })
    await setSaveProtection("dev", "locked", true)
    writeFileSync(file("damaged"), "broken")
    const actions = realActions("dev", pathsFor("dev"), () => undefined)
    expect(
      await actions.deleteSaves(["locked", "replaced", "damaged", "victim"]),
    ).toBe(true)
    expect(readSave("dev", "locked")?.protected).toBe(true)
    expect(readSave("dev", "replaced")?.kind).toBe("manual")
    expect(existsSync(file("damaged"))).toBe(true)
    expect(existsSync(file("victim"))).toBe(false)
  })

  it("rejects missing and path-shaped protection/deletion targets", async () => {
    expect(await cli("protect")).toBe(1)
    expect(await cli("unprotect", "missing")).toBe(1)
    expect(await cli("rm", "../escape", "--force")).toBe(1)
    expect(await cli("protect", "../escape")).toBe(1)
  })
})
