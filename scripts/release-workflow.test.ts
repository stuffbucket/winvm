import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { ghSandbox, removeGhSandboxes, runBash } from "./testdata/gh-sandbox"

const WORKFLOW = resolve(
  import.meta.dir,
  "..",
  ".github",
  "workflows",
  "release.yml",
)

afterEach(removeGhSandboxes)

interface Step {
  id?: string
  run?: string
}
interface Workflow {
  jobs: Record<
    string,
    {
      steps?: Step[]
      needs?: string | string[]
      if?: string
      env?: Record<string, string>
    }
  >
}
const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as Workflow

function plan(env: Record<string, string>, release?: "draft" | "published") {
  const { dir, env: base } = ghSandbox("release-plan", ["release"])
  if (release !== undefined)
    writeFileSync(
      join(dir, "release.isDraft"),
      release === "draft" ? "true" : "false",
    )
  const script = workflow.jobs["release-please"]?.steps?.find(
    (s) => s.id === "plan",
  )?.run
  if (script === undefined) throw new Error("the plan step is gone")
  const p = runBash(["-eo", "pipefail", "-c", script], {
    ...base,
    GITHUB_REF: "refs/heads/main",
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
    REHEARSE_TAG: "",
    RELEASE_CREATED: "",
    RELEASE_TAG: "",
    ...env,
  })
  const out: Record<string, string> = existsSync(join(dir, "output"))
    ? Object.fromEntries(
        readFileSync(join(dir, "output"), "utf8")
          .trim()
          .split("\n")
          .map((l): [string, string] => {
            const [key = "", value = ""] = l.split(/=(.*)/su)
            return [key, value]
          }),
      )
    : {}
  const edits = existsSync(join(dir, "edits.log"))
    ? readFileSync(join(dir, "edits.log"), "utf8")
    : ""
  return { code: p.code, err: p.out, out, edits }
}

describe("the release workflow's plan step", () => {
  it("does nothing on an ordinary push", () => {
    expect(plan({}).out).toEqual({ tag: "" })
  })

  it("releases the tag release-please made", () => {
    const r = plan({ RELEASE_CREATED: "true", RELEASE_TAG: "v0.1.4" })
    expect(r.out).toEqual({ tag: "v0.1.4" })
  })

  it("rehearses a pre-release tag without publishing, creating the draft when missing", () => {
    const r = plan({ REHEARSE_TAG: "v0.0.0-rehearsal.1" })
    expect(r.out).toEqual({ tag: "v0.0.0-rehearsal.1" })
    expect(r.edits).toContain("release create v0.0.0-rehearsal.1")
    expect(r.edits).toContain("--verify-tag --draft --prerelease")
  })

  it("reuses an existing rehearsal draft", () => {
    const r = plan({ REHEARSE_TAG: "v0.0.0-rehearsal.1" }, "draft")
    expect(r.out.tag).toBe("v0.0.0-rehearsal.1")
    expect(r.edits).toBe("")
  })

  it("never rehearses on a published release or a real version", () => {
    expect(plan({ REHEARSE_TAG: "v0.0.0-rehearsal.1" }, "published").code).toBe(
      1,
    )
    expect(plan({ REHEARSE_TAG: "v0.1.3" }, "published").err).toContain(
      "needs a pre-release tag",
    )
    expect(plan({ REHEARSE_TAG: "v0.1.4" }).code).toBe(1)
  })
})

describe("the release workflow's shape", () => {
  it("checks it runs from main and snapshots the release PR before release-please moves it", () => {
    const steps = workflow.jobs["release-please"]?.steps ?? []
    const at = (needle: string) =>
      steps.findIndex((s) => s.run?.includes(needle) ?? false)
    const rp = steps.findIndex((s) => s.id === "rp")
    expect(at("release-please-ci.ts validate-trigger")).toBeGreaterThanOrEqual(
      0,
    )
    expect(at("release-please-ci.ts capture")).toBeGreaterThan(
      at("release-please-ci.ts validate-trigger"),
    )
    expect(rp).toBeGreaterThan(at("release-please-ci.ts capture"))
  })

  it("dispatches release PR CI only through the change-aware script", () => {
    const job = workflow.jobs["release-pr-ci"]
    expect(job?.needs).toBe("release-please")
    expect(
      job?.steps?.some(
        (s) =>
          s.run?.includes("release-please-ci.ts dispatch --before") ?? false,
      ),
    ).toBe(true)
  })

  it("runs the release jobs only for a tag, and publishes only outside a rehearsal", () => {
    expect(workflow.jobs.check?.if).toBe(
      "needs.release-please.outputs.tag != ''",
    )
    expect(workflow.jobs.build?.if).toBe(
      "needs.release-please.outputs.tag != ''",
    )
    expect(workflow.jobs.publish?.env?.PUBLISH).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
      "${{ inputs.rehearse_tag == '' }}",
    )
  })

  it("has no job that publishes before the build and the check have passed", () => {
    expect(workflow.jobs.publish?.needs).toEqual([
      "release-please",
      "check",
      "build",
    ])
  })
})
