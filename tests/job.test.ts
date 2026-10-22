/**
 * Job files and reports for `winvm run`: parsing, validation, the step
 * scripts, and the JUnit/summary renderings. No VM needed.
 */
import { describe, expect, it } from "bun:test"

import { JobError, parseDuration, parseJob, stepScript } from "../job"
import type { RunSummary } from "../report"
import { formatSummary, toJunit, totals } from "../report"

const minimal = "steps:\n  - run: echo hi\n"

describe("parseJob", () => {
  it("fills GitHub-like defaults", () => {
    const j = parseJob(minimal)
    expect(j.reset).toBe(true)
    expect(j.golden).toBeNull()
    expect(j.steps[0]?.shell).toBe("powershell")
    expect(j.steps[0]?.if).toBe("success")
    expect(j.steps[0]?.name).toBe("echo hi")
    expect(j.artifacts).toEqual({ when: "failure", paths: [] })
    expect(j.screenshot).toBe("failure")
  })

  it("reads every field", () => {
    const j = parseJob(
      [
        "name: full",
        "golden: g1",
        "timeout: 5m",
        "env: { A: x, N: 3 }",
        "files:",
        "  - src: /tmp/a.msi",
        "    dest: C:\\work\\",
        "  - url: https://example.com/b.zip",
        "  - release: owner/repo",
        "    tag: ${{ env.A }}",
        "    pattern: ['*.msi', '*.zip']",
        "    dest: C:\\work\\",
        "steps:",
        "  - name: s",
        "    shell: cmd",
        "    run: echo ${{ env.A }}",
        "    timeout: 30",
        "    continue-on-error: true",
        "    env: { B: y }",
        "    if: ${{ always() }}",
        "    background: true",
        "  - run: x",
        "    timeout-minutes: 2",
        "artifacts:",
        "  when: always",
        "  paths: ['C:\\work\\*.log']",
        "screenshot: never",
      ].join("\n"),
    )
    expect(j.golden).toBe("g1")
    expect(j.timeoutMs).toBe(300_000)
    expect(j.env).toEqual({ A: "x", N: "3" })
    expect(j.files[0]).toEqual({ kind: "path", src: "/tmp/a.msi", dest: "C:\\work\\" })
    expect(j.files[1]).toEqual({ kind: "url", url: "https://example.com/b.zip", dest: null })
    expect(j.files[2]).toEqual({ kind: "release", repo: "owner/repo", tag: "x", patterns: ["*.msi", "*.zip"], dest: "C:\\work\\" })
    const s = j.steps[0]
    expect(s).toMatchObject({ shell: "cmd", run: "echo x", timeoutMs: 30_000, continueOnError: true, env: { B: "y" }, if: "always", background: true })
    expect(j.steps[1]?.timeoutMs).toBe(120_000)
    expect(j.artifacts).toEqual({ when: "always", paths: ["C:\\work\\*.log"] })
    expect(j.screenshot).toBe("never")
  })

  it("resolves a relative src against the job file", () => {
    const j = parseJob("files:\n  - src: fixtures/x.bin\n" + minimal, "/jobs/a/job.yml")
    expect(j.files[0]).toMatchObject({ src: "/jobs/a/fixtures/x.bin" })
    expect(j.name).toBe("job")
  })

  it("rejects what it cannot run", () => {
    for (const bad of [
      "name: x",
      "steps: []",
      "steps:\n  - name: no run",
      "steps:\n  - run: x\n    shell: bash",
      "steps:\n  - run: x\n    if: github.ref == 'main'",
      "steps:\n  - run: x\n    timeout: soon",
      "files:\n  - dest: C:\\x\n" + minimal,
      "files:\n  - src: a\n    url: https://x\n" + minimal,
      "files:\n  - release: not-a-repo\n    pattern: '*'\n" + minimal,
      "files:\n  - release: o/r\n" + minimal,
      "steps:\n  - run: echo ${{ env.WINVM_SURELY_UNSET_VAR }}",
      "steps: [\n",
    ]) {
      expect(() => parseJob(bad)).toThrow(JobError)
    }
  })
})

describe("interpolation", () => {
  it("takes job env, then host env, then a default", () => {
    process.env["WINVM_TEST_HOST_VAR"] = "host"
    const j = parseJob(
      "env: { A: job }\nsteps:\n  - run: ${{ env.A }} ${{ env.WINVM_TEST_HOST_VAR }} ${{ env.WINVM_UNSET_X || 'dflt' }} ${{env.A||'no'}}\n",
    )
    expect(j.steps[0]?.run).toBe("job host dflt job")
  })
})

describe("parseDuration", () => {
  it("takes seconds and suffixed strings", () => {
    expect(parseDuration(90, "x")).toBe(90_000)
    expect(parseDuration("90s", "x")).toBe(90_000)
    expect(parseDuration("2m", "x")).toBe(120_000)
    expect(parseDuration("250ms", "x")).toBe(250)
    expect(parseDuration(undefined, "x")).toBeNull()
  })
})

describe("stepScript", () => {
  const step = parseJob("steps:\n  - run: |\n      echo 100%\n      exit 3\n    shell: cmd\n").steps[0]
  it("cmd: CRLF, env set at the top, % escaped in values", () => {
    if (step === undefined) throw new Error("no step")
    const s = stepScript(step, { P: "50%" })
    expect(s.ext).toBe(".cmd")
    expect(s.text).toBe('@echo off\r\nset "P=50%%"\r\necho 100%\r\nexit 3\r\n\r\n')
  })
  it("powershell: BOM, stop on error, quoted env, exit with the native code", () => {
    const ps = parseJob("steps:\n  - run: Write-Output 1\n").steps[0]
    if (ps === undefined) throw new Error("no step")
    const s = stepScript(ps, { Q: "it's" })
    expect(s.ext).toBe(".ps1")
    expect(s.text.startsWith("\uFEFF$ErrorActionPreference = 'Stop'\r\n")).toBe(true)
    expect(s.text).toContain("$env:Q = 'it''s'\r\n")
    expect(s.text).toContain("exit $LASTEXITCODE")
  })
})

describe("report", () => {
  const step = { name: "a<b", status: "failed" as const, exitcode: 2, ms: 1500, stdout: "out & \u0001", stderr: "", continueOnError: false, background: false }
  const job = {
    name: "j",
    file: "/x.yml",
    status: "failed" as const,
    error: null,
    instance: "ci",
    golden: "g",
    channel: "qga (system)",
    resetMs: 3000,
    stageMs: 1000,
    stepsMs: 5000,
    collectMs: 1000,
    totalMs: 10_000,
    steps: [step],
    artifacts: [],
    startedAt: "2026-01-01T00:00:00.000Z",
  }
  const s: RunSummary = { jobs: [job, { ...job, status: "passed", steps: [] }], wallMs: 25_000, setupMs: 5000 }

  it("totals reset against test time", () => {
    expect(totals(s)).toEqual({ passed: 1, failed: 1, resetMs: 6000, testMs: 14_000, overheadMs: 5000 })
    expect(formatSummary(s)).toContain("resets were 24% of the wall clock (30% excluding setup)")
  })

  it("junit escapes and marks failures", () => {
    const x = toJunit(s)
    expect(x).toContain('name="a&lt;b"')
    expect(x).toContain('<failure message="exit code 2"/>')
    expect(x).toContain("<system-out>out &amp; </system-out>")
    expect(x).toContain('<testsuites name="winvm" tests="3" failures="1"')
  })
})
