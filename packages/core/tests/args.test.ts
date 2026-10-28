import { describe, expect, it } from "bun:test"

import { isValidImageName, isValidInstanceName, parseArgs } from "../src/args"

describe("parseArgs", () => {
  it("takes --key=value whole: empty, or starting with -, as markdown does", () => {
    const a = parseArgs(["note", "x", "--title=", "--text=- item\n- two", "--tags=a,b", "--json"])
    expect(a.flags.get("title")).toBe("")
    expect(a.flags.get("text")).toBe("- item\n- two")
    expect(a.flags.get("tags")).toBe("a,b")
    expect(a.flags.get("json")).toBe("true")
    expect(a.positional).toEqual(["note", "x"])
  })
  it("splits at the first = only", () => {
    expect(parseArgs(["--text=a=b"]).flags.get("text")).toBe("a=b")
  })
  it("takes a lone - as a flag's value: standard input", () => {
    const a = parseArgs(["note", "x", "--text", "-", "--json"])
    expect(a.flags.get("text")).toBe("-")
    expect(a.positional).toEqual(["note", "x"])
    // Anything else starting with - is still the next flag.
    expect(parseArgs(["--force", "-i", "dev"]).flags.get("force")).toBe("true")
  })
  it("leaves the two-word form, single-dash words and the -- passthrough alone", () => {
    const a = parseArgs(["--image", "foo", "--ephemeral", "-i", "dev", "key=value", "--", "--x=1"])
    expect(a.flags.get("image")).toBe("foo")
    expect(a.flags.get("ephemeral")).toBe("true")
    expect(a.flags.get("instance")).toBe("dev")
    expect(a.positional).toEqual(["key=value"])
    expect(a.rest).toEqual(["--x=1"])
    expect(a.flags.has("x")).toBe(false)
  })
})

describe("isValidImageName", () => {
  it("accepts plain names", () => {
    for (const n of ["win11-arm64", "win11-arm64-v2", "a", "img_1.2"]) expect(isValidImageName(n)).toBe(true)
  })
  it("rejects anything that could resolve outside its own directory", () => {
    for (const n of ["", ".", "..", "../images/win11-arm64", "a/b", "-x", ".hidden", "a b"]) {
      expect(isValidImageName(n)).toBe(false)
    }
  })
})

describe("isValidInstanceName", () => {
  it("takes a plain name for a new instance, as the app checks it", () => {
    for (const n of ["default", "polish-test", "demo_2", "a.b"]) expect(isValidInstanceName(n)).toBe(true)
    for (const n of ["", "-i", ".x", "a b", "a/b", "x".repeat(65)]) expect(isValidInstanceName(n)).toBe(false)
  })
})
