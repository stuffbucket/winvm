import { describe, expect, it } from "bun:test"

import { cliArgvFor, packageDirFor } from "../src/paths"

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
