import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const FAKE = resolve(import.meta.dir, "testdata", "fake-gh.sh")
const SCRIPT = resolve(import.meta.dir, "release-assets.sh")
const TAG = "v0.1.4"
const DMG = `winvm-${TAG}-darwin-arm64.dmg`
const BUNDLE = `winvm-${TAG}-darwin-arm64.app.tar.gz`
const KEEPER = `winvm-keeper-${TAG}-darwin-arm64`
const FINAL = [
  BUNDLE,
  `${BUNDLE}.sha256`,
  `${BUNDLE}.sig`,
  DMG,
  `${DMG}.sha256`,
  KEEPER,
  `${KEEPER}.sha256`,
  "SBOM.cdx.json",
  "latest.json",
].sort()
const BUILDER = [BUNDLE, `${BUNDLE}.sha256`, `${BUNDLE}.sig`, DMG, `${DMG}.sha256`]
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Writes the update bundle as a real tarball, holding the keeper unless `keeper` is false. */
function writeBundle(dir: string, keeper: boolean) {
  const app = join(dir, "bundle", "winvm.app", "Contents", "MacOS")
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, "winvm"), "cli")
  if (keeper) writeFileSync(join(app, "winvm-keeper"), "signed keeper")
  const tar = Bun.spawnSync(["tar", "-czf", join(dir, "release", BUNDLE), "-C", join(dir, "bundle"), "winvm.app"])
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
}

/** A draft release holding `assets`, a fake `gh`, and a fake `bun` that stands in for the manifest check. */
function sandbox(assets: string[], { keeper = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-assets-"))
  dirs.push(dir)
  for (const sub of ["bin", "api", "release"]) mkdirSync(join(dir, sub))
  copyFileSync(FAKE, join(dir, "bin", "gh"))
  writeFileSync(join(dir, "bin", "bun"), '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do [ "$1" = --out ] && echo "{\\"version\\":\\"x\\"}" > "$2"; shift; done\n')
  chmodSync(join(dir, "bin", "gh"), 0o755)
  chmodSync(join(dir, "bin", "bun"), 0o755)
  for (const a of assets) {
    if (a === BUNDLE) writeBundle(dir, keeper)
    else writeFileSync(join(dir, "release", a), a)
  }
  writeFileSync(join(dir, "sbom.json"), "{}")
  return dir
}

function run(dir: string) {
  const env = {
    PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
    FAKE_GH_DIR: dir,
    GITHUB_REPOSITORY: "stuffbucket/winvm",
    GH_TOKEN: "x",
  }
  const p = Bun.spawnSync(["bash", SCRIPT, TAG, join(dir, "sbom.json")], { env, stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), assets: readdirSync(join(dir, "release")).sort() }
}

describe("release-assets.sh", () => {
  it("adds the SBOM, latest.json and the signed keeper to what the builder uploaded", () => {
    const dir = sandbox(BUILDER)
    const r = run(dir)
    expect(r.code).toBe(0)
    expect(r.assets).toEqual(FINAL)
    expect(readFileSync(join(dir, "release", KEEPER), "utf8")).toBe("signed keeper")
  })

  it("fails when the update bundle has no keeper", () => {
    const r = run(sandbox(BUILDER, { keeper: false }))
    expect(r.code).toBe(1)
    expect(r.out).toContain("has no Contents/MacOS/winvm-keeper")
  })

  it("is safe to run again", () => {
    const dir = sandbox(FINAL)
    const r = run(dir)
    expect(r.code).toBe(0)
    expect(r.assets).toEqual(FINAL)
  })

  it("renames a winvm.dmg from a builder that predates dmg_name", () => {
    const dir = sandbox([BUNDLE, `${BUNDLE}.sha256`, `${BUNDLE}.sig`, "winvm.dmg", "winvm.dmg.sha256"])
    const r = run(dir)
    expect(r.code).toBe(0)
    expect(r.assets).toEqual(FINAL)
    expect(existsSync(join(dir, "release", "winvm.dmg"))).toBe(false)
  })

  it("fails when the builder's update bundle is missing", () => {
    const r = run(sandbox(BUILDER.filter((a) => a !== `${BUNDLE}.sig`)))
    expect(r.code).not.toBe(0)
  })

  it("fails, naming the file, when the draft holds anything unexpected", () => {
    const r = run(sandbox([...BUILDER, "stray.zip"]))
    expect(r.code).toBe(1)
    expect(r.out).toContain("stray.zip")
    expect(r.out).toContain("does not hold exactly the expected assets")
  })

  it("fails when the dmg checksum is missing", () => {
    const r = run(sandbox(BUILDER.filter((a) => a !== `${DMG}.sha256`)))
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${DMG}.sha256`)
  })
})
