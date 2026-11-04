import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const FAKE = resolve(import.meta.dir, "testdata", "fake-gh.sh")
const WORKFLOW = resolve(import.meta.dir, "..", ".github", "workflows", "release.yml")
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Step {
  id?: string
  run?: string
}
interface Workflow {
  jobs: Record<string, { steps?: Step[]; needs?: string | string[]; if?: string }>
}
const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as Workflow

/** Runs the release-please job's `plan` step, as Actions would, and returns its outputs. */
function plan(env: Record<string, string>, release?: "draft" | "published") {
  const dir = mkdtempSync(join(tmpdir(), "release-plan-"))
  dirs.push(dir)
  mkdirSync(join(dir, "bin"))
  mkdirSync(join(dir, "release"))
  copyFileSync(FAKE, join(dir, "bin", "gh"))
  chmodSync(join(dir, "bin", "gh"), 0o755)
  if (release !== undefined) writeFileSync(join(dir, "release.isDraft"), release === "draft" ? "true" : "false")
  const script = workflow.jobs["release-please"]?.steps?.find((s) => s.id === "plan")?.run
  if (script === undefined) throw new Error("the plan step is gone")
  const p = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", script], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      FAKE_GH_DIR: dir,
      GITHUB_REPOSITORY: "stuffbucket/winvm",
      GITHUB_REF: "refs/heads/main",
      GITHUB_OUTPUT: join(dir, "output"),
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      GH_TOKEN: "x",
      REHEARSE_TAG: "",
      RELEASE_CREATED: "",
      RELEASE_TAG: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = existsSync(join(dir, "output")) ? Object.fromEntries(readFileSync(join(dir, "output"), "utf8").trim().split("\n").map((l) => l.split(/=(.*)/su).slice(0, 2))) : {}
  const edits = existsSync(join(dir, "edits.log")) ? readFileSync(join(dir, "edits.log"), "utf8") : ""
  return { code: p.exitCode, err: p.stdout.toString() + p.stderr.toString(), out, edits }
}

describe("the release workflow's plan step", () => {
  it("does nothing on an ordinary push", () => {
    expect(plan({}).out).toEqual({ tag: "", go: "false", publish: "false" })
  })

  it("releases and publishes when release-please made a release", () => {
    const r = plan({ RELEASE_CREATED: "true", RELEASE_TAG: "v0.1.4" })
    expect(r.out).toEqual({ tag: "v0.1.4", go: "true", publish: "true" })
  })

  it("rehearses a pre-release tag without publishing, creating the draft when missing", () => {
    const r = plan({ REHEARSE_TAG: "v0.0.0-rehearsal.1" })
    expect(r.out).toMatchObject({ tag: "v0.0.0-rehearsal.1", go: "true", publish: "false" })
    expect(r.edits).toContain("release create v0.0.0-rehearsal.1")
    expect(r.edits).toContain("--verify-tag --draft --prerelease")
  })

  it("reuses an existing rehearsal draft", () => {
    const r = plan({ REHEARSE_TAG: "v0.0.0-rehearsal.1" }, "draft")
    expect(r.out.go).toBe("true")
    expect(r.edits).toBe("")
  })

  it("never rehearses on a published release, a real version, or off main", () => {
    expect(plan({ REHEARSE_TAG: "v0.0.0-rehearsal.1" }, "published").code).toBe(1)
    expect(plan({ REHEARSE_TAG: "v0.1.3" }, "published").err).toContain("needs a pre-release tag")
    expect(plan({ REHEARSE_TAG: "v0.1.4" }).code).toBe(1)
    expect(plan({ REHEARSE_TAG: "v0.0.0-rehearsal.1", GITHUB_REF: "refs/heads/x" }).err).toContain("from main")
  })
})

describe("the release workflow's shape", () => {
  it("checks it runs from main and snapshots the release PR before release-please moves it", () => {
    const steps = workflow.jobs["release-please"]?.steps ?? []
    const at = (needle: string) => steps.findIndex((s) => s.run?.includes(needle) ?? false)
    const rp = steps.findIndex((s) => s.id === "rp")
    expect(at("release-please-ci.ts validate-trigger")).toBeGreaterThanOrEqual(0)
    expect(at("release-please-ci.ts capture")).toBeGreaterThan(at("release-please-ci.ts validate-trigger"))
    expect(rp).toBeGreaterThan(at("release-please-ci.ts capture"))
  })

  it("dispatches release PR CI only through the change-aware script", () => {
    const job = workflow.jobs["release-pr-ci"]
    expect(job?.needs).toBe("release-please")
    expect(job?.steps?.some((s) => s.run?.includes("release-please-ci.ts dispatch --before") ?? false)).toBe(true)
  })

  it("has no job that publishes before the build and the check have passed", () => {
    expect(workflow.jobs.publish?.needs).toEqual(["release-please", "check", "build"])
  })
})
