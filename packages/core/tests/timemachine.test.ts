import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { media, PACKAGE_DIR } from "../src/paths"
import { localSummary, targets } from "../src/timemachine"

let tmp = ""
let saved: string | undefined

beforeEach(() => {
  saved = process.env.WINVM_HOME
  tmp = mkdtempSync(resolve(tmpdir(), "winvm-tm-"))
  process.env.WINVM_HOME = resolve(tmp, "home")
  mkdirSync(resolve(tmp, "home", "media"), { recursive: true })
  mkdirSync(resolve(tmp, "isos"))
  writeFileSync(resolve(tmp, "isos", "win.iso"), "")
  symlinkSync(resolve(tmp, "isos", "win.iso"), media.iso())
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (saved === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = saved
})

describe("Time Machine targets", () => {
  it("includes the folder the ISO lives in", () => {
    expect(targets().map((p) => p.replace(/^\/private/, ""))).toEqual(
      [resolve(tmp, "home"), resolve(tmp, "isos")].map((p) =>
        p.replace(/^\/private/, ""),
      ),
    )
  })

  it("skips the ISO's folder when macOS will not let winvm resolve it, instead of failing", () => {
    const denied = (): string => {
      throw Object.assign(
        new Error("EPERM: operation not permitted, realpath"),
        { code: "EPERM" },
      )
    }
    expect(targets({ realpath: denied })).toEqual([resolve(tmp, "home")])
  })
})

describe("the Time Machine line a status read prints", () => {
  const inHome = (p: string): boolean =>
    p === resolve(tmp, "home") || p.startsWith(`${resolve(tmp, "home")}/`)

  it("looks only inside winvm's home, and never follows the ISO's link to the volume it points at", () => {
    const touched: string[] = []
    const line = localSummary({
      exists: (p) => {
        touched.push(p)
        return existsSync(p)
      },
      realpath: (p) => {
        touched.push(p)
        return p
      },
      excluded: (p) => {
        touched.push(p)
        return true
      },
    })
    expect(line).toStartWith("ok")
    expect(touched).toContain(resolve(tmp, "home"))
    expect(touched.filter((p) => !inHome(p) || p === media.iso())).toEqual([])
  })

  it("is what winvm status prints, and the status never asks about anything outside winvm's home", () => {
    const bin = resolve(tmp, "bin")
    mkdirSync(bin)
    const log = resolve(tmp, "xattr.log")
    writeFileSync(
      resolve(bin, "xattr"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
    )
    chmodSync(resolve(bin, "xattr"), 0o755)
    const cli = resolve(
      PACKAGE_DIR,
      "..",
      "..",
      "apps",
      "cli",
      "src",
      "winvm.ts",
    )
    for (const args of [["status", "--json"], ["status"]]) {
      const r = spawnSync(process.execPath, [cli, ...args], {
        env: {
          ...process.env,
          WINVM_HOME: resolve(tmp, "home"),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 30_000,
      })
      expect(r.status).toBe(0)
    }
    const asked = readFileSync(log, "utf8")
    expect(asked).toContain(resolve(tmp, "home"))
    expect(asked).not.toContain(resolve(tmp, "isos"))
  }, 60_000)
})
