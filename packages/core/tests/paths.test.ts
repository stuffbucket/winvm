import { afterEach, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { PACKAGE_DIR, cliEntry } from "../src/paths"

const saved = process.env["WINVM_CLI"]
afterEach(() => {
  if (saved === undefined) delete process.env["WINVM_CLI"]
  else process.env["WINVM_CLI"] = saved
})

it("finds the package's own files from any working directory", () => {
  for (const d of ["assets", "firmware", "web"]) expect(existsSync(resolve(PACKAGE_DIR, d))).toBe(true)
})

it("spawns the CLI it was started through", () => {
  process.env["WINVM_CLI"] = "/x/apps/cli/src/winvm.ts"
  expect(cliEntry()).toBe("/x/apps/cli/src/winvm.ts")
})

it("says how to start winvm when it does not know its CLI", () => {
  delete process.env["WINVM_CLI"]
  expect(() => cliEntry()).toThrow("WINVM_CLI is not set: start winvm through apps/cli")
})
