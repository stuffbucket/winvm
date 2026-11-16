import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { diagnose } from "../src/diagnose"

interface Expectation {
  readonly instance: string
  readonly expect: readonly string[]
  readonly forbid?: readonly string[]
  readonly expectNone?: boolean
  readonly answerFile?: string
}

const ARCHIVE = resolve(import.meta.dir, "traces.zip")
const workdir = mkdtempSync(resolve(tmpdir(), "winvm-traces-"))

function extract(): void {
  if (spawnSync("unzip", ["-o", "-q", ARCHIVE, "-d", workdir]).status === 0)
    return
  if (spawnSync("tar", ["-xf", ARCHIVE, "-C", workdir]).status === 0) return
  throw new Error(`could not extract ${ARCHIVE} with unzip or tar`)
}

extract()
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const tracesDir = resolve(workdir, "traces")
const traces = existsSync(tracesDir)
  ? readdirSync(tracesDir)
      .filter((d) => !d.startsWith("."))
      .sort()
  : []

describe("diagnose against recorded traces", () => {
  it("the archive contains traces and its index", () => {
    expect(existsSync(resolve(workdir, "index.md"))).toBe(true)
    expect(existsSync(resolve(workdir, "notes", "diagnostic-notes.md"))).toBe(
      true,
    )
    expect(traces.length).toBeGreaterThan(0)
  })

  for (const trace of traces) {
    it(trace, () => {
      const dir = resolve(tracesDir, trace)
      const spec = JSON.parse(
        readFileSync(resolve(dir, "expected.json"), "utf8"),
      ) as Expectation

      process.env["WINVM_HOME"] = resolve(dir, "state")
      const answerFile =
        spec.answerFile === undefined
          ? resolve(import.meta.dir, "..", "assets", "autounattend.xml")
          : resolve(dir, spec.answerFile)
      const titles = diagnose(spec.instance, answerFile).map((f) => f.title)

      for (const wanted of spec.expect) {
        expect(titles.join("\n")).toContain(wanted)
      }
      for (const unwanted of spec.forbid ?? []) {
        expect(titles.join("\n")).not.toContain(unwanted)
      }
      if (spec.expectNone === true) expect(titles).toEqual([])
    })
  }
})
