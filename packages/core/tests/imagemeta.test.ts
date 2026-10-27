import { describe, expect, it } from "bun:test"

import { newImageMeta } from "../src/paths"

describe("image metadata", () => {
  it("records what a base image was built from", () => {
    expect(
      newImageMeta({
        virtioBoot: true,
        created: "2026-10-27T00:00:00.000Z",
        runtime: "11.1.2-1",
        isoSha256: "a".repeat(64),
        guestToolsSha256: "b".repeat(64),
      }),
    ).toEqual({
      virtioBoot: true,
      created: "2026-10-27T00:00:00.000Z",
      runtime: "11.1.2-1",
      isoSha256: "a".repeat(64),
      guestToolsSha256: "b".repeat(64),
    })
  })
})
