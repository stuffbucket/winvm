/**
 * Fails when a release would be refused by the signed build, before anyone
 * merges anything: the v0.1.3 build was refused 25 seconds in because the
 * pinned runtime had gained two Mach-O files the builder's policy did not list.
 *
 *  1. `.macos-builder/config`'s `sign_nested` must list exactly the Mach-O files
 *     of the app the pinned runtime makes (`apps/viewer/scripts/sign-list.ts
 *     --check` against the runtime from packages/core/runtime.json, with a copy
 *     of one runtime binary standing in for the compiled CLI).
 *  2. The config must be within stuffbucket/macos-builder's
 *     `clients/stuffbucket/winvm.policy`, the way the builder's "Enforce
 *     per-repo policy" step checks it. That repository is private: the policy
 *     is read with BUILDER_POLICY_TOKEN (contents: read on it) or, on a
 *     maintainer's machine, with the logged-in `gh`. Without either this part
 *     is skipped with a warning, and is then a manual check (docs/release-runbook.md).
 *
 * usage: bun scripts/preflight-signing.ts [--policy-file <path>]
 */
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const POLICY_URL = "https://api.github.com/repos/stuffbucket/macos-builder/contents/clients/stuffbucket/winvm.policy"

/** The builder's flat `key = value` format: `#` starts a comment, blank lines are ignored. */
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

/** What the builder's policy gate would refuse in `configText`, one sentence each. */
export function policyProblems(configText: string, policyText: string): string[] {
  const config = parseFlat(configText)
  const policy = parseFlat(policyText)
  const problems: string[] = []
  if (config.bundle_id !== policy.bundle_id_allowed) {
    problems.push(`bundle_id '${config.bundle_id ?? ""}' is not '${policy.bundle_id_allowed ?? ""}', which the policy allows`)
  }
  const nested = list(config.sign_nested)
  const profiles = new Set([config.entitlements ?? "", ...nested.map((e) => e.slice(e.lastIndexOf(":") + 1))])
  for (const p of profiles) {
    if (!list(policy.entitlements_allowed).includes(p)) problems.push(`entitlements '${p}' is not allowed (allowed: ${policy.entitlements_allowed ?? ""})`)
  }
  for (const a of list(config.artifact ?? "dmg")) {
    if (!list(policy.artifact_allowed).includes(a)) problems.push(`artifact '${a}' is not allowed (allowed: ${policy.artifact_allowed ?? ""})`)
  }
  for (const [have, allowed] of [
    ["volname", "volname_allowed"],
    ["app_path", "app_path_allowed"],
  ] as const) {
    const want = policy[allowed]
    if (want !== undefined && want !== "" && config[have] !== want) problems.push(`${have} '${config[have] ?? ""}' is not '${want}', which the policy pins`)
  }
  const want = policy.sign_nested_allowed
  if (want !== undefined && want !== "" && config.sign_nested !== want) {
    const have = new Set(nested)
    const allowed = new Set(list(want))
    const added = [...have].filter((e) => !allowed.has(e))
    const removed = [...allowed].filter((e) => !have.has(e))
    problems.push(
      `sign_nested differs from the policy's sign_nested_allowed, which must match exactly: ` +
        `in the config only: ${added.join(", ") || "(none)"}; in the policy only: ${removed.join(", ") || "(none)"}` +
        (added.length + removed.length === 0 ? " (same entries, different order)" : ""),
    )
  }
  return problems
}

/** Whether the pinned runtime's Mach-O files are exactly the config's `sign_nested`. */
async function runtimeProblem(): Promise<string | undefined> {
  const pin = JSON.parse(readFileSync(join(ROOT, "packages/core/runtime.json"), "utf8")) as { version: string; url: string; sha256: string }
  const tmp = mkdtempSync(join(tmpdir(), "preflight-"))
  try {
    const res = await fetch(pin.url)
    if (!res.ok) return `could not download winvm-runtime ${pin.version} (${String(res.status)} from ${pin.url})`
    const tarball = Buffer.from(await res.arrayBuffer())
    const sum = createHash("sha256").update(tarball).digest("hex")
    if (sum !== pin.sha256) return `winvm-runtime ${pin.version} is ${sum}, not the ${pin.sha256} packages/core/runtime.json pins`
    writeFileSync(join(tmp, "runtime.tar.gz"), tarball)
    mkdirSync(join(tmp, "x"))
    const tar = Bun.spawnSync(["tar", "-xzf", join(tmp, "runtime.tar.gz"), "-C", join(tmp, "x")])
    if (tar.exitCode !== 0) return `could not unpack the runtime: ${tar.stderr.toString()}`
    const app = join(tmp, "winvm.app")
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true })
    cpSync(join(tmp, "x", `winvm-runtime-${pin.version}-darwin-arm64`), join(app, "Contents", "Resources", "runtime"), { recursive: true })
    // A Mach-O stands in for the compiled CLI, which is built on the builder.
    cpSync(join(app, "Contents", "Resources", "runtime", "bin", "zstd"), join(app, "Contents", "MacOS", "winvm"))
    const check = Bun.spawnSync(["bun", join(ROOT, "apps/viewer/scripts/sign-list.ts"), "--check", app], { stdout: "pipe", stderr: "pipe" })
    if (check.exitCode === 0) {
      console.log(`${check.stdout.toString().trim()} (winvm-runtime ${pin.version})`)
      return undefined
    }
    return `winvm-runtime ${pin.version}: ${(check.stderr.toString() + check.stdout.toString()).trim()}`
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** The builder's policy for winvm, or why it could not be read. */
async function fetchPolicy(): Promise<{ text: string } | { skipped: string }> {
  const token = process.env.BUILDER_POLICY_TOKEN
  if (token !== undefined && token !== "") {
    const res = await fetch(POLICY_URL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json" } })
    return res.ok ? { text: await res.text() } : { skipped: `BUILDER_POLICY_TOKEN could not read the policy (${String(res.status)})` }
  }
  const gh = Bun.spawnSync(["gh", "api", "-H", "Accept: application/vnd.github.raw+json", POLICY_URL.replace("https://api.github.com/", "")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return gh.exitCode === 0 ? { text: gh.stdout.toString() } : { skipped: "no BUILDER_POLICY_TOKEN, and `gh` cannot read stuffbucket/macos-builder" }
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--policy-file")
  const failures: string[] = []
  const runtime = await runtimeProblem()
  if (runtime !== undefined) failures.push(runtime)

  const config = readFileSync(join(ROOT, ".macos-builder/config"), "utf8")
  const fromFile = flag > 0 ? process.argv[flag + 1] : undefined
  const policy = fromFile !== undefined ? { text: readFileSync(fromFile, "utf8") } : await fetchPolicy()
  if ("skipped" in policy) {
    console.log(`::warning::Builder policy not checked: ${policy.skipped}. Check it by hand: bun scripts/preflight-signing.ts (logged in to GitHub as a maintainer).`)
  } else {
    const problems = policyProblems(config, policy.text)
    if (problems.length === 0) console.log("The config is within stuffbucket/macos-builder's policy for winvm.")
    failures.push(...problems.map((p) => `the builder would refuse this config: ${p}`))
  }
  for (const f of failures) console.error(`::error::${f}`)
  if (failures.length > 0) {
    console.error("Fix: bun apps/viewer/scripts/sign-list.ts --write <winvm.app> for the config, then get the policy in stuffbucket/macos-builder to match (docs/release-runbook.md, Changing the runtime) BEFORE the release PR merges.")
    process.exit(1)
  }
}
