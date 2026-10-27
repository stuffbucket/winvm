import { describe, expect, it } from "bun:test"

import { isValidImageName } from "../src/args"

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
