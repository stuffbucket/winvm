import { expect, it } from "bun:test"

import { countMagic, cssFiles, magicHits } from "../scripts/check-design-tokens"

const count = (css: string) => countMagic(magicHits("a.css", css))

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

it("skips media preludes, comments, urls and strings", () => {
  expect(
    count(
      '@media (min-width: 600px) { .a { color: red } } .b { /* 5px 20ms */ background: url("x-3px.png"); content: "4px" }',
    ),
  ).toEqual({ px: 0, ms: 0, z: 0 })
})

it("counts declarations inside media and keyframes bodies", () => {
  expect(
    count(
      "@media (min-width: 600px) { .a { width: 10px } } @keyframes k { 50% { transform: translateX(3px) } }",
    ),
  ).toEqual({ px: 2, ms: 0, z: 0 })
})

it("counts fractional and signed values once each", () => {
  expect(
    count(".a { top: 1.5px; margin: -2px; animation-delay: -1s }"),
  ).toEqual({ px: 2, ms: 1, z: 0 })
})

it("reports the line of each hit", () => {
  const hits = magicHits("a.css", ".a {\n  width: 3px;\n  z-index: 2;\n}\n")
  expect(hits.map((hit) => [hit.line, hit.kind])).toEqual([
    [2, "px"],
    [3, "z"],
  ])
})

it("globs the viewer and canvas css without the token file", () => {
  const files = cssFiles()
  expect(files).toContain("ui/src/styles/styles.css")
  expect(files).toContain("../../packages/canvas/src/canvas.css")
  expect(files).not.toContain("ui/src/styles/tokens.css")
})
