import { afterEach, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { agentBunVersion } from "../src/media"
import { PACKAGE_DIR, bunVersionWarning, cliEntry, pinnedBunVersion, recordCliEntry } from "../src/paths"

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

it("records the CLI actually running, over one inherited from a parent", () => {
  process.env["WINVM_CLI"] = "/stale/checkout/apps/cli/src/winvm.ts"
  recordCliEntry("/this/checkout/apps/cli/src/winvm.ts")
  expect(cliEntry()).toBe("/this/checkout/apps/cli/src/winvm.ts")
})

it("reads the checkout's Bun pin from .bun-version", () => {
  const file = resolve(PACKAGE_DIR, "..", "..", ".bun-version")
  expect(pinnedBunVersion()).toBe(readFileSync(file, "utf8").trim())
})

it("gives guest agents the pinned Bun, whatever Bun the host command runs on", () => {
  expect(agentBunVersion()).toBe(pinnedBunVersion() ?? Bun.version)
})

it("warns when the CLI runs on a Bun other than the pin, and says how to get the pin", () => {
  const w = bunVersionWarning("1.3.14", "1.4.3")
  expect(w).toContain("1.3.14")
  expect(w).toContain("1.4.3")
  expect(w).toContain("mise exec")
  expect(bunVersionWarning("1.4.3", "1.4.3")).toBeNull()
  expect(bunVersionWarning("1.3.14", null)).toBeNull()
})
