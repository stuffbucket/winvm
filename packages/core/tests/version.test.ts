import { describe, expect, it } from "bun:test"

import pin from "../runtime.json"
import { versionReport } from "../src/commands"
import { buildIdentity, releaseVersion } from "../src/identity"

describe("winvm version", () => {
  it("reports the release version, this build's identity and the pinned Windows runtime", () => {
    const report = versionReport()
    expect(report).toEqual({
      version: releaseVersion(),
      build: buildIdentity(),
      runtime: pin.version,
    })
    expect(report.build).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
