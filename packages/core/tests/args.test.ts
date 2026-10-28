import { describe, expect, it } from "bun:test"

import { isValidImageName, isValidInstanceName } from "../src/args"

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
