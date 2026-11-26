import { readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

import { ensureRuntime } from "@winvm/core/runtime"
import { configuredSignList, formatSignList } from "@winvm/viewer/sign-list"

const ROOT = resolve(import.meta.dir, "..")
const POLICY_PATH =
  "repos/stuffbucket/macos-builder/contents/clients/stuffbucket/winvm.policy"

export function parseFlat(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, "").trim()
    const eq = line.indexOf("=")
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")

export function policyProblems(
  configText: string,
  policyText: string,
): string[] {
  const config = parseFlat(configText)
  const policy = parseFlat(policyText)
  const problems: string[] = []
  if (config.bundle_id !== policy.bundle_id_allowed) {
    problems.push(
      `bundle_id '${config.bundle_id ?? ""}' is not '${policy.bundle_id_allowed ?? ""}', which the policy allows`,
    )
  }
  const nested = list(config.sign_nested)
  const profiles = new Set([
    config.entitlements ?? "",
    ...nested.map((e) => e.slice(e.lastIndexOf(":") + 1)),
  ])
  for (const p of profiles) {
    if (!list(policy.entitlements_allowed).includes(p))
      problems.push(
        `entitlements '${p}' is not allowed (allowed: ${policy.entitlements_allowed ?? ""})`,
      )
  }
  for (const a of list(config.artifact ?? "dmg")) {
    if (!list(policy.artifact_allowed).includes(a))
      problems.push(
        `artifact '${a}' is not allowed (allowed: ${policy.artifact_allowed ?? ""})`,
      )
  }
  for (const [have, allowed] of [
    ["volname", "volname_allowed"],
    ["app_path", "app_path_allowed"],
  ] as const) {
    const want = policy[allowed]
    if (want !== undefined && want !== "" && config[have] !== want)
      problems.push(
        `${have} '${config[have] ?? ""}' is not '${want}', which the policy pins`,
      )
  }
  const want = policy.sign_nested_allowed
  const canonical = [...nested].sort().join(",")
  if (want !== undefined && want !== "" && canonical !== want) {
    const have = new Set(nested)
    const allowed = new Set(list(want))
    const added = [...have].filter((e) => !allowed.has(e))
    const removed = [...allowed].filter((e) => !have.has(e))
    problems.push(
      added.length + removed.length > 0
        ? `sign_nested differs from the policy's sign_nested_allowed: ` +
            `in the config only: ${added.join(", ") || "(none)"}; in the policy only: ${removed.join(", ") || "(none)"}`
        : `the policy's sign_nested_allowed holds the config's entries but not in the builder's form ` +
            `(entries sorted bytewise), which it compares byte for byte; it must read: ${canonical}`,
    )
  }
  return problems
}

function runtimeProblem(): string | undefined {
  let macho: readonly string[]
  try {
    const runtime = ensureRuntime()
    if (runtime.manifest === null)
      return `the runtime at ${runtime.dir} has no manifest`
    macho = runtime.manifest.macho
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const tauri = JSON.parse(
    readFileSync(join(ROOT, "apps/viewer/src-tauri/tauri.conf.json"), "utf8"),
  ) as { bundle: { externalBin: string[] } }
  const want = formatSignList([
    ...tauri.bundle.externalBin.map((bin) => `Contents/MacOS/${basename(bin)}`),
    ...macho.map((file) => `Contents/Resources/runtime/${file}`),
  ])
  if (configuredSignList() === want) {
    console.log(
      `sign_nested matches the app's ${String(want.split(",").length)} nested binaries`,
    )
    return undefined
  }
  return `.macos-builder/config sign_nested does not match the app's nested binaries (tauri.conf.json externalBin and the pinned runtime's manifest); it must read: ${want}`
}

function fetchPolicy(): { text: string } | { skipped: string } {
  const gh = Bun.spawnSync(
    ["gh", "api", "-H", "Accept: application/vnd.github.raw+json", POLICY_PATH],
    { stdout: "pipe", stderr: "pipe" },
  )
  return gh.exitCode === 0
    ? { text: gh.stdout.toString() }
    : {
        skipped:
          "`gh` cannot read stuffbucket/macos-builder (in CI, set the BUILDER_POLICY_TOKEN secret)",
      }
}

if (import.meta.main) {
  const failures: string[] = []
  const runtime = runtimeProblem()
  if (runtime !== undefined) failures.push(runtime)

  const config = readFileSync(join(ROOT, ".macos-builder/config"), "utf8")
  const policy = fetchPolicy()
  if ("skipped" in policy) {
    console.log(
      `::warning::Builder policy not checked: ${policy.skipped}. Check it by hand: bun scripts/preflight-signing.ts (logged in to GitHub as a maintainer).`,
    )
  } else {
    const problems = policyProblems(config, policy.text)
    if (problems.length === 0)
      console.log(
        "The config is within stuffbucket/macos-builder's policy for winvm.",
      )
    failures.push(
      ...problems.map((p) => `the builder would refuse this config: ${p}`),
    )
  }
  for (const f of failures) console.error(`::error::${f}`)
  if (failures.length > 0) {
    console.error(
      "Fix: bun apps/viewer/scripts/sign-list.ts --write <winvm.app> for the config, then get the policy in stuffbucket/macos-builder to match (docs/release-runbook.md, Changing the runtime) BEFORE the release PR merges.",
    )
    process.exit(1)
  }
}
