import { expect, it } from "bun:test"

import { encodingProblems } from "./check-text-encoding"

const reasons = (text: string) => encodingProblems(text).map((p) => p.reason)

it("accepts ordinary text, real ellipses, accents and emoji", () => {
  expect(reasons("Rename Window… café Ã â \u{1f600}\n")).toEqual([])
})

it("flags a C1 control character", () => {
  expect(reasons("a\u0080b")).toEqual(["C1 control character U+0080"])
  expect(reasons("a\u009fb")).toEqual(["C1 control character U+009F"])
})

it("flags the double-encoded ellipsis that UTF-8 read as Latin-1 leaves", () => {
  const mangled = Buffer.from("…", "utf8").toString("latin1")
  expect(encodingProblems(`Rename Window${mangled}`).length).toBeGreaterThan(0)
})

const a = String.fromCodePoint(0xe2)
const euro = String.fromCodePoint(0x20ac)
const tilde = String.fromCodePoint(0xc3)

it("flags the cp1252 spelling of a mangled punctuation mark", () => {
  expect(reasons(`it${a}${euro}s`)).toEqual([
    `double-encoded UTF-8 (${a}${euro})`,
  ])
})

it("flags a capital A-tilde followed by a Latin-1 continuation byte", () => {
  expect(reasons(`caf${tilde}${String.fromCodePoint(0xa9)}`)).toEqual([
    `double-encoded UTF-8 (${tilde} followed by U+00A9)`,
  ])
})

it("reports the line number", () => {
  expect(encodingProblems("ok\nok\nbad\u0085\n")[0]?.line).toBe(3)
})
