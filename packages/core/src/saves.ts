import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"

import type { Size } from "./cua"
import { encodePng, fitScale, parsePpm, resize, scaled } from "./cua"
import type { DisplayConfig } from "./display"
import {
  displayArgs,
  displayFromCommandLine,
  LEGACY_SIZE_BOUNDS,
  parseDisplayConfig,
  RAMFB,
  readDisplay,
  rejectedLegacySize,
  runningCommand,
  sameDevice,
  sharesFolderFromCommandLine,
  VIRTIO_GPU,
} from "./display"
import * as finder from "./finder"
import type { Hardware } from "./hardware"
import { hardwareFrom, LEGACY, readHardware, runningHardware } from "./hardware"
import { requireFirmware } from "./host"
import { ensureInstance } from "./instance"
import { launchedRuntime } from "./kept"
import type { Note } from "./notes"
import { copyNote, readNote, removeNote, removeNotes } from "./notes"
import {
  clearSavingRunning,
  markSavingRunning,
  withOperation,
} from "./operation"
import type { InstanceMeta, Paths } from "./paths"
import {
  basePath,
  home,
  imageMetaPath,
  instanceDir,
  pathsFor,
  readImageMeta,
  readMeta,
} from "./paths"
import { processAgeMs } from "./proc"
import * as qemu from "./qemu"
import * as qmp from "./qmp"
import {
  currentQemuCompat,
  qemuCompat,
  runtimeBin,
  runtimeManifestAt,
} from "./runtime"
import { nameError } from "./savename"
import { capture } from "./shell"
import { instanceOf } from "./smbstate"

export const SAVE_KINDS = [
  "manual",
  "auto",
  "baseline",
  "stow",
  "golden",
] as const
export type SaveKind = (typeof SAVE_KINDS)[number]

export const BASELINE = "baseline"
export const STOW = "stow"
export const GOLDEN = "golden"

export const RAM_FORMATS = ["zstd", "mapped", "raw"] as const
export type RamFormat = (typeof RAM_FORMATS)[number]

export const MULTIFD_CHANNELS = 8

export interface CompatParts {
  readonly base: string
  readonly hardware: string
  readonly firmware: string
  readonly qemu: string
}

export interface Manifest {
  readonly name: string
  readonly instance: string
  readonly kind: SaveKind
  readonly createdAt: string
  readonly bytes: number
  readonly compat: string
  readonly image: string
  readonly note?: string
  readonly compatParts?: CompatParts
  readonly ramFile?: string
  readonly ramBytes?: number
  readonly saveMs?: number
  readonly format?: RamFormat
  readonly clonedFrom?: {
    readonly instance: string
    readonly createdAt: string
  }
  readonly screenshot?: string
  readonly thumbnail?: string
  readonly screenSize?: { readonly width: number; readonly height: number }
  readonly hardware?: Hardware
  readonly display?: DisplayConfig
}

export const FILES = {
  manifest: "manifest.json",
  ram: "vmstate.zst",
  ramRaw: "vmstate.bin",
  ramMapped: "vmstate.mapped",
  overlay: "overlay.qcow2",
  vars: "efi-vars.qcow2",
  screen: "screen.png",
  thumb: "thumb.png",
} as const

export const THUMB_BOX: Size = { width: 480, height: 300 }

export const savesRoot = (): string => resolve(home(), "saves")
export const savesDir = (instance: string): string =>
  resolve(savesRoot(), instance)
export const saveDir = (instance: string, name: string): string =>
  resolve(savesDir(instance), name)

export function defaultName(d: Date): string {
  const z = (n: number): string => String(n).padStart(2, "0")
  return (
    `${String(d.getFullYear())}-${z(d.getMonth() + 1)}-${z(d.getDate())}_` +
    `${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`
  )
}

export function parseManifest(text: string): Manifest {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof o !== "object" || o === null || Array.isArray(o))
    throw new Error("manifest is not an object")
  const r = o as Record<string, unknown>
  const str = (k: string): string => {
    const v = r[k]
    if (typeof v !== "string" || v === "")
      throw new Error(`manifest.${k} must be a non-empty string`)
    return v
  }
  const name = str("name")
  const err = nameError(name)
  if (err !== null) throw new Error(`manifest.name: ${err}`)
  const kind = str("kind")
  if (!(SAVE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `manifest.kind must be one of ${SAVE_KINDS.join(", ")}, got "${kind}"`,
    )
  }
  const createdAt = str("createdAt")
  if (Number.isNaN(Date.parse(createdAt)))
    throw new Error(`manifest.createdAt is not a date: "${createdAt}"`)
  const bytes = r.bytes
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    throw new Error("manifest.bytes must be a non-negative number")
  }
  const note = r.note
  if (note !== undefined && typeof note !== "string")
    throw new Error("manifest.note must be a string")
  const format = r.format
  if (
    format !== undefined &&
    !(RAM_FORMATS as readonly unknown[]).includes(format)
  ) {
    throw new Error(
      `manifest.format must be one of ${RAM_FORMATS.join(", ")}, got ${JSON.stringify(format)}`,
    )
  }
  const hw = r.hardware
  if (hw !== undefined) {
    const h = hw as Record<string, unknown> | null
    const whole = (v: unknown): boolean =>
      typeof v === "number" && Number.isInteger(v) && v > 0
    if (
      typeof hw !== "object" ||
      h === null ||
      !whole(h.cpus) ||
      !whole(h.memoryMiB)
    ) {
      throw new Error(
        "manifest.hardware must be { cpus, memoryMiB }, positive whole numbers",
      )
    }
  }
  let display: DisplayConfig | undefined
  if (Object.hasOwn(r, "display")) {
    const parsed = parseDisplayConfig(r.display)
    if (parsed === null)
      throw new Error(
        "manifest.display must be ramfb or virtio-gpu (optionally with a legacySize of whole numbers)",
      )
    display = parsed
  }
  return {
    ...(r as object),
    ...(display === undefined ? {} : { display }),
    name,
    instance: str("instance"),
    kind: kind as SaveKind,
    createdAt,
    bytes,
    compat: str("compat"),
    image: str("image"),
  }
}

export const saveHardware = (m: Pick<Manifest, "hardware">): Hardware =>
  m.hardware === undefined ? LEGACY : hardwareFrom(m.hardware)

const sha = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex")

const PLUMBING = new Set([
  "-name",
  "-vnc",
  "-qmp",
  "-serial",
  "-pidfile",
  "-display",
  "-loadvm",
  "-incoming",
  "-rtc",
])

export function hardwareArgs(argv: readonly string[]): readonly string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined) continue
    if (a === "-snapshot") continue
    if (PLUMBING.has(a)) {
      i += 1
      continue
    }
    out.push(
      a
        .split(",")
        .map((kv) => kv.replace(/^(file|path)=.*$/, "$1=*"))
        .join(","),
    )
  }
  return out
}

export function baseIdentity(
  image: string,
  size: number,
  mtimeMs: number,
  created: string,
): string {
  return sha(JSON.stringify([image, size, Math.round(mtimeMs), created])).slice(
    0,
    16,
  )
}

export function compatHash(parts: CompatParts): string {
  return sha(
    JSON.stringify([
      "winvm-save-v1",
      parts.base,
      parts.hardware,
      parts.firmware,
      parts.qemu,
    ]),
  ).slice(0, 16)
}

export function compatDiff(
  saved: CompatParts,
  now: CompatParts,
): readonly string[] {
  const out: string[] = []
  if (saved.base !== now.base)
    out.push("the base image was rebuilt or replaced")
  if (saved.hardware !== now.hardware)
    out.push("the virtual hardware (QEMU arguments) changed")
  if (saved.firmware !== now.firmware) out.push("the UEFI firmware changed")
  if (saved.qemu !== now.qemu)
    out.push(`QEMU changed (${saved.qemu} -> ${now.qemu})`)
  return out
}

export type CompatPart = keyof CompatParts

export function compatDiffKeys(
  saved: CompatParts,
  now: CompatParts,
): CompatPart[] {
  return (["base", "hardware", "firmware", "qemu"] as const).filter(
    (k) => saved[k] !== now[k],
  )
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u] ?? "?"}`
}

export const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

export function ramFormatOf(
  m: Pick<Manifest, "format" | "ramFile">,
): RamFormat {
  if (m.format !== undefined) return m.format
  if (m.ramFile === FILES.ramRaw) return "raw"
  if (m.ramFile === FILES.ramMapped) return "mapped"
  return "zstd"
}

export const ramFileFor = (f: RamFormat): string =>
  f === "mapped" ? FILES.ramMapped : f === "raw" ? FILES.ramRaw : FILES.ram

export interface MigrationPlan {
  readonly capabilities: readonly {
    readonly capability: string
    readonly state: boolean
  }[]
  readonly parameters: Readonly<Record<string, unknown>>
  readonly uri: string
  readonly incoming: string
}

export function migrationPlan(
  format: RamFormat,
  ramPath: string,
  zstd: string,
  channels = MULTIFD_CHANNELS,
): MigrationPlan {
  const mapped = format === "mapped"
  const capabilities = [
    { capability: "mapped-ram", state: mapped },
    { capability: "multifd", state: mapped },
  ]
  const parameters: Record<string, unknown> = {
    "max-bandwidth": 64 * 1024 ** 3,
  }
  if (mapped) parameters["multifd-channels"] = channels
  switch (format) {
    case "zstd":
      return {
        capabilities,
        parameters,
        uri: `exec:${shQuote(zstd)} -T0 -3 -q -f - -o ${shQuote(ramPath)}`,
        incoming: `exec:${shQuote(zstd)} -dc ${shQuote(ramPath)}`,
      }
    case "raw":
      return {
        capabilities,
        parameters,
        uri: `file:${ramPath}`,
        incoming: `file:${ramPath}`,
      }
    case "mapped":
      return {
        capabilities,
        parameters,
        uri: `file:${ramPath}`,
        incoming: "defer",
      }
  }
}

let firmwareDigest: string | null = null

export const UNKNOWN_RUNTIME = "unknown"
const UNKNOWN_PATCHES = "+patches:unknown"

export const isUnknownRuntime = (qemu: string | undefined): boolean =>
  qemu === UNKNOWN_RUNTIME || qemu?.endsWith(UNKNOWN_PATCHES) === true

export const versionOfRuntime = (qemu: string): string =>
  qemu.split("+patches:")[0] ?? qemu

export function sameQemu(saved: string, installed: string): boolean {
  if (saved === installed) return true
  if (!saved.endsWith(UNKNOWN_PATCHES)) return false
  return installed.startsWith(saved.slice(0, -"unknown".length))
}

function reportedVersion(answer: unknown): string | null {
  const q = (answer as { qemu?: Record<string, unknown> } | null)?.qemu
  if (q === undefined) return null
  const parts = [q.major, q.minor, q.micro]
  return parts.every((n) => typeof n === "number")
    ? parts.map(String).join(".")
    : null
}

export async function producedBy(
  p: Paths,
  pid: number,
  command: string | null,
): Promise<string> {
  const kept = await launchedRuntime(p, pid).catch(() => null)
  if (kept !== null) return kept
  const version = reportedVersion(
    await qmp.execute(p.qmp, "query-version").catch(() => null),
  )
  if (version === null) return UNKNOWN_RUNTIME
  const program =
    command === null
      ? null
      : (/(?:^|\s)(\S*\/bin\/qemu-system-[A-Za-z0-9_]+)(?:\s|$)/.exec(
          command,
        )?.[1] ?? null)
  const at =
    program === null ? null : runtimeManifestAt(dirname(dirname(program)))
  const age = processAgeMs(pid)
  if (
    at !== null &&
    at.manifest.qemu === version &&
    age !== null &&
    at.mtimeMs <= Date.now() - age
  )
    return qemuCompat(at.manifest)
  return `${version}${UNKNOWN_PATCHES}`
}

export function currentCompat(
  instance: string,
  meta: InstanceMeta,
  display?: DisplayConfig,
  hardware?: Hardware,
  launched?: string,
): { readonly hash: string; readonly parts: CompatParts } {
  const st = statSync(basePath(meta.image))
  let created = ""
  try {
    created = readFileSync(imageMetaPath(meta.image), "utf8")
  } catch {}
  firmwareDigest ??= sha(readFileSync(requireFirmware().code)).slice(0, 16)
  const argv = qemu.qemuArgs(instance, pathsFor(instance), meta, {
    installMedia: false,
    ephemeral: false,
    virtioBoot: readImageMeta(meta.image)?.virtioBoot === true,
    ...(display === undefined ? {} : { display }),
    ...(hardware === undefined ? {} : { hardware }),
  })
  const parts: CompatParts = {
    base: baseIdentity(meta.image, st.size, st.mtimeMs, created),
    hardware: sha(JSON.stringify(hardwareArgs(argv))).slice(0, 16),
    firmware: firmwareDigest,
    qemu: launched ?? currentQemuCompat(),
  }
  return { hash: compatHash(parts), parts }
}

export function compatFor(
  instance: string,
  meta: InstanceMeta,
  m: Pick<Manifest, "hardware" | "display" | "compatParts">,
): ReturnType<typeof currentCompat> & { readonly display: DisplayConfig } {
  const display = m.display ?? readDisplay(pathsFor(instance))
  const saved = m.compatParts?.qemu
  const launched =
    saved !== undefined && sameQemu(saved, currentQemuCompat())
      ? saved
      : undefined
  return {
    ...currentCompat(instance, meta, display, saveHardware(m), launched),
    display,
  }
}

export function hardwareBeforeDevices(
  instance: string,
  meta: InstanceMeta,
  hardware: Hardware = LEGACY,
): string | null {
  const o = {
    installMedia: false,
    ephemeral: false,
    virtioBoot: readImageMeta(meta.image)?.virtioBoot === true,
    hardware,
  }
  const p = pathsFor(instance)
  const now = qemu.qemuArgs(instance, p, meta, o)
  const before = qemu.qemuArgs(instance, p, meta, {
    ...o,
    shareDevices: "none",
  })
  if (now.join(" ") === before.join(" ")) return null
  return sha(JSON.stringify(hardwareArgs(before))).slice(0, 16)
}

export const takenBeforeDevices = (
  m: Pick<Manifest, "compatParts">,
  before: string | null,
): boolean => before !== null && m.compatParts?.hardware === before

export function strandedByDevices(instance: string): readonly string[] {
  const meta = readMeta(instance)
  if (meta === null) return []
  let before: string | null
  try {
    before = hardwareBeforeDevices(instance, meta)
  } catch {
    return []
  }
  if (before === null) return []
  return listSaves(instance).flatMap((s) =>
    s.manifest !== null && takenBeforeDevices(s.manifest, before)
      ? [s.name]
      : [],
  )
}

export function strandedNote(
  instance: string,
  names: readonly string[],
): string | null {
  if (names.length === 0) return null
  const flag = instance === "default" ? "" : ` -i ${instance}`
  return (
    `${String(names.length)} save${names.length === 1 ? "" : "s"} of "${instance}" (${names.join(", ")}) ` +
    `${names.length === 1 ? "was" : "were"} taken before winvm added the shared folder and clipboard devices and will not load. ` +
    `They are kept; \`winvm saves${flag} rm <name>\` deletes one.`
  )
}

export interface Listed {
  readonly name: string
  readonly manifest: Manifest | null
  readonly error?: string
}

export function readSave(instance: string, name: string): Manifest | null {
  try {
    return parseManifest(
      readFileSync(resolve(saveDir(instance, name), FILES.manifest), "utf8"),
    )
  } catch {
    return null
  }
}

export type IncompatibleReason =
  | "base"
  | "hardware"
  | "display"
  | "firmware"
  | "qemu"

export interface SaveEntry {
  readonly name: string
  readonly kind: SaveKind
  readonly createdAt: string
  readonly bytes: number
  readonly format: RamFormat
  readonly compatible: boolean | null
  readonly incompatible?: readonly IncompatibleReason[]
  readonly note?: string
  readonly screenshot: string | null
  readonly thumbnail: string | null
  readonly screenSize?: { readonly width: number; readonly height: number }
  readonly title: string | null
  readonly notes: Note | null
  readonly why?: string
}

export interface ReportContext {
  readonly compat: { readonly hash: string; readonly parts: CompatParts } | null
  readonly displayHardware?: readonly string[]
  readonly beforeDevices?: string | null
  readonly file?: (save: string, file: string) => string | null
  readonly note?: (save: string) => Note | null
  readonly at?: (
    hw: Hardware,
    display?: DisplayConfig,
    image?: string,
  ) => Pick<ReportContext, "compat" | "displayHardware">
}

const contextFor = (m: Manifest, ctx: ReportContext): ReportContext =>
  ctx.at === undefined
    ? ctx
    : { ...ctx, ...ctx.at(saveHardware(m), m.display, m.image) }

function reasons(m: Manifest, ctx: ReportContext): IncompatibleReason[] | null {
  if (
    ctx.compat === null ||
    m.compat === ctx.compat.hash ||
    m.compatParts === undefined
  )
    return null
  const saved = m.compatParts
  const out = compatDiffKeys(saved, ctx.compat.parts).map(
    (k): IncompatibleReason =>
      k === "hardware" && (ctx.displayHardware ?? []).includes(saved.hardware)
        ? "display"
        : k,
  )
  return out.length > 0 ? out : null
}

function sameRuntimeContext(m: Manifest, c: ReportContext): ReportContext {
  const saved = m.compatParts?.qemu
  if (
    c.compat === null ||
    saved === undefined ||
    saved === c.compat.parts.qemu ||
    !sameQemu(saved, c.compat.parts.qemu)
  )
    return c
  const parts = { ...c.compat.parts, qemu: saved }
  return { ...c, compat: { hash: compatHash(parts), parts } }
}

export function savesReport(
  rows: readonly Listed[],
  ctx: ReportContext,
): SaveEntry[] {
  const file = ctx.file ?? ((): null => null)
  const note = ctx.note ?? ((): null => null)
  return rows.flatMap((r) => {
    const m = r.manifest
    if (m === null) return []
    const c = sameRuntimeContext(m, contextFor(m, ctx))
    const differ = reasons(m, c)
    const n = note(r.name)
    return [
      {
        name: m.name,
        kind: m.kind,
        createdAt: m.createdAt,
        bytes: m.bytes,
        format: ramFormatOf(m),
        compatible: c.compat === null ? null : m.compat === c.compat.hash,
        ...(differ === null ? {} : { incompatible: differ }),
        ...(m.note === undefined ? {} : { note: m.note }),
        ...(c.compat !== null &&
        m.compat !== c.compat.hash &&
        takenBeforeDevices(m, ctx.beforeDevices ?? null)
          ? { why: "taken before the shared folder and clipboard devices" }
          : {}),
        screenshot: file(r.name, FILES.screen),
        thumbnail: file(r.name, FILES.thumb),
        ...(m.screenSize === undefined ? {} : { screenSize: m.screenSize }),
        title: n?.title ?? null,
        notes: n,
      },
    ]
  })
}

export function saveFile(
  instance: string,
  save: string,
  file: string,
): string | null {
  const path = resolve(saveDir(instance, save), file)
  return existsSync(path) ? path : null
}

export function reportContext(instance: string): ReportContext {
  const meta = readMeta(instance)
  const measured = new Map<
    string,
    Pick<ReportContext, "compat" | "displayHardware">
  >()
  const at = (
    hw?: Hardware,
    shown?: DisplayConfig,
    image?: string,
  ): Pick<ReportContext, "compat" | "displayHardware"> => {
    const standIn: InstanceMeta | null =
      meta ??
      (shown !== undefined && image !== undefined
        ? { image, vnc: 0, created: "" }
        : null)
    const key = [
      hw === undefined ? "" : `${String(hw.cpus)}/${String(hw.memoryMiB)}`,
      shown === undefined ? "" : displayArgs(shown).join(" "),
      meta === null ? (image ?? "") : "",
    ].join("|")
    const seen = measured.get(key)
    if (seen !== undefined) return seen
    let compat: ReportContext["compat"] = null
    let displayHardware: string[] = []
    try {
      if (standIn !== null) {
        compat = currentCompat(instance, standIn, shown, hw)
        const own = shown ?? readDisplay(pathsFor(instance))
        displayHardware = [RAMFB, VIRTIO_GPU]
          .filter((d) => !sameDevice(d, own))
          .map((d) => currentCompat(instance, standIn, d, hw).parts.hardware)
      }
    } catch {}
    const out = { compat, displayHardware }
    measured.set(key, out)
    return out
  }
  let beforeDevices: string | null = null
  try {
    if (meta !== null) beforeDevices = hardwareBeforeDevices(instance, meta)
  } catch {}
  return {
    ...at(),
    beforeDevices,
    at,
    file: (save, f) => saveFile(instance, save, f),
    note: (save) => readNoteSafe(instance, save),
  }
}

export function listSaves(instance: string): readonly Listed[] {
  let names: string[]
  try {
    names = readdirSync(savesDir(instance))
  } catch {
    return []
  }
  const out: Listed[] = []
  for (const name of names.filter((n) => !n.startsWith(".")).sort()) {
    try {
      out.push({
        name,
        manifest: parseManifest(
          readFileSync(
            resolve(saveDir(instance, name), FILES.manifest),
            "utf8",
          ),
        ),
      })
    } catch (error) {
      out.push({
        name,
        manifest: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return out.sort((a, b) =>
    (a.manifest?.createdAt ?? "").localeCompare(b.manifest?.createdAt ?? ""),
  )
}

export const hasSave = (instance: string, name: string): boolean =>
  readSave(instance, name) !== null

export function removeSave(instance: string, name: string): void {
  rmSync(saveDir(instance, name), { recursive: true, force: true })
  forgetNote(instance, name)
}

export function removeAllSaves(instance: string): void {
  rmSync(savesDir(instance), { recursive: true, force: true })
  try {
    removeNotes(instance)
  } catch {}
}

function forgetNote(instance: string, name: string): void {
  try {
    removeNote(instance, name)
  } catch {}
}

function readNoteSafe(instance: string, name: string): Note | null {
  try {
    return readNote(instance, name)
  } catch {
    return null
  }
}

const pendingMarker = (instance: string): string =>
  resolve(instanceDir(instance), "baseline.pending")
export const markPristine = (instance: string): void => {
  writeFileSync(pendingMarker(instance), `${new Date().toISOString()}\n`)
}
export const isPristine = (instance: string): boolean =>
  existsSync(pendingMarker(instance))
export const clearPristine = (instance: string): void => {
  rmSync(pendingMarker(instance), { force: true })
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

export function cloneFile(src: string, dst: string): void {
  rmSync(dst, { force: true })
  if (spawnSync("cp", ["-c", src, dst], { stdio: "ignore" }).status === 0)
    return
  if (spawnSync("cp", [src, dst], { stdio: "inherit" }).status !== 0)
    throw new Error(`could not copy ${src} -> ${dst}`)
}

export const thumbSize = (native: Size, box: Size = THUMB_BOX): Size =>
  scaled(native, fitScale(native, box))

const SCREEN_PPM = ".screen.ppm"

export async function captureScreen(
  qmpPath: string,
  dir: string,
  timeoutMs = 5000,
): Promise<string | null> {
  const file = resolve(dir, SCREEN_PPM)
  try {
    await qmp.execute(qmpPath, "screendump", { filename: file }, timeoutMs)
    return existsSync(file) ? file : null
  } catch {
    rmSync(file, { force: true })
    return null
  }
}

export function writeScreenshots(ppmPath: string, dir: string): Size | null {
  const screen = resolve(dir, FILES.screen)
  const thumb = resolve(dir, FILES.thumb)
  try {
    const img = parsePpm(readFileSync(ppmPath))
    const t = thumbSize(img)
    writeFileSync(screen, encodePng(img))
    writeFileSync(thumb, encodePng(resize(img, t.width, t.height)))
    return { width: img.width, height: img.height }
  } catch {
    rmSync(screen, { force: true })
    rmSync(thumb, { force: true })
    return null
  } finally {
    rmSync(ppmPath, { force: true })
  }
}

const allocated = (f: string): number => {
  try {
    const st = statSync(f)
    return st.blocks * 512
  } catch {
    return 0
  }
}

export function isEphemeral(p: Paths): boolean {
  const pid = qemu.pidOf(p)
  if (pid === null) return false
  return / -snapshot( |$)/.test(
    capture("ps", ["-o", "command=", "-p", String(pid)]),
  )
}

async function waitMigration(
  p: Paths,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = (await qmp.execute(p.qmp, "query-migrate")) as Record<
      string,
      unknown
    >
    const s = r.status
    if (s === "completed") return r
    if (s === "failed" || s === "cancelled") {
      const detail = r["error-desc"]
      throw new Error(
        `migration ${s}: ${typeof detail === "string" ? detail : "no detail"}`,
      )
    }
    await sleep(250)
  }
  throw new Error("the save did not finish in time")
}

export async function quitQemu(
  p: Paths,
  timeoutMs = 120_000,
  o: { readonly leaveMounts?: true } = {},
): Promise<void> {
  const pid = qemu.pidOf(p)
  if (pid === null) return
  if (o.leaveMounts !== true) finder.beforeDown(instanceOf(p))
  try {
    await qmp.execute(p.qmp, "quit", undefined, 20_000)
  } catch {}
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (qemu.pidOf(p) === null) {
      qemu.stopSidecars(p)
      return
    }
    await sleep(20)
  }
  await qemu.killQemu(p, pid)
  const killedBy = Date.now() + 10_000
  while (qemu.pidOf(p) === pid) {
    if (Date.now() > killedBy)
      throw new Error(
        `QEMU (pid ${String(pid)}) did not quit and could not be killed; it still holds ${p.pid}`,
      )
    await sleep(250)
  }
  qemu.stopSidecars(p)
}

function clearAbandonedPartials(instance: string): void {
  const dir = savesDir(instance)
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const pid = Number(/^\..+\.partial-(\d+)$/.exec(entry)?.[1])
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        rmSync(resolve(dir, entry), { recursive: true, force: true })
    }
  }
}

export interface CreateOptions {
  readonly name: string
  readonly kind: SaveKind
  readonly note?: string
  readonly format?: RamFormat
  readonly compress?: boolean
  readonly quitAfter?: boolean
  readonly leaveMounts?: true
}

export interface CreateResult {
  readonly manifest: Manifest
  readonly rawRamBytes: number
  readonly resumed: boolean
}

export const createSave = async (
  instance: string,
  o: CreateOptions,
): Promise<CreateResult> =>
  await withOperation(
    instance,
    o.kind === "stow" ? "stow" : "save",
    async () => await createSaveHeld(instance, o),
  )

async function createSaveHeld(
  instance: string,
  o: CreateOptions,
): Promise<CreateResult> {
  const p = pathsFor(instance)
  const meta = readMeta(instance)
  if (meta === null) throw new Error(`no such instance "${instance}"`)
  if (!qemu.isRunning(p))
    throw new Error(
      `instance "${instance}" is not running — a save captures a live guest`,
    )
  if (isEphemeral(p))
    throw new Error(
      `instance "${instance}" is --ephemeral; its disk changes are not durable, so it cannot be saved`,
    )
  const nameErr = nameError(o.name)
  if (nameErr !== null) throw new Error(nameErr)
  const pid = qemu.pidOf(p)
  const hardware =
    (pid === null ? null : runningHardware(pid)) ?? readHardware(p)
  const command = pid === null ? null : runningCommand(pid)
  const display = command === null ? null : displayFromCommandLine(command)
  if (command === null || display === null) {
    const size = command === null ? null : rejectedLegacySize(command)
    throw new Error(
      size === null
        ? `cannot tell which display "${instance}" is running (its QEMU command line shows no single ramfb or virtio-gpu device), ` +
            "so a save could not be restored on the same hardware; nothing was saved"
        : `"${instance}" is running a virtio-gpu profile (${size}) that a save cannot record: a size must be ${LEGACY_SIZE_BOUNDS}. ` +
            "Nothing was saved. Stop it, run `winvm display virtio-gpu` (or `winvm display ramfb`) to reset the display, and start it again",
    )
  }
  const replayShares =
    qemu.launchDevices(p, { installMedia: false, display }).devices !== "none"
  if (sharesFolderFromCommandLine(command) !== replayShares) {
    throw new Error(
      `"${instance}" is running a temporary setup configuration (its shared folder devices differ from what restoring a ${display.device} guest launches, as during \`winvm share install\`), ` +
        "so a save could not be restored; nothing was saved. Save after it finishes",
    )
  }
  const compat = currentCompat(
    instance,
    meta,
    display,
    hardware,
    pid === null ? UNKNOWN_RUNTIME : await producedBy(p, pid, command),
  )

  clearAbandonedPartials(instance)
  const tmp = resolve(
    savesDir(instance),
    `.${o.name}.partial-${String(process.pid)}`,
  )
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const format: RamFormat = o.format ?? (o.compress === false ? "raw" : "zstd")
  const ramFile = ramFileFor(format)
  const ramPath = resolve(tmp, ramFile)
  const plan = migrationPlan(format, ramPath, runtimeBin("zstd"))

  const before = await qmp.status(p.qmp)
  const wasRunning = before === "running"
  const started = Date.now()
  let migrated: Record<string, unknown>
  let ppm: string | null = null
  if (wasRunning) markSavingRunning(instance)
  try {
    if (wasRunning) await qmp.execute(p.qmp, "stop")
    ppm = await captureScreen(p.qmp, tmp)
    await qmp.execute(p.qmp, "migrate-set-capabilities", {
      capabilities: plan.capabilities,
    })
    await qmp.execute(p.qmp, "migrate-set-parameters", plan.parameters)
    await qmp.execute(p.qmp, "migrate", { uri: plan.uri })
    migrated = await waitMigration(p, 30 * 60_000)
    cloneFile(p.overlay, resolve(tmp, FILES.overlay))
    cloneFile(p.vars, resolve(tmp, FILES.vars))
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    if (wasRunning) await qmp.execute(p.qmp, "cont").catch(() => undefined)
    clearSavingRunning(instance)
    throw error
  }
  if (o.quitAfter !== true) {
    try {
      if (wasRunning) await qmp.execute(p.qmp, "cont")
    } finally {
      clearSavingRunning(instance)
    }
  }
  const saveMs = Date.now() - started
  const screen = ppm === null ? null : writeScreenshots(ppm, tmp)

  const ramBytes = allocated(ramPath)
  const bytes =
    ramBytes +
    allocated(resolve(tmp, FILES.overlay)) +
    allocated(resolve(tmp, FILES.vars))
  const manifest: Manifest = {
    name: o.name,
    instance,
    kind: o.kind,
    createdAt: new Date(started).toISOString(),
    bytes,
    compat: compat.hash,
    image: meta.image,
    ...(o.note === undefined ? {} : { note: o.note }),
    compatParts: compat.parts,
    ramFile,
    ramBytes,
    saveMs,
    format,
    hardware,
    display,
    ...(screen === null
      ? {}
      : {
          screenshot: FILES.screen,
          thumbnail: FILES.thumb,
          screenSize: screen,
        }),
  }
  writeFileSync(
    resolve(tmp, FILES.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )

  const final = saveDir(instance, o.name)
  const old = resolve(
    savesDir(instance),
    `.${o.name}.old-${String(process.pid)}`,
  )
  const replaced = existsSync(final)
  if (replaced) renameSync(final, old)
  renameSync(tmp, final)
  if (o.quitAfter === true) {
    try {
      await quitQemu(p, undefined, o.leaveMounts === true ? o : {})
    } finally {
      clearSavingRunning(instance)
    }
  }
  rmSync(old, { recursive: true, force: true })
  if (replaced) forgetNote(instance, o.name)

  const ram = migrated.ram as
    | { transferred?: number; total?: number }
    | undefined
  return {
    manifest,
    rawRamBytes: ram?.transferred ?? 0,
    resumed: wasRunning && o.quitAfter !== true,
  }
}

export class IncompatibleSave extends Error {}

export async function cloneSave(
  from: string,
  to: string,
  name: string,
): Promise<Manifest> {
  const m = readSave(from, name)
  if (m === null) throw new Error(`instance "${from}" has no save "${name}"`)
  if (readMeta(to) === null)
    ensureInstance(to, m.image, readDisplay(pathsFor(from)))
  const meta = readMeta(to)
  if (meta === null) throw new Error(`could not create instance "${to}"`)
  if (meta.image !== m.image) {
    throw new IncompatibleSave(
      `save "${name}" is of image "${m.image}", but instance "${to}" runs "${meta.image}"`,
    )
  }
  const now = compatFor(to, meta, m)
  if (now.hash !== m.compat) {
    const why =
      m.compatParts === undefined ? [] : compatDiff(m.compatParts, now.parts)
    throw new IncompatibleSave(
      `"${to}" differs from "${from}"${why.length > 0 ? `: ${why.join("; ")}` : ""}`,
    )
  }
  const src = saveDir(from, name)
  return await withOperation(to, "save", () => {
    const tmp = resolve(savesDir(to), `.${name}.partial-${String(process.pid)}`)
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    try {
      for (const f of readdirSync(src)) {
        if (f.startsWith(".") || f === FILES.manifest) continue
        cloneFile(resolve(src, f), resolve(tmp, f))
      }
      const copy = {
        ...m,
        instance: to,
        clonedFrom: { instance: from, createdAt: m.createdAt },
      }
      writeFileSync(
        resolve(tmp, FILES.manifest),
        `${JSON.stringify(copy, null, 2)}\n`,
      )
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true })
      throw error
    }
    const final = saveDir(to, name)
    const old = resolve(savesDir(to), `.${name}.old-${String(process.pid)}`)
    if (existsSync(final)) renameSync(final, old)
    renameSync(tmp, final)
    rmSync(old, { recursive: true, force: true })
    try {
      copyNote(from, to, name)
    } catch {}
    return parseManifest(readFileSync(resolve(final, FILES.manifest), "utf8"))
  })
}

export const loadSave = async (
  instance: string,
  name: string,
): Promise<Manifest> =>
  await withOperation(
    instance,
    "load",
    async () => await loadSaveHeld(instance, name),
  )

async function loadSaveHeld(instance: string, name: string): Promise<Manifest> {
  const m = readSave(instance, name)
  if (m === null)
    throw new Error(
      `instance "${instance}" has no save "${name}" — \`winvm saves -i ${instance}\``,
    )
  const created = readMeta(instance) === null
  if (created) ensureInstance(instance, m.image)
  const meta = readMeta(instance)
  if (meta === null) throw new Error(`no such instance "${instance}"`)
  if (meta.image !== m.image) {
    throw new IncompatibleSave(
      `save "${name}" is of image "${m.image}", but instance "${instance}" runs "${meta.image}"`,
    )
  }
  const now = compatFor(instance, meta, m)
  if (m.compat !== now.hash) {
    const devices = takenBeforeDevices(m, hardwareBeforeDevices(instance, meta))
    const diff =
      m.compatParts === undefined ? [] : compatDiff(m.compatParts, now.parts)
    const why = diff.map((w) =>
      devices && w === "the virtual hardware (QEMU arguments) changed"
        ? "it was taken before winvm added the shared folder and clipboard devices"
        : w,
    )
    const manual =
      m.display === undefined &&
      !devices &&
      (m.compatParts === undefined ||
        diff.some((w) => w.startsWith("the virtual hardware")))
        ? `; it has no recorded display, so it loads only while the instance's display is the one it was taken on — \`winvm display ramfb|virtio-gpu\` (stopped) sets it`
        : ""
    throw new IncompatibleSave(
      `save "${name}" was taken on different virtual hardware and cannot be loaded here` +
        (why.length > 0 ? `: ${why.join("; ")}` : "") +
        ` (save ${m.compat}, now ${now.hash})` +
        manual,
    )
  }
  const dir = saveDir(instance, name)
  const format = ramFormatOf(m)
  const ramFile = m.ramFile ?? ramFileFor(format)
  const ramPath = resolve(dir, ramFile)
  const plan = migrationPlan(format, ramPath, runtimeBin("zstd"))
  for (const f of [
    ramPath,
    resolve(dir, FILES.overlay),
    resolve(dir, FILES.vars),
  ]) {
    if (!existsSync(f))
      throw new Error(`save "${name}" is incomplete: ${f} is missing`)
  }

  const p = pathsFor(instance)
  await quitQemu(p)
  for (const [src, dst] of [
    [resolve(dir, FILES.overlay), p.overlay],
    [resolve(dir, FILES.vars), p.vars],
  ] as const) {
    cloneFile(src, `${dst}.loading`)
  }
  renameSync(`${p.overlay}.loading`, p.overlay)
  renameSync(`${p.vars}.loading`, p.vars)

  await qemu.launch(instance, p, meta, {
    installMedia: false,
    ephemeral: false,
    virtioBoot: readImageMeta(meta.image)?.virtioBoot === true,
    incoming: plan.incoming,
    hardware: saveHardware(m),
    display: now.display,
  })
  if (plan.incoming === "defer") {
    await qmp.execute(p.qmp, "migrate-set-capabilities", {
      capabilities: plan.capabilities,
    })
    await qmp.execute(p.qmp, "migrate-set-parameters", plan.parameters)
    await qmp.execute(p.qmp, "migrate-incoming", { uri: plan.uri })
  }
  const deadline = Date.now() + 30 * 60_000
  for (;;) {
    if (!qemu.isRunning(p)) {
      let why = ""
      try {
        why = readFileSync(p.qemuLog, "utf8").trim()
      } catch {}
      throw new Error(
        `QEMU exited while loading save "${name}"${why === "" ? "" : `:\n  ${why.split("\n").join("\n  ")}`}`,
      )
    }
    let s = "unknown"
    try {
      s = await qmp.status(p.qmp)
    } catch {}
    if (s === "running") break
    if (s === "paused" || s === "postmigrate" || s === "prelaunch") {
      await qmp.execute(p.qmp, "cont")
      break
    }
    if (Date.now() > deadline)
      throw new Error(
        `loading save "${name}" did not finish in time (state: ${s})`,
      )
    await sleep(50)
  }
  return m
}
