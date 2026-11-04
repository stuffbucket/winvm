import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parseFlat, policyProblems } from "./preflight-signing"

const CONFIG = readFileSync(resolve(import.meta.dir, "..", ".macos-builder", "config"), "utf8")
const nested = parseFlat(CONFIG).sign_nested ?? ""

/** The policy the builder would hold for this config. */
const policy = (over: Record<string, string> = {}): string =>
  Object.entries({
    bundle_id_allowed: "co.stuffbucket.winvm",
    entitlements_allowed: "default,bun-runtime,qemu-hvf",
    artifact_allowed: "dmg,updater",
    volname_allowed: "winvm",
    app_path_allowed: "apps/viewer/src-tauri/target/release/bundle/macos/winvm.app",
    sign_nested_allowed: nested,
    updater_key_id: "winvm",
    ...over,
  })
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n")

describe("policyProblems", () => {
  it("accepts the repository's config under a policy that lists exactly its files", () => {
    expect(nested.split(",").length).toBeGreaterThan(20)
    expect(policyProblems(CONFIG, policy())).toEqual([])
  })

  it("names the Mach-O files the policy lacks (the v0.1.3 refusal)", () => {
    const old = nested
      .split(",")
      .filter((e) => !e.includes("virtiofsd") && !e.includes("libjpeg"))
      .join(",")
    const problems = policyProblems(CONFIG, policy({ sign_nested_allowed: old }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("virtiofsd:default")
    expect(problems[0]).toContain("libjpeg.8.dylib:default")
    expect(problems[0]).toContain("in the policy only: (none)")
  })

  it("names entries the policy has and the config dropped", () => {
    const problems = policyProblems(CONFIG, policy({ sign_nested_allowed: `${nested},Contents/Resources/runtime/bin/gone:default` }))
    expect(problems[0]).toContain("in the policy only: Contents/Resources/runtime/bin/gone:default")
  })

  it("requires the same order, as the builder compares the strings", () => {
    const reversed = nested.split(",").reverse().join(",")
    expect(policyProblems(CONFIG, policy({ sign_nested_allowed: reversed }))[0]).toContain("different order")
  })

  it("checks the other fields the builder gates on", () => {
    const problems = policyProblems(CONFIG, policy({ bundle_id_allowed: "x.y", artifact_allowed: "dmg", entitlements_allowed: "default", volname_allowed: "other" }))
    expect(problems.join("\n")).toContain("bundle_id")
    expect(problems.join("\n")).toContain("artifact 'updater'")
    expect(problems.join("\n")).toContain("entitlements 'bun-runtime'")
    expect(problems.join("\n")).toContain("volname")
  })
})

describe("parseFlat", () => {
  it("ignores comments and blank lines and trims", () => {
    expect(parseFlat("# c\n\n a = b # tail\nk=v=w\n")).toEqual({ a: "b", k: "v=w" })
  })
})
