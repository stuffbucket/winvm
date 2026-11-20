import { expect, it } from "bun:test"

import {
  compare,
  type Measurements,
  oxlintCount,
  parseBaseline,
  parseCssInventory,
} from "./check-magic-numbers"

const base: Measurements = {
  ts: 10,
  css: {
    px: { "24px": 5 },
    ms: { "150ms": 4 },
    z: { "3": 3 },
  },
}

it("passes when every value count matches the baseline", () => {
  expect(compare(base, base)).toEqual({ increased: [], decreased: [] })
})

it("fails on any value count that went up", () => {
  const result = compare(
    {
      ts: 11,
      css: {
        px: { "24px": 5 },
        ms: { "150ms": 4 },
        z: { "3": 3, "99": 1 },
      },
    },
    base,
  )
  expect(result.increased).toEqual([
    "ts 11 (baseline 10)",
    "css.z.99 1 (baseline 0)",
  ])
  expect(result.decreased).toEqual([])
})

it("reports value counts that fell without failing", () => {
  const result = compare(
    {
      ts: 9,
      css: { px: { "24px": 5 }, ms: { "150ms": 1 }, z: { "3": 3 } },
    },
    base,
  )
  expect(result.increased).toEqual([])
  expect(result.decreased).toEqual([
    "ts 9 (baseline 10)",
    "css.ms.150ms 1 (baseline 4)",
  ])
})

it("rejects a new value when the aggregate category count stays flat", () => {
  const result = compare(
    {
      ts: 10,
      css: { px: { "913px": 5 }, ms: { "150ms": 4 }, z: { "3": 3 } },
    },
    base,
  )
  expect(result.increased).toEqual(["css.px.913px 5 (baseline 0)"])
  expect(result.decreased).toEqual(["css.px.24px 0 (baseline 5)"])
})

it("counts oxlint diagnostics", () => {
  expect(oxlintCount('{"diagnostics":[{},{},{}]}')).toBe(3)
  expect(oxlintCount('{"diagnostics":[]}')).toBe(0)
  expect(() => oxlintCount("{}")).toThrow("diagnostics")
})

it("reads the last line of the css inventory output", () => {
  expect(
    parseCssInventory(
      'noise\n{"px":{"24px":1},"ms":{"150ms":2},"z":{"3":3}}\n',
    ),
  ).toEqual({ px: { "24px": 1 }, ms: { "150ms": 2 }, z: { "3": 3 } })
  expect(() => parseCssInventory('{"px":{}}')).toThrow("css.ms")
})

it("rejects a baseline with a bad count", () => {
  expect(parseBaseline(JSON.stringify(base))).toEqual(base)
  expect(() =>
    parseBaseline(
      JSON.stringify({
        ts: 0,
        css: { px: { "24px": -1 }, ms: {}, z: {} },
      }),
    ),
  ).toThrow("non-integer")
})
