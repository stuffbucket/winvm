import { expect, it } from "bun:test"

import {
  countMagic,
  cssFiles,
  inventoryMagic,
  magicHits,
} from "../scripts/check-design-tokens"

const hits = (css: string) => magicHits("a.css", css)
const count = (css: string) => countMagic(hits(css))

it("counts non-zero px, durations and bare z-index values", () => {
  expect(
    count(
      ".a { padding: 4px 0px; transition: opacity 150ms, color 0.2s; z-index: 5 }",
    ),
  ).toEqual({ px: 1, ms: 2, z: 1 })
})

it("ignores zero values, tokens and var() z-index", () => {
  expect(
    count(
      ".a { margin: 0px; padding: var(--space-2); transition: all var(--dur-2s); z-index: var(--z-modal); z-index: 0 }",
    ),
  ).toEqual({ px: 0, ms: 0, z: 0 })
})

it("counts at-rule preludes while skipping comments, urls and strings", () => {
  expect(
    count(
      '@media (min-width: 600px) { .a { color: red } } .b { /* 5px 20ms */ background: url("x-3px.png"); content: "4px" }',
    ),
  ).toEqual({ px: 1, ms: 0, z: 0 })
})

it("counts declarations inside media, keyframes and nested rules", () => {
  expect(
    count(
      "@media (min-width: 600px) { .a { width: 10px } } @keyframes k { 50% { transform: translateX(3px) } } .panel { padding: 37px; & .child { inset: 2px } margin: 4px }",
    ),
  ).toEqual({ px: 6, ms: 0, z: 0 })
})

it("counts fractional and signed values once each", () => {
  expect(
    count(".a { top: 1.5px; margin: -2px; animation-delay: -1s }"),
  ).toEqual({ px: 2, ms: 1, z: 0 })
})

it("treats CSS units and property names case-insensitively", () => {
  expect(
    count(".a { width: 37PX; transition-duration: 250MS; Z-INDEX: 99 }"),
  ).toEqual({ px: 1, ms: 1, z: 1 })
})

it("reports the line of each hit", () => {
  const found = hits(".a {\n  width: 3px;\n  z-index: 2;\n}\n")
  expect(found.map((hit) => [hit.line, hit.kind])).toEqual([
    [2, "px"],
    [3, "z"],
  ])
})

it("inventories normalized values instead of only aggregate counts", () => {
  expect(
    inventoryMagic(
      hits(".a { width: 24px; margin: -24PX; transition: 150MS; z-index: 3 }"),
    ),
  ).toEqual({
    px: { "24px": 1, "-24px": 1 },
    ms: { "150ms": 1 },
    z: { "3": 1 },
  })
})

it("globs the viewer, canvas and Storybook css without the token file", () => {
  const files = cssFiles()
  expect(files).toContain("ui/src/styles/styles.css")
  expect(files).toContain("../../packages/canvas/src/canvas.css")
  expect(files).toContain("../../packages/storybook/src/storybook.css")
  expect(files).not.toContain("ui/src/styles/tokens.css")
})
