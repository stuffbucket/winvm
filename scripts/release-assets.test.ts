import { afterEach, describe, expect, it } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

import { ghSandbox, removeGhSandboxes, runBash } from "./testdata/gh-sandbox"

const SCRIPT = resolve(import.meta.dir, "release-assets.sh")
const TAG = "v0.1.4"
const DMG = `winvm-${TAG}-darwin-arm64.dmg`
const BUNDLE = `winvm-${TAG}-darwin-arm64.app.tar.gz`
const KEEPER = `winvm-keeper-${TAG}-darwin-arm64`
const BUILDER = [
  BUNDLE,
  `${BUNDLE}.sha256`,
  `${BUNDLE}.sig`,
  DMG,
  `${DMG}.sha256`,
]
const FINAL = [
  ...BUILDER,
  KEEPER,
  `${KEEPER}.sha256`,
  "SBOM.cdx.json",
  "latest.json",
].sort()

afterEach(removeGhSandboxes)

function writeBundle(dir: string, keeper: boolean) {
  const app = join(dir, "bundle", "winvm.app", "Contents", "MacOS")
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, "winvm"), "cli")
  if (keeper) writeFileSync(join(app, "winvm-keeper"), "signed keeper")
  const tar = Bun.spawnSync([
    "tar",
    "-czf",
    join(dir, "release", BUNDLE),
    "-C",
    join(dir, "bundle"),
    "winvm.app",
  ])
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
}

function sandbox(assets: string[], { keeper = true } = {}) {
  const { dir, env } = ghSandbox("release-assets", ["release"])
  writeFileSync(
    join(dir, "bin", "bun"),
    '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do [ "$1" = --out ] && echo "{\\"version\\":\\"x\\"}" > "$2"; shift; done\n',
  )
  chmodSync(join(dir, "bin", "bun"), 0o755)
  for (const a of assets) {
    if (a === BUNDLE) writeBundle(dir, keeper)
    else writeFileSync(join(dir, "release", a), a)
  }
  writeFileSync(join(dir, "sbom.json"), "{}")
  return { dir, env }
}

function run({ dir, env }: { dir: string; env: Record<string, string> }) {
  return {
    ...runBash([SCRIPT, TAG, join(dir, "sbom.json")], env),
    assets: readdirSync(join(dir, "release")).sort(),
  }
}

describe("release-assets.sh", () => {
  it("adds the SBOM, latest.json and the signed keeper to what the builder uploaded", () => {
    const box = sandbox(BUILDER)
    const r = run(box)
    expect(r.code).toBe(0)
    expect(r.assets).toEqual(FINAL)
    expect(readFileSync(join(box.dir, "release", KEEPER), "utf8")).toBe(
      "signed keeper",
    )
  }, 30_000)

  it("fails when the update bundle has no keeper", () => {
    const r = run(sandbox(BUILDER, { keeper: false }))
    expect(r.code).toBe(1)
    expect(r.out).toContain("has no Contents/MacOS/winvm-keeper")
  }, 30_000)

  it("is safe to run again", () => {
    const r = run(sandbox(FINAL))
    expect(r.code).toBe(0)
    expect(r.assets).toEqual(FINAL)
  }, 30_000)

  it("fails when the builder's update bundle is missing", () => {
    const r = run(sandbox(BUILDER.filter((a) => a !== `${BUNDLE}.sig`)))
    expect(r.code).not.toBe(0)
  }, 30_000)

  it("fails, naming the file, when the draft holds anything unexpected", () => {
    const r = run(sandbox([...BUILDER, "stray.zip"]))
    expect(r.code).toBe(1)
    expect(r.out).toContain("stray.zip")
    expect(r.out).toContain("does not hold exactly the expected assets")
  }, 30_000)

  it("fails when the dmg checksum is missing", () => {
    const r = run(sandbox(BUILDER.filter((a) => a !== `${DMG}.sha256`)))
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${DMG}.sha256`)
  }, 30_000)
})
