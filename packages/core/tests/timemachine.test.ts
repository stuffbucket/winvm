import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { media } from "../src/paths"
import { targets } from "../src/timemachine"

let tmp = ""
let saved: string | undefined

beforeEach(() => {
  saved = process.env["WINVM_HOME"]
  tmp = mkdtempSync(resolve(tmpdir(), "winvm-tm-"))
  process.env["WINVM_HOME"] = resolve(tmp, "home")
  mkdirSync(resolve(tmp, "home", "media"), { recursive: true })
  mkdirSync(resolve(tmp, "isos"))
  writeFileSync(resolve(tmp, "isos", "win.iso"), "")
  symlinkSync(resolve(tmp, "isos", "win.iso"), media.iso())
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (saved === undefined) delete process.env["WINVM_HOME"]
  else process.env["WINVM_HOME"] = saved
})

describe("Time Machine targets", () => {
  it("includes the folder the ISO lives in", () => {
    expect(targets().map((p) => p.replace(/^\/private/, ""))).toEqual([resolve(tmp, "home"), resolve(tmp, "isos")].map((p) => p.replace(/^\/private/, "")))
  })

  it("skips the ISO's folder when macOS will not let winvm resolve it, instead of failing", () => {
    const denied = (): string => {
      throw Object.assign(new Error("EPERM: operation not permitted, realpath"), { code: "EPERM" })
    }
    expect(targets({ realpath: denied })).toEqual([resolve(tmp, "home")])
  })
})
