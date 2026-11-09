import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
  RELEASE_PR_BRANCH,
  dispatchReleasePrCi,
  parseRemoteHead,
  validateReleasePleaseTrigger,
  type CommandRunner,
} from "./release-please-ci.ts"

const sha = (digit: string): string => digit.repeat(40)
const ref = `refs/heads/${RELEASE_PR_BRANCH}`

function runnerFor(afterOutput: string, ghExitCode = 0) {
  const calls: string[][] = []
  const run: CommandRunner = (command) => {
    calls.push(command)
    if (command[0] === "git") return { exitCode: 0, stdout: afterOutput, stderr: "" }
    if (command[0] === "gh") return { exitCode: ghExitCode, stdout: "", stderr: ghExitCode ? "dispatch failed" : "" }
    throw new Error(`unexpected command: ${command.join(" ")}`)
  }
  return { calls, run }
}

describe("release PR branch contract", () => {
  test("matches the explicit Release Please component", () => {
    const config = JSON.parse(
      readFileSync(new URL("../release-please-config.json", import.meta.url), "utf8"),
    ) as { packages: { ".": { component?: string } } }

    expect(config.packages["."].component).toBe("winvm-workspace")
    expect(RELEASE_PR_BRANCH).toBe("release-please--branches--main--components--winvm-workspace")
  })

  test("accepts an absent branch or one exact remote ref", () => {
    expect(parseRemoteHead("")).toBeNull()
    expect(parseRemoteHead(`${sha("a")}\t${ref}\n`)).toBe(sha("a"))
  })

  test("rejects malformed, unexpected, or ambiguous remote refs", () => {
    expect(() => parseRemoteHead(`not-a-sha\t${ref}\n`)).toThrow("malformed")
    expect(() => parseRemoteHead(`${sha("a")}\trefs/heads/another-branch\n`)).toThrow("unexpected ref")
    expect(() => parseRemoteHead(`${sha("a")}\t${ref}\n${sha("b")}\t${ref}\n`)).toThrow("exactly one")
  })
})

describe("release PR CI dispatch", () => {
  test("does nothing when the branch is absent before and after", () => {
    const { calls, run } = runnerFor("")

    expect(dispatchReleasePrCi({ before: null, force: false, repository: "stuffbucket/winvm", run })).toEqual({
      before: null,
      after: null,
      decision: "absent",
    })
    expect(calls).toHaveLength(1)
  })

  test("does nothing when the branch SHA is unchanged", () => {
    const head = sha("a")
    const { calls, run } = runnerFor(`${head}\t${ref}\n`)

    expect(dispatchReleasePrCi({ before: head, force: false, repository: "stuffbucket/winvm", run })).toEqual({
      before: head,
      after: head,
      decision: "unchanged",
    })
    expect(calls).toHaveLength(1)
  })

  test("dispatches the exact SHA when the branch is created", () => {
    const head = sha("b")
    const { calls, run } = runnerFor(`${head}\t${ref}\n`)

    expect(dispatchReleasePrCi({ before: null, force: false, repository: "stuffbucket/winvm", run })).toEqual({
      before: null,
      after: head,
      decision: "dispatched",
      dispatchedSha: head,
    })
    expect(calls[1]).toEqual([
      "gh",
      "workflow",
      "run",
      "ci.yml",
      "--repo",
      "stuffbucket/winvm",
      "--ref",
      RELEASE_PR_BRANCH,
      "-f",
      `expected_sha=${head}`,
    ])
  })

  test("dispatches the exact new SHA when the branch changes", () => {
    const before = sha("a")
    const after = sha("b")
    const { calls, run } = runnerFor(`${after}\t${ref}\n`)

    const result = dispatchReleasePrCi({ before, force: false, repository: "stuffbucket/winvm", run })

    expect(result.dispatchedSha).toBe(after)
    expect(calls[1]?.at(-1)).toBe(`expected_sha=${after}`)
  })

  test("force-dispatches an unchanged SHA for manual recovery", () => {
    const head = sha("c")
    const { calls, run } = runnerFor(`${head}\t${ref}\n`)

    expect(dispatchReleasePrCi({ before: head, force: true, repository: "stuffbucket/winvm", run }).decision).toBe(
      "dispatched",
    )
    expect(calls).toHaveLength(2)
  })

  test("fails when the remote ref command fails", () => {
    const run: CommandRunner = () => ({ exitCode: 2, stdout: "", stderr: "network failed" })

    expect(() => dispatchReleasePrCi({ before: null, force: false, repository: "stuffbucket/winvm", run })).toThrow(
      "git ls-remote failed",
    )
  })

  test("fails when workflow dispatch fails", () => {
    const head = sha("d")
    const { run } = runnerFor(`${head}\t${ref}\n`, 1)

    expect(() => dispatchReleasePrCi({ before: null, force: false, repository: "stuffbucket/winvm", run })).toThrow(
      "CI dispatch failed",
    )
  })
})

describe("command-line wiring", () => {
  test("capture writes absent only after a successful remote lookup", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "winvm-release-ci-"))
    const git = resolve(dir, "git")
    const output = resolve(dir, "github-output")
    writeFileSync(git, "#!/bin/sh\nexit 0\n")
    chmodSync(git, 0o755)

    try {
      const result = Bun.spawnSync([process.execPath, new URL("./release-please-ci.ts", import.meta.url).pathname, "capture"], {
        env: { ...process.env, GITHUB_OUTPUT: output, PATH: `${dir}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      })

      expect(result.exitCode).toBe(0)
      expect(readFileSync(output, "utf8")).toBe("sha=absent\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("capture fails without writing output when the remote lookup fails", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "winvm-release-ci-"))
    const git = resolve(dir, "git")
    const output = resolve(dir, "github-output")
    writeFileSync(git, '#!/bin/sh\nprintf "network failed\\n" >&2\nexit 2\n')
    chmodSync(git, 0o755)

    try {
      const result = Bun.spawnSync([process.execPath, new URL("./release-please-ci.ts", import.meta.url).pathname, "capture"], {
        env: { ...process.env, GITHUB_OUTPUT: output, PATH: `${dir}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain("git ls-remote failed: network failed")
      expect(() => readFileSync(output, "utf8")).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("dispatch rejects malformed flags before running commands", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        new URL("./release-please-ci.ts", import.meta.url).pathname,
        "dispatch",
        "--before",
        "absent",
        "--force",
        "maybe",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("force must be true or false")
  })
})

describe("Release Please trigger validation", () => {
  test("accepts push and manual runs on main", () => {
    expect(() => validateReleasePleaseTrigger("push", "refs/heads/main")).not.toThrow()
    expect(() => validateReleasePleaseTrigger("workflow_dispatch", "refs/heads/main")).not.toThrow()
  })

  test("rejects a manual run from another ref", () => {
    expect(() => validateReleasePleaseTrigger("workflow_dispatch", "refs/heads/feature")).toThrow(
      "must run from refs/heads/main",
    )
  })
})
