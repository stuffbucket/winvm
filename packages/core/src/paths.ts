import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import { buildIdentity } from "./identity"

export function home(): string {
  const override = process.env.WINVM_HOME
  if (override !== undefined && override !== "") return resolve(override)
  return resolve(homedir(), ".local/state/winvm")
}

export const imagesDir = (): string => resolve(home(), "images")
export const instancesDir = (): string => resolve(home(), "instances")
export const mediaDir = (): string => resolve(home(), "media")

const isCompiled = (modulePath: string): boolean =>
  modulePath.startsWith("/$bunfs/")

export function packageDirFor(o: {
  readonly modulePath: string
  readonly execPath: string
  readonly env: Readonly<Record<string, string | undefined>>
}): string {
  const own = o.env.WINVM_PACKAGE_DIR
  if (own !== undefined && own !== "") return resolve(own)
  if (isCompiled(o.modulePath))
    return resolve(
      dirname(o.execPath),
      "..",
      "Resources",
      "winvm",
      "packages",
      "core",
    )
  return resolve(dirname(o.modulePath), "..")
}

export const PACKAGE_DIR = packageDirFor({
  modulePath: import.meta.path,
  execPath: process.execPath,
  env: process.env,
})

export const cliArgvFor = (
  o: { readonly compiled: boolean; readonly entry: string },
  argv: readonly string[],
): readonly string[] => (o.compiled ? [...argv] : [o.entry, ...argv])

export const cliArgv = (...argv: string[]): readonly string[] =>
  cliArgvFor(
    { compiled: isCompiled(import.meta.path), entry: cliEntry() },
    argv,
  )

export function cliEntry(): string {
  const cli = process.env.WINVM_CLI
  if (cli === undefined || cli === "")
    throw new Error("WINVM_CLI is not set: start winvm through apps/cli")
  return cli
}

export function recordCliEntry(path: string): void {
  process.env.WINVM_CLI = isCompiled(path) ? process.execPath : path
  process.env.WINVM_BUILD_ID = buildIdentity()
}

export const NO_RECONCILE = "WINVM_NO_RECONCILE"

export const managedEnv = (
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({ ...env, [NO_RECONCILE]: "1" })

export function pinnedBunVersion(): string | null {
  const f = resolve(PACKAGE_DIR, "..", "..", ".bun-version")
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null
}

export function bunVersionWarning(
  running: string,
  pinned: string | null,
): string | null {
  if (pinned === null || running === pinned) return null
  return (
    `warning: winvm is running on Bun ${running}; this checkout pins ${pinned} (.bun-version). ` +
    `Run it inside the repository, or with \`mise exec -C ${resolve(PACKAGE_DIR, "..", "..")} -- winvm …\`.`
  )
}

export const imageDir = (image: string): string => resolve(imagesDir(), image)
export const basePath = (image: string): string =>
  resolve(imageDir(image), "base.qcow2")
export const imageMetaPath = (image: string): string =>
  resolve(imageDir(image), "image.json")
export const instanceDir = (name: string): string =>
  resolve(instancesDir(), name)

export const media = {
  iso: (): string => resolve(mediaDir(), "windows-arm64.iso"),
  tools: (): string => resolve(mediaDir(), "utm-guest-tools.iso"),
  pwsh: (): string => resolve(mediaDir(), "PowerShell-win-arm64.msi"),
  seed: (): string => resolve(mediaDir(), "seed.iso"),
  seedDir: (): string => resolve(mediaDir(), "seed"),
} as const

export interface Paths {
  readonly dir: string
  readonly overlay: string
  readonly vars: string
  readonly prime: string
  readonly tpmDir: string
  readonly tpmSock: string
  readonly qga: string
  readonly qmp: string
  readonly qgaQemu: string
  readonly qmpQemu: string
  readonly service: string
  readonly control: string
  readonly events: string
  readonly eventsPrev: string
  readonly reconcile: string
  readonly lease: string
  readonly pid: string
  readonly serial: string
  readonly serialPrev: string
  readonly qemuLog: string
  readonly result: string
  readonly meta: string
}

export const monitorBeside = (qgaSock: string): string =>
  resolve(dirname(qgaSock), "qmp.sock")

export function pathsFor(name: string): Paths {
  const dir = instanceDir(name)
  return {
    dir,
    overlay: resolve(dir, "overlay.qcow2"),
    vars: resolve(dir, "efi-vars.qcow2"),
    prime: resolve(dir, "prime.qcow2"),
    tpmDir: resolve(dir, "tpm"),
    tpmSock: resolve(dir, "tpm/swtpm-sock"),
    qga: resolve(dir, "qga.sock"),
    qmp: resolve(dir, "qmp.sock"),
    qgaQemu: resolve(dir, "qga-qemu.sock"),
    qmpQemu: resolve(dir, "qmp-qemu.sock"),
    service: resolve(dir, "service.json"),
    control: resolve(dir, "control.sock"),
    events: resolve(dir, "events.jsonl"),
    eventsPrev: resolve(dir, "events.prev.jsonl"),
    reconcile: resolve(dir, "reconcile.lock"),
    lease: resolve(dir, "lease.json"),
    pid: resolve(dir, "qemu.pid"),
    serial: resolve(dir, "serial.log"),
    serialPrev: resolve(dir, "serial.prev.log"),
    qemuLog: resolve(dir, "qemu.log"),
    result: resolve(dir, "result.img"),
    meta: resolve(dir, "instance.json"),
  }
}

export interface InstanceMeta {
  readonly image: string
  readonly vnc: number
  readonly created: string
}

export interface ImageMeta {
  readonly virtioBoot: boolean
  readonly created: string
  readonly runtime?: string
  readonly isoSha256?: string
  readonly guestToolsSha256?: string
}

export const newImageMeta = (m: Required<ImageMeta>): ImageMeta => ({ ...m })

export function readImageMeta(image: string): ImageMeta | null {
  const f = imageMetaPath(image)
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, "utf8")) as ImageMeta
}

export function readMeta(name: string): InstanceMeta | null {
  const f = pathsFor(name).meta
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, "utf8")) as InstanceMeta
}

export function listInstances(): readonly string[] {
  if (!existsSync(instancesDir())) return []
  return readdirSync(instancesDir()).filter((d) => existsSync(pathsFor(d).meta))
}

export function listImages(): readonly string[] {
  if (!existsSync(imagesDir())) return []
  return readdirSync(imagesDir()).filter((d) => existsSync(basePath(d)))
}

export function allocateVnc(): number {
  const taken = new Set(listInstances().map((n) => readMeta(n)?.vnc))
  for (let i = 1; i < 100; i += 1) if (!taken.has(i)) return i
  throw new Error("no free VNC display")
}
