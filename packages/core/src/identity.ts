/**
 * Which build of winvm is this?
 *
 * The control service and the idle watcher are detached on purpose, so an
 * application update can leave them running an older build while the CLI path
 * that started them — and the package version — are unchanged. Comparing paths
 * therefore cannot tell old from new; this identity can. It is a hash of the
 * content that defines the executable, so it changes whenever that content can.
 *
 * Three sources, in priority order, all resolving to one `sha256:<hex>` string:
 *   1. the value embedded when the sidecar was compiled (`--define WINVM_BUILD_ID`),
 *      which needs no file lookup at run time;
 *   2. `WINVM_BUILD_ID` in the environment, so a detached child reports exactly
 *      the generation of the CLI that spawned it rather than re-deriving one;
 *   3. a hash of this checkout's sources, for running from source.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

/** Set by `bun build --compile --define`; absent when running from source. */
declare const WINVM_BUILD_ID: string | undefined

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

/** Hashed whole, in addition to every `.ts` under the source directories below. */
const INPUT_FILES = [
  "package.json",
  "apps/cli/package.json",
  "packages/core/package.json",
  ".bun-version",
  "pnpm-lock.yaml",
  "packages/core/runtime.json",
  "apps/viewer/scripts/build-sidecar.ts",
] as const
const SOURCE_DIRS = ["apps/cli/src", "packages/core/src"] as const

export interface IdentityEntry {
  readonly path: string
  readonly bytes: Uint8Array
}

/**
 * Deterministic identity of a set of files plus the versions they run on.
 * Entries are sorted by path, and every field is length-prefixed so that moving
 * a byte from one field to the next cannot produce the same digest.
 */
export function identityFromEntries(entries: readonly IdentityEntry[], version: string, bunVersion: string): string {
  const h = createHash("sha256")
  const field = (b: Uint8Array): void => {
    const len = Buffer.alloc(8)
    len.writeBigUInt64BE(BigInt(b.byteLength))
    h.update(len)
    h.update(b)
  }
  const text = (s: string): void => field(new TextEncoder().encode(s))
  text(version)
  text(bunVersion)
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const e of sorted) {
    text(e.path)
    field(e.bytes)
  }
  return `sha256:${h.digest("hex")}`
}

function tsFilesUnder(root: string, rel: string): readonly string[] {
  const dir = resolve(root, rel)
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const child = `${rel}/${d.name}`
    if (d.isDirectory()) out.push(...tsFilesUnder(root, child))
    else if (d.isFile() && d.name.endsWith(".ts")) out.push(child)
  }
  return out
}

function packageVersion(root: string, rel: string): string {
  const f = resolve(root, rel)
  if (!existsSync(f)) return ""
  try {
    const v = (JSON.parse(readFileSync(f, "utf8")) as { version?: unknown }).version
    return typeof v === "string" ? v : ""
  } catch {
    return ""
  }
}

/** Hash of the CLI and core sources and the inputs that decide how they build and run. */
export function sourceBuildIdentity(root: string = REPO_ROOT): string {
  const rels = [...SOURCE_DIRS.flatMap((d) => tsFilesUnder(root, d)), ...INPUT_FILES.filter((f) => existsSync(resolve(root, f)))]
  const entries = rels.map((path) => ({ path, bytes: readFileSync(resolve(root, path)) }))
  const version = `${packageVersion(root, "apps/cli/package.json")}+${packageVersion(root, "packages/core/package.json")}`
  return identityFromEntries(entries, version, Bun.version)
}

/** The identity to use, given what is fixed already. `source` runs only when nothing else is. */
export function selectBuildIdentity(o: {
  readonly embedded: string | undefined
  readonly env: string | undefined
  readonly source: () => string
}): string {
  if (o.embedded !== undefined && o.embedded !== "") return o.embedded
  if (o.env !== undefined && o.env !== "") return o.env
  return o.source()
}

let memo: string | undefined

/** This process's build identity, decided once: it must not drift if sources change under a running process. */
export function buildIdentity(): string {
  memo ??= selectBuildIdentity({
    embedded: typeof WINVM_BUILD_ID === "string" ? WINVM_BUILD_ID : undefined,
    env: process.env["WINVM_BUILD_ID"],
    source: () => sourceBuildIdentity(),
  })
  return memo
}
