import { afterEach, describe, expect, it } from "bun:test"

import { buildIdentity, selectBuildIdentity } from "../src/identity"
import { cliArgvFor, packageDirFor, recordCliEntry } from "../src/paths"

describe("running from source or compiled into the app", () => {
  it("finds the package's data files in the source tree, the app's Resources, or where WINVM_PACKAGE_DIR says", () => {
    expect(packageDirFor({ modulePath: "/repo/packages/core/src/paths.ts", execPath: "/opt/bun", env: {} })).toBe("/repo/packages/core")
    expect(
      packageDirFor({ modulePath: "/$bunfs/root/winvm", execPath: "/Applications/winvm.app/Contents/MacOS/winvm", env: {} }),
    ).toBe("/Applications/winvm.app/Contents/Resources/winvm/packages/core")
    expect(
      packageDirFor({ modulePath: "/$bunfs/root/winvm", execPath: "/x/winvm", env: { WINVM_PACKAGE_DIR: "/data/core" } }),
    ).toBe("/data/core")
  })

  it("starts the CLI again by its script when run from source, and as itself when compiled", () => {
    expect(cliArgvFor({ compiled: false, entry: "/repo/apps/cli/src/winvm.ts" }, ["serve", "-i", "a"])).toEqual([
      "/repo/apps/cli/src/winvm.ts",
      "serve",
      "-i",
      "a",
    ])
    expect(cliArgvFor({ compiled: true, entry: "/Applications/winvm.app/Contents/MacOS/winvm" }, ["serve", "-i", "a"])).toEqual([
      "serve",
      "-i",
      "a",
    ])
  })
})

describe("a compiled sidecar's generation", () => {
  const saved = { cli: process.env["WINVM_CLI"], id: process.env["WINVM_BUILD_ID"] }
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  afterEach(() => {
    restore("WINVM_CLI", saved.cli)
    restore("WINVM_BUILD_ID", saved.id)
  })

  it("is the embedded identity when there is one, so no runtime file lookup is needed", () => {
    const embedded = `sha256:${"cd".repeat(32)}`
    const source = (): string => {
      throw new Error("a compiled sidecar must not hash source files")
    }
    expect(selectBuildIdentity({ embedded, env: "sha256:stale-parent", source })).toBe(embedded)
  })

  it("is exported with the compiled executable's own path for detached descendants", () => {
    recordCliEntry("/$bunfs/root/winvm")
    expect(process.env["WINVM_CLI"]).toBe(process.execPath)
    expect(process.env["WINVM_BUILD_ID"]).toBe(buildIdentity())
    expect(buildIdentity()).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
