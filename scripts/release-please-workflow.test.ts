import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const workflow = readFileSync(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8")

function dispatchScript(): string {
  const step = workflow.indexOf("      - name: Dispatch CI for the release PR head\n")
  const start = workflow.indexOf("        run: |\n", step) + "        run: |\n".length
  const end = workflow.indexOf("\n      - ", start)
  return workflow
    .slice(start, end === -1 ? undefined : end)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n")
}

test("release PR discovery retries an empty result and fails after the final attempt", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "winvm-release-pr-"))
  const calls = resolve(dir, "calls")
  const gh = resolve(dir, "gh")
  const sleep = resolve(dir, "sleep")
  writeFileSync(gh, '#!/bin/sh\nprintf "call\\n" >> "$CALLS"\nprintf "[]\\n"\n')
  writeFileSync(sleep, "#!/bin/sh\nexit 0\n")
  chmodSync(gh, 0o755)
  chmodSync(sleep, 0o755)

  try {
    const result = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", dispatchScript()], {
      env: {
        ...process.env,
        CALLS: calls,
        GITHUB_REPOSITORY: "stuffbucket/winvm",
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      },
    })

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
