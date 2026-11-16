import { expect, it } from "bun:test"

import { decodeText, encodingProblems } from "./check-text-encoding"

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
    `double-encoded UTF-8 (${tilde}${String.fromCodePoint(0xa9)})`,
  ])
})

it("reports the line number", () => {
  expect(encodingProblems("ok\nok\nbad\u0085\n")[0]?.line).toBe(3)
})

const mangle = (text: string, encoding: "latin1" | "windows-1252"): string => {
  const bytes = Buffer.from(text, "utf8")
  return encoding === "latin1"
    ? bytes.toString("latin1")
    : new TextDecoder("windows-1252").decode(bytes)
}

const REAL = [
  "\u00a9",
  "\u2122",
  "\u2014",
  "\u00e9",
  "\u2026",
  "\u20ac",
  "\u201cquoted\u201d",
  "\u65e5\u672c",
  "\u{1f600}",
  "na\u00efve",
  "\u00c5ngstr\u00f6m",
  "\u2022 item",
]

it("flags any UTF-8 text read as Latin-1", () => {
  for (const real of REAL) {
    expect(encodingProblems(mangle(real, "latin1")).length).toBeGreaterThan(0)
  }
})

it("flags any UTF-8 text read as Windows-1252", () => {
  for (const real of REAL) {
    expect(
      encodingProblems(mangle(real, "windows-1252")).length,
    ).toBeGreaterThan(0)
  }
})

it("flags each named pattern", () => {
  for (const real of ["\u00a9", "\u2122", "\u2014", "\u00e9"]) {
    for (const encoding of ["latin1", "windows-1252"] as const) {
      expect(reasons(`x${mangle(real, encoding)}y`)).not.toEqual([])
    }
  }
})

it("names the mangled sequence in the reason", () => {
  expect(reasons(`x${mangle("\u2122", "windows-1252")}y`)).toEqual([
    `double-encoded UTF-8 (${mangle("\u2122", "windows-1252")})`,
  ])
  expect(reasons(`x${mangle("\u00a9", "latin1")}y`)).toEqual([
    `double-encoded UTF-8 (${mangle("\u00a9", "latin1")})`,
  ])
})

it("accepts legitimate text that merely contains the lead letters", () => {
  const good = [
    "\u00c3",
    "\u00c2ge",
    "\u00c3 la carte",
    "caf\u00e9",
    "na\u00efve",
    "\u00c5ngstr\u00f6m",
    "\u00c7a va",
    "ZO\u00cb \u2014 Mix",
    "\u00e9t\u00e9, \u00e0 la \u00ee le",
    "\u00a9 2026 \u2122 \u2014 \u201cok\u201d \u2026",
    "d\u00e9j\u00e0 vu\u2026",
  ]
  for (const text of good) expect(reasons(text)).toEqual([])
})

it("flags a Unicode replacement character left by an invalid byte", () => {
  expect(reasons("a\ufffdb")).toEqual(["replacement character U+FFFD"])
  expect(reasons(decodeText(new Uint8Array([0x61, 0xff, 0x62])))).toEqual([
    "replacement character U+FFFD",
  ])
})

it("decodes UTF-16 and BOM-marked UTF-8 instead of flagging them", () => {
  const text = "echo caf\u00e9 \u2014 \u2026\r\n"
  const le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text, "utf16le"),
  ])
  const be = Buffer.from(le)
  be.subarray(2).swap16()
  be[0] = 0xfe
  be[1] = 0xff
  const bom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(text),
  ])
  for (const bytes of [le, be, bom, Buffer.from(text)]) {
    expect(decodeText(bytes)).toBe(text)
    expect(encodingProblems(decodeText(bytes))).toEqual([])
  }
})
