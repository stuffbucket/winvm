import { expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { iconNames } from "./icons"

const source = readFileSync(
  join(import.meta.dir, "../../../apps/viewer/ui/src/components/Icon.tsx"),
  "utf8",
)

it("reads every icon name from Icon.tsx, each with a drawing", () => {
  const names = iconNames(source)
  expect(names.length).toBeGreaterThan(0)
  const paths = source.slice(source.indexOf("const PATHS"))
  const drawn = [...paths.matchAll(/^ {2}([A-Za-z]+):/gm)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined)
  expect([...names].sort()).toEqual([...drawn].sort())
})

it("fails loudly when the union is missing", () => {
  expect(() => iconNames("export const x = 1")).toThrow("IconName")
})
