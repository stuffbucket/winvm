import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { identityFromEntries, selectBuildIdentity, sourceBuildIdentity } from "../src/identity"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const SHAPE = /^sha256:[0-9a-f]{64}$/

describe("identityFromEntries", () => {
  const a = { path: "packages/core/src/a.ts", bytes: bytes("export const a = 1\n") }
  const b = { path: "apps/cli/src/b.ts", bytes: bytes("export const b = 2\n") }

  it("is a deterministic sha256 that does not depend on the order entries are listed", () => {
    const x = identityFromEntries([a, b], "0.1.0", "1.4.3")
    expect(x).toMatch(SHAPE)
    expect(identityFromEntries([b, a], "0.1.0", "1.4.3")).toBe(x)
    expect(identityFromEntries([a, b], "0.1.0", "1.4.3")).toBe(x)
  })

  it("changes when a single source byte changes", () => {
    const x = identityFromEntries([a, b], "0.1.0", "1.4.3")
    const edited = { path: a.path, bytes: bytes("export const a = 2\n") }
    expect(identityFromEntries([edited, b], "0.1.0", "1.4.3")).not.toBe(x)
  })

  it("changes when a file is renamed, even with the same bytes", () => {
    const x = identityFromEntries([a, b], "0.1.0", "1.4.3")
    expect(identityFromEntries([{ path: "packages/core/src/c.ts", bytes: a.bytes }, b], "0.1.0", "1.4.3")).not.toBe(x)
  })

  it("changes with the package version and with the Bun version", () => {
    const x = identityFromEntries([a, b], "0.1.0", "1.4.3")
    expect(identityFromEntries([a, b], "0.1.1", "1.4.3")).not.toBe(x)
    expect(identityFromEntries([a, b], "0.1.0", "1.4.4")).not.toBe(x)
  })

  it("does not confuse where one entry ends and the next begins", () => {
    const x = identityFromEntries([{ path: "a", bytes: bytes("bc") }], "v", "b")
    const y = identityFromEntries([{ path: "ab", bytes: bytes("c") }], "v", "b")
    expect(x).not.toBe(y)
  })
})

describe("sourceBuildIdentity", () => {
  const roots: string[] = []
  const FILES: Readonly<Record<string, string>> = {
    "package.json": '{"version":"0.1.0"}\n',
    "apps/cli/src/winvm.ts": "cli\n",
    "apps/cli/package.json": '{"version":"0.1.0"}\n',
    "packages/core/src/paths.ts": "paths\n",
    "packages/core/src/deep/more.ts": "more\n",
    "packages/core/package.json": '{"version":"0.1.0"}\n',
    "packages/core/runtime.json": "{}\n",
    ".bun-version": "1.4.3\n",
    "pnpm-lock.yaml": "lock\n",
    "apps/viewer/scripts/build-sidecar.ts": "build\n",
  }
  const tree = (over: Readonly<Record<string, string>> = {}): string => {
    const root = mkdtempSync(resolve(tmpdir(), "winvm-identity-"))
    roots.push(root)
    for (const [rel, text] of Object.entries({ ...FILES, ...over })) {
      mkdirSync(dirname(resolve(root, rel)), { recursive: true })
      writeFileSync(resolve(root, rel), text)
    }
    return root
  }
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it("is stable for an unchanged tree, has the sha256 shape, and does not depend on where the tree lives", () => {
    const x = sourceBuildIdentity(tree())
    expect(x).toMatch(SHAPE)
    expect(sourceBuildIdentity(tree())).toBe(x)
  })

  it("changes when any hashed source or input file changes by one byte", () => {
    const base = sourceBuildIdentity(tree())
    for (const rel of Object.keys(FILES)) {
      expect(sourceBuildIdentity(tree({ [rel]: "changed!\n" }))).not.toBe(base)
    }
  })

  it("ignores files that are not TypeScript sources", () => {
    const base = sourceBuildIdentity(tree())
    expect(sourceBuildIdentity(tree({ "packages/core/src/notes.md": "scratch\n" }))).toBe(base)
  })
})

describe("selectBuildIdentity", () => {
  it("prefers the compile-time identity, then the environment, then the source tree", () => {
    const source = (): string => "sha256:source"
    expect(selectBuildIdentity({ embedded: "sha256:embedded", env: "sha256:env", source })).toBe("sha256:embedded")
    expect(selectBuildIdentity({ embedded: undefined, env: "sha256:env", source })).toBe("sha256:env")
    expect(selectBuildIdentity({ embedded: undefined, env: undefined, source })).toBe("sha256:source")
    expect(selectBuildIdentity({ embedded: "", env: "", source })).toBe("sha256:source")
  })

  it("does not read the source tree when an identity is already fixed", () => {
    const source = (): string => {
      throw new Error("must not hash the source tree")
    }
    expect(selectBuildIdentity({ embedded: undefined, env: "sha256:env", source })).toBe("sha256:env")
  })

  it("keeps an environment identity stable after the source files change", () => {
    let content = "one"
    const source = (): string => `sha256:${content}`
    expect(selectBuildIdentity({ embedded: undefined, env: "sha256:parent", source })).toBe("sha256:parent")
    content = "two"
    expect(selectBuildIdentity({ embedded: undefined, env: "sha256:parent", source })).toBe("sha256:parent")
  })
})

describe("recordCliEntry exports the generation", () => {
  interface Probe {
    readonly cli: string
    readonly id: string
    readonly built: string
    readonly source: string
  }
  const probe = (buildId: string | undefined): Probe => {
    const script = `
      import { recordCliEntry } from ${JSON.stringify(resolve(import.meta.dir, "../src/paths.ts"))}
      import { buildIdentity, sourceBuildIdentity } from ${JSON.stringify(resolve(import.meta.dir, "../src/identity.ts"))}
      recordCliEntry("/x/apps/cli/src/winvm.ts")
      console.log(JSON.stringify({ cli: process.env.WINVM_CLI, id: process.env.WINVM_BUILD_ID, built: buildIdentity(), source: sourceBuildIdentity() }))
    `
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "WINVM_BUILD_ID") env[k] = v
    if (buildId !== undefined) env["WINVM_BUILD_ID"] = buildId
    const r = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" })
    expect(r.status).toBe(0)
    return JSON.parse(r.stdout.trim()) as Probe
  }

  it("exports the CLI path and the source identity when none was fixed", () => {
    const out = probe(undefined)
    expect(out.cli).toBe("/x/apps/cli/src/winvm.ts")
    expect(out.id).toMatch(SHAPE)
    expect(out.id).toBe(out.source)
    expect(out.built).toBe(out.id)
  })

  it("passes a parent's identity to detached descendants unchanged", () => {
    const parent = `sha256:${"ab".repeat(32)}`
    const out = probe(parent)
    expect(out.cli).toBe("/x/apps/cli/src/winvm.ts")
    expect(out.id).toBe(parent)
    expect(out.built).toBe(parent)
  })
})
