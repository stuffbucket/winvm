import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import pin from "../runtime.json"
import { versionReport } from "../src/commands"
import { sweepFor } from "../src/finder"
import { buildIdentity, releaseVersion } from "../src/identity"
import { PACKAGE_DIR } from "../src/paths"
import { shouldReconcileVerb } from "../src/reconcile"

const CLI = resolve(PACKAGE_DIR, "..", "..", "apps", "cli", "src", "winvm.ts")
const SHAPE = /^sha256:[0-9a-f]{64}$/

describe("winvm version", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  const run = (
    ...argv: string[]
  ): { code: number; stdout: string; home: string } => {
    const root = mkdtempSync(resolve(tmpdir(), "winvm-version-"))
    roots.push(root)
    const home = resolve(root, "state")
    const r = Bun.spawnSync([process.execPath, CLI, ...argv], {
      env: { ...process.env, WINVM_HOME: home },
    })
    return { code: r.exitCode, stdout: r.stdout.toString(), home }
  }

  it("reports the release version, this build's identity and the pinned Windows runtime", () => {
    const report = versionReport()
    expect(report).toEqual({
      version: releaseVersion(),
      build: buildIdentity(),
      runtime: pin.version,
    })
    expect(report.build).toMatch(SHAPE)
  })

  it("prints exactly the three strings the app reads, as JSON, and touches no state", () => {
    const r = run("version", "--json")
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual(["build", "runtime", "version"])
    expect(out.version).toBe(releaseVersion())
    expect(out.runtime).toBe(pin.version)
    expect(out.build).toMatch(SHAPE)
    expect(existsSync(r.home) ? readdirSync(r.home) : []).toEqual([])
  })

  it("answers to --version too, in words", () => {
    const r = run("--version")
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      `winvm ${releaseVersion()}\nbuild   ${buildIdentity()}\nruntime ${pin.version}\n`,
    )
  })

  it("neither sweeps Finder mounts nor reconciles a control service", () => {
    for (const verb of ["version", "--version"]) {
      expect(sweepFor(verb, undefined)).toBe("none")
      expect(shouldReconcileVerb(verb, {}, "default")).toBe(false)
    }
  })
})

describe("which commands sweep stale Finder mounts", () => {
  it("sweeps before acting, later for a look, and not at all for host-wide reads", () => {
    expect(sweepFor(undefined, undefined)).toBe("none")
    expect(sweepFor("start", undefined)).toBe("now")
    expect(sweepFor("info", undefined)).toBe("later")
    expect(sweepFor("files", "status")).toBe("later")
    expect(sweepFor("files", "open")).toBe("now")
    expect(sweepFor("files", "_mount")).toBe("none")
    expect(sweepFor("ls", undefined)).toBe("none")
  })
})
