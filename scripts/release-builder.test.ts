import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { ghSandbox, removeGhSandboxes, runBash } from "./testdata/gh-sandbox"

const SCRIPT = resolve(import.meta.dir, "release-builder.sh")

afterEach(removeGhSandboxes)

function sandbox(fixtures: Record<string, string>): {
  dir: string
  env: Record<string, string>
} {
  const { dir, env } = ghSandbox("release-builder", ["api"])
  for (const [name, body] of Object.entries(fixtures))
    writeFileSync(join(dir, name), body)
  return {
    dir,
    env: {
      ...env,
      POLL_SECONDS: "0",
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    },
  }
}

const run = (env: Record<string, string>) => runBash([SCRIPT, "v0.1.4"], env)

const RUN = "repos_stuffbucket_macos-builder_actions_runs_555"
const dispatch = JSON.stringify({
  workflow_run_id: 555,
  run_url: "u",
  html_url: "https://github.com/stuffbucket/macos-builder/actions/runs/555",
})
const state = (status: string, conclusion: string | null) =>
  JSON.stringify({ status, conclusion })

describe("release-builder.sh", () => {
  it("waits for the run the dispatch named and succeeds when it does", () => {
    const { dir, env } = sandbox({
      "dispatch.json": dispatch,
      [`api/${RUN}.1.json`]: state("queued", null),
      [`api/${RUN}.2.json`]: state("in_progress", null),
      [`api/${RUN}.3.json`]: state("completed", "success"),
    })
    const r = run(env)
    expect(r.code).toBe(0)
    expect(r.out).toContain("builder run 555: completed success")
    expect(readFileSync(join(dir, "calls.log"), "utf8")).not.toContain("jobs")
  })

  it("fails fast and shows the builder's error when the build is refused", () => {
    const { dir, env } = sandbox({
      "dispatch.json": dispatch,
      [`api/${RUN}.1.json`]: state("completed", "failure"),
      [`api/${RUN}_jobs.1.json`]: JSON.stringify({
        jobs: [
          { id: 7, conclusion: "failure" },
          { id: 8, conclusion: "skipped" },
        ],
      }),
      "api/repos_stuffbucket_macos-builder_actions_jobs_7_logs.txt":
        "2026-11-03T16:15:01.1Z ##[group]Enforce per-repo policy\n2026-11-03T16:15:02.2Z ##[error]sign_nested 'x' is not permitted by policy for stuffbucket/winvm.\n2026-11-03T16:15:02.3Z ##[error]Process completed with exit code 1.\n",
    })
    const r = run(env)
    expect(r.code).toBe(1)
    expect(r.out).toContain("ended failure")
    expect(r.out).toContain(
      "::error::sign_nested 'x' is not permitted by policy for stuffbucket/winvm.",
    )
    expect(r.out).not.toContain("Enforce per-repo policy")
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain(
      "is not permitted by policy",
    )
    expect(readFileSync(join(dir, "calls.log"), "utf8")).not.toContain("jobs_8")
  })

  it("refuses to guess when the dispatch returns no run id", () => {
    const { env } = sandbox({})
    const r = run(env)
    expect(r.code).toBe(1)
    expect(r.out).toContain("returned no run id")
  })

  it("gives up, without cancelling the run, after the timeout", () => {
    const { env } = sandbox({
      "dispatch.json": dispatch,
      [`api/${RUN}.1.json`]: state("in_progress", null),
    })
    const r = run({ ...env, BUILD_TIMEOUT: "0" })
    expect(r.code).toBe(1)
    expect(r.out).toContain("still running")
  })

  it("treats a cancelled run as a failure", () => {
    const { env } = sandbox({
      "dispatch.json": dispatch,
      [`api/${RUN}.1.json`]: state("completed", "cancelled"),
      [`api/${RUN}_jobs.1.json`]: '{"jobs":[]}',
    })
    const r = run(env)
    expect(r.code).toBe(1)
    expect(r.out).toContain("ended cancelled")
  })
})
