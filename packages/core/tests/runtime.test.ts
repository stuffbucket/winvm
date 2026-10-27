import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

import {
  RuntimeMissing,
  currentQemuCompat,
  ensureRuntime,
  findRuntime,
  qemuCompat,
  runtimeBin,
  verifyRuntime,
  type RuntimeManifest,
  type RuntimePin,
} from "../src/runtime"

let tmp = ""
const BINS = ["qemu-system-aarch64", "qemu-img", "swtpm", "zstd"]

function makeRuntime(dir: string, version = "11.1.2-1"): RuntimeManifest {
  mkdirSync(resolve(dir, "bin"), { recursive: true })
  mkdirSync(resolve(dir, "share", "qemu"), { recursive: true })
  const files: Record<string, string> = {}
  for (const b of BINS) {
    const body = `#!/bin/sh\necho ${b} ${version}\n`
    writeFileSync(resolve(dir, "bin", b), body)
    chmodSync(resolve(dir, "bin", b), 0o755)
    files[`bin/${b}`] = createHash("sha256").update(body).digest("hex")
  }
  writeFileSync(resolve(dir, "share", "qemu", "efi-virtio.rom"), "rom")
  files["share/qemu/efi-virtio.rom"] = createHash("sha256").update("rom").digest("hex")
  const manifest: RuntimeManifest = {
    name: "winvm-runtime",
    version,
    qemu: "11.1.2",
    qemuPatches: "none",
    components: { "winvm-qemu": "11.1.2" },
    macho: BINS.map((b) => `bin/${b}`),
    files,
  }
  writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(manifest))
  return manifest
}

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "winvm-runtime-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const pin: RuntimePin = { version: "11.1.2-1", url: "unused", sha256: "unused" }

describe("finding the runtime", () => {
  it("takes the override first, then the app's, then the cache, and nothing else", () => {
    const cache = resolve(tmp, "cache")
    makeRuntime(resolve(cache, "11.1.2-1"))
    const app = resolve(tmp, "winvm.app")
    makeRuntime(resolve(app, "Contents", "Resources", "runtime"))
    const override = resolve(tmp, "override")
    makeRuntime(override)
    const execPath = resolve(app, "Contents", "MacOS", "winvm")

    expect(findRuntime({ env: { WINVM_RUNTIME: override }, execPath, cache, pin })).toMatchObject({ source: "override", dir: override })
    expect(findRuntime({ env: {}, execPath, cache, pin })).toMatchObject({ source: "app" })
    expect(findRuntime({ env: {}, execPath: "/usr/local/bin/bun", cache, pin })).toMatchObject({ source: "cache" })
    expect(findRuntime({ env: {}, execPath: "/usr/local/bin/bun", cache: resolve(tmp, "empty"), pin })).toBeNull()
  })

  it("ignores a cached runtime of another version", () => {
    const cache = resolve(tmp, "cache")
    makeRuntime(resolve(cache, "11.0.3-1"), "11.0.3-1")
    expect(findRuntime({ env: {}, execPath: "/x/bun", cache, pin })).toBeNull()
  })

  it("never falls back to PATH: without a runtime, asking for a binary says to run winvm setup", () => {
    expect(() => runtimeBin("qemu-system-aarch64", { env: {}, execPath: "/x/bun", cache: resolve(tmp, "none"), pin })).toThrow(
      RuntimeMissing,
    )
    expect(() => runtimeBin("qemu-img", { env: {}, execPath: "/x/bun", cache: resolve(tmp, "none"), pin })).toThrow("winvm setup")
  })

  it("gives the binary inside the runtime", () => {
    const cache = resolve(tmp, "cache")
    makeRuntime(resolve(cache, "11.1.2-1"))
    expect(runtimeBin("swtpm", { env: {}, execPath: "/x/bun", cache, pin })).toBe(resolve(cache, "11.1.2-1", "bin", "swtpm"))
  })
})

describe("verifying the runtime", () => {
  it("checks every file of a cached runtime against the manifest", () => {
    const dir = resolve(tmp, "cache", "11.1.2-1")
    makeRuntime(dir)
    const rt = findRuntime({ env: {}, execPath: "/x/bun", cache: resolve(tmp, "cache"), pin })
    expect(rt).not.toBeNull()
    expect(verifyRuntime(rt!)).toEqual([])
    writeFileSync(resolve(dir, "bin", "zstd"), "#!/bin/sh\necho tampered\n")
    writeFileSync(resolve(dir, "bin", "extra"), "x")
    rmSync(resolve(dir, "share", "qemu", "efi-virtio.rom"))
    expect(verifyRuntime(rt!)).toEqual([
      "bin/zstd does not match manifest.json",
      "share/qemu/efi-virtio.rom is missing",
      "bin/extra is not in manifest.json",
    ])
  })

  it("inside the app, checks Mach-O files by signature and the rest by hash", () => {
    const app = resolve(tmp, "winvm.app")
    const dir = resolve(app, "Contents", "Resources", "runtime")
    makeRuntime(dir)
    writeFileSync(resolve(dir, "bin", "qemu-img"), "re-signed bytes")
    const rt = findRuntime({ env: {}, execPath: resolve(app, "Contents", "MacOS", "winvm"), cache: resolve(tmp, "c"), pin })
    expect(verifyRuntime(rt!, { signatureOk: () => true })).toEqual([])
    expect(verifyRuntime(rt!, { signatureOk: (p) => !p.endsWith("swtpm") })).toEqual(["bin/swtpm has no valid signature"])
    writeFileSync(resolve(dir, "share", "qemu", "efi-virtio.rom"), "changed")
    expect(verifyRuntime(rt!, { signatureOk: () => true })).toEqual(["share/qemu/efi-virtio.rom does not match manifest.json"])
  })

  it("reports an override without a manifest rather than refusing it", () => {
    const dir = resolve(tmp, "override")
    mkdirSync(resolve(dir, "bin"), { recursive: true })
    const rt = findRuntime({ env: { WINVM_RUNTIME: dir }, execPath: "/x/bun", cache: resolve(tmp, "c"), pin })
    expect(rt).toMatchObject({ source: "override", manifest: null })
    expect(verifyRuntime(rt!)).toEqual(["no manifest.json"])
  })
})

describe("fetching the runtime", () => {
  function tarball(): { path: string; sha256: string } {
    const stage = resolve(tmp, "stage")
    makeRuntime(resolve(stage, "winvm-runtime-11.1.2-1-darwin-arm64"))
    const path = resolve(tmp, "winvm-runtime-11.1.2-1-darwin-arm64.tar.gz")
    expect(spawnSync("tar", ["-czf", path, "-C", stage, "winvm-runtime-11.1.2-1-darwin-arm64"]).status).toBe(0)
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex")
    return { path, sha256 }
  }

  it("downloads the pinned tarball, checks it, unpacks it into the cache and keeps no tarball", async () => {
    const t = tarball()
    const cache = resolve(tmp, "cache")
    const rt = await ensureRuntime({ pin: { version: "11.1.2-1", url: `file://${t.path}`, sha256: t.sha256 }, cache })
    expect(rt).toMatchObject({ source: "cache", dir: resolve(cache, "11.1.2-1") })
    expect(verifyRuntime(rt)).toEqual([])
    expect(readdirSync(cache)).toEqual(["11.1.2-1"])
  })

  it("refuses a tarball that does not match the pin and leaves the cache without it", async () => {
    const t = tarball()
    const cache = resolve(tmp, "cache")
    await expect(
      ensureRuntime({ pin: { version: "11.1.2-1", url: `file://${t.path}`, sha256: "0".repeat(64) }, cache }),
    ).rejects.toThrow("does not match its pinned digest")
    expect(existsSync(resolve(cache, "11.1.2-1"))).toBe(false)
  })

  it("does nothing when the cached runtime is already there and intact", async () => {
    const cache = resolve(tmp, "cache")
    makeRuntime(resolve(cache, "11.1.2-1"))
    const rt = await ensureRuntime({ pin: { version: "11.1.2-1", url: "file:///nonexistent", sha256: "x" }, cache })
    expect(rt.source).toBe("cache")
  })
})

describe("save compatibility", () => {
  it("keys saves on QEMU's version and the runtime's QEMU patches, not the runtime revision", () => {
    const m = makeRuntime(resolve(tmp, "r"))
    expect(qemuCompat(m)).toBe("11.1.2+patches:none")
    expect(qemuCompat({ ...m, version: "11.1.2-2" })).toBe("11.1.2+patches:none")
    expect(qemuCompat({ ...m, qemuPatches: "ab12cd34ef56ab78" })).toBe("11.1.2+patches:ab12cd34ef56ab78")
  })

  it("records the runtime in use, and an override without a manifest by its directory", () => {
    const cache = resolve(tmp, "cache")
    makeRuntime(resolve(cache, "11.1.2-1"))
    expect(currentQemuCompat({ env: {}, execPath: "/x/bun", cache, pin })).toBe("11.1.2+patches:none")
    const dir = resolve(tmp, "bare")
    mkdirSync(dir)
    expect(currentQemuCompat({ env: { WINVM_RUNTIME: dir }, execPath: "/x/bun", cache, pin })).toBe(`override:${dir}`)
    expect(() => currentQemuCompat({ env: {}, execPath: "/x/bun", cache: resolve(tmp, "none"), pin })).toThrow(RuntimeMissing)
  })
})
