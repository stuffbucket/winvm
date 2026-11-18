import { expect, it } from "bun:test"

import {
  type Counts,
  compare,
  oxlintCount,
  parseBaseline,
  parseCssCounts,
} from "./check-magic-numbers"

const base: Counts = { ts: 10, css: { px: 5, ms: 4, z: 3 } }

it("passes when every count matches the baseline", () => {
  expect(compare(base, base)).toEqual({ increased: [], decreased: [] })
})

it("fails on any count that went up", () => {
  const result = compare({ ts: 11, css: { px: 5, ms: 4, z: 4 } }, base)
  expect(result.increased).toEqual([
    "ts 11 (baseline 10)",
    "css.z 4 (baseline 3)",
  ])
  expect(result.decreased).toEqual([])
})

it("reports counts that fell without failing", () => {
  const result = compare({ ts: 9, css: { px: 5, ms: 1, z: 3 } }, base)
  expect(result.increased).toEqual([])
  expect(result.decreased).toEqual([
    "ts 9 (baseline 10)",
    "css.ms 1 (baseline 4)",
  ])
})

it("lets one count fall while another rises", () => {
  const result = compare({ ts: 9, css: { px: 6, ms: 4, z: 3 } }, base)
  expect(result.increased).toEqual(["css.px 6 (baseline 5)"])
  expect(result.decreased).toEqual(["ts 9 (baseline 10)"])
})

it("counts oxlint diagnostics", () => {
  expect(oxlintCount('{"diagnostics":[{},{},{}]}')).toBe(3)
  expect(oxlintCount('{"diagnostics":[]}')).toBe(0)
  expect(() => oxlintCount("{}")).toThrow("diagnostics")
})

it("reads the last line of the css count output", () => {
  expect(parseCssCounts('noise\n{"px":1,"ms":2,"z":3}\n')).toEqual({
    px: 1,
    ms: 2,
    z: 3,
  })
  expect(() => parseCssCounts('{"px":1}')).toThrow("missing")
})

it("rejects a baseline with a bad count", () => {
  expect(parseBaseline(JSON.stringify(base))).toEqual(base)
  expect(() =>
    parseBaseline(JSON.stringify({ ts: -1, css: { px: 0, ms: 0, z: 0 } })),
  ).toThrow("non-integer")
})
