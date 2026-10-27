import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { relative, resolve } from "node:path"

import pinned from "../runtime.json"
import { download } from "./host"

export interface RuntimePin {
  readonly version: string
  readonly url: string
  readonly sha256: string
}

export interface RuntimeManifest {
  readonly name: string
  readonly version: string
  readonly qemu: string
  readonly qemuPatches: string
  readonly components: Readonly<Record<string, string>>
  readonly macho: readonly string[]
  readonly files: Readonly<Record<string, string>>
}

export type RuntimeSource = "override" | "app" | "cache"

export interface Runtime {
  readonly dir: string
  readonly source: RuntimeSource
  readonly manifest: RuntimeManifest | null
}

export type RuntimeBinary = "qemu-system-aarch64" | "qemu-img" | "swtpm" | "zstd"

export interface FindOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly execPath?: string
  readonly cache?: string
  readonly pin?: RuntimePin
}

export class RuntimeMissing extends Error {
  constructor() {
    super("winvm's runtime (QEMU, swtpm, zstd) is not installed — run `winvm setup`")
  }
}

export const runtimePin = (): RuntimePin => pinned

export function runtimeCache(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const own = env["WINVM_RUNTIME_CACHE"]
  if (own !== undefined && own !== "") return resolve(own)
  const data = env["XDG_DATA_HOME"]
  return resolve(data !== undefined && data !== "" ? data : resolve(homedir(), ".local", "share"), "winvm", "runtime")
}

function readManifest(dir: string): RuntimeManifest | null {
  try {
    return JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as RuntimeManifest
  } catch {
    return null
  }
}

function appRuntimeDir(execPath: string): string | null {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  if (m === null) return null
  const dir = resolve(m[1] ?? "", "Contents", "Resources", "runtime")
  return existsSync(resolve(dir, "manifest.json")) ? dir : null
}

export function findRuntime(o: FindOptions = {}): Runtime | null {
  const env = o.env ?? process.env
  const override = env["WINVM_RUNTIME"]
  if (override !== undefined && override !== "") {
    const dir = resolve(override)
    return { dir, source: "override", manifest: readManifest(dir) }
  }
  const app = appRuntimeDir(o.execPath ?? process.execPath)
  if (app !== null) return { dir: app, source: "app", manifest: readManifest(app) }
  const pin = o.pin ?? runtimePin()
  const cached = resolve(o.cache ?? runtimeCache(env), pin.version)
  const manifest = readManifest(cached)
  if (manifest === null || manifest.version !== pin.version) return null
  return { dir: cached, source: "cache", manifest }
}

export function runtimeBin(name: RuntimeBinary, o: FindOptions = {}): string {
  const rt = findRuntime(o)
  if (rt === null) throw new RuntimeMissing()
  return resolve(rt.dir, "bin", name)
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

const codesignOk = (path: string): boolean =>
  spawnSync("codesign", ["--verify", "--strict", path], { stdio: "ignore" }).status === 0

function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = resolve(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p))
    }
  }
  walk(dir)
  return out
}

export function verifyRuntime(rt: Runtime, o: { readonly signatureOk?: (path: string) => boolean } = {}): readonly string[] {
  const m = rt.manifest
  if (m === null) return ["no manifest.json"]
  const signatureOk = o.signatureOk ?? codesignOk
  const macho = new Set(m.macho)
  const problems: string[] = []
  for (const [file, digest] of Object.entries(m.files)) {
    const path = resolve(rt.dir, file)
    if (!existsSync(path)) problems.push(`${file} is missing`)
    else if (rt.source === "app" && macho.has(file)) {
      if (!signatureOk(path)) problems.push(`${file} has no valid signature`)
    } else if (sha256File(path) !== digest) problems.push(`${file} does not match manifest.json`)
  }
  if (rt.source !== "app") {
    for (const file of filesUnder(rt.dir)) {
      if (file !== "manifest.json" && !(file in m.files)) problems.push(`${file} is not in manifest.json`)
    }
  }
  return problems
}

export async function ensureRuntime(o: { readonly pin?: RuntimePin; readonly cache?: string } = {}): Promise<Runtime> {
  const pin = o.pin ?? runtimePin()
  const cache = o.cache ?? runtimeCache()
  const found = findRuntime({ env: {}, execPath: "", cache, pin })
  if (found !== null && verifyRuntime(found).length === 0) return found

  mkdirSync(cache, { recursive: true })
  const work = mkdtempSync(resolve(cache, ".fetch-"))
  try {
    const tarball = resolve(work, `winvm-runtime-${pin.version}.tar.gz`)
    download(pin.url, tarball, pin.sha256)
    const unpacked = resolve(work, "unpacked")
    mkdirSync(unpacked)
    if (spawnSync("tar", ["-xzf", tarball, "-C", unpacked], { stdio: "inherit" }).status !== 0) {
      throw new Error(`could not unpack ${pin.url}`)
    }
    const [top] = readdirSync(unpacked)
    const staged = resolve(unpacked, top ?? "")
    const rt: Runtime = { dir: staged, source: "cache", manifest: readManifest(staged) }
    const problems = verifyRuntime(rt)
    if (rt.manifest?.version !== pin.version || problems.length > 0) {
      throw new Error(`the runtime from ${pin.url} is not ${pin.version} as pinned: ${problems.join("; ")}`)
    }
    const dest = resolve(cache, pin.version)
    rmSync(dest, { recursive: true, force: true })
    renameSync(staged, dest)
    return { dir: dest, source: "cache", manifest: rt.manifest }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export const qemuCompat = (m: RuntimeManifest): string => `${m.qemu}+patches:${m.qemuPatches}`

export function currentQemuCompat(o: FindOptions = {}): string {
  const rt = findRuntime(o)
  if (rt === null) throw new RuntimeMissing()
  return rt.manifest === null ? `override:${rt.dir}` : qemuCompat(rt.manifest)
}
