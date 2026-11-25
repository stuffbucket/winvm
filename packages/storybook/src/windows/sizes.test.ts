import { expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { mainSize, specSize } from "./sizes"

const TAURI = join(import.meta.dir, "../../../../apps/viewer/src-tauri")

it("reads the main window's size from tauri.conf.json", () => {
  const config = JSON.parse(
    readFileSync(join(TAURI, "tauri.conf.json"), "utf8"),
  ) as Parameters<typeof mainSize>[0]
  const size = mainSize(config)
  expect(size.width).toBeGreaterThan(0)
  expect(size.height).toBeGreaterThan(0)
})

it("reads the Files and Terminal sizes from windows.rs", () => {
  const source = readFileSync(join(TAURI, "src/windows.rs"), "utf8")
  for (const name of ["FILES", "TERMINAL"]) {
    const size = specSize(source, name)
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)
  }
  expect(() => specSize(source, "NOPE")).toThrow("NOPE")
})
