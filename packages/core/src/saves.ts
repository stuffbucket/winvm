/**
 * File saves: the whole running machine written to files, like a game save —
 * kept outside the instance's disks, surviving stop/start, loadable later
 * whether the guest is running or not.
 *
 * ## How this differs from `snapshot`
 *
 * A snapshot (`savevm`, snapshot.ts) lives INSIDE the instance's qcow2 files:
 * fast, but invisible from outside, not portable, and gone with a `reset`. A
 * save is a directory of plain files:
 *
 *   $WINVM_HOME/saves/<instance>/<name>/
 *     manifest.json     the contract below; other tools read it
 *     vmstate.zst       RAM + device state: a QEMU migration stream, zstd'd
 *                       (or vmstate.mapped / vmstate.bin — see "RAM formats")
 *     overlay.qcow2     the instance's writable disk at that moment (APFS clone)
 *     efi-vars.qcow2    its firmware variables at that moment (APFS clone)
 *     screen.png        the screen at that instant, full size (when there is one)
 *     thumb.png         the same, fitted inside 480x300 for lists
 *
 * The disk copies are `cp -c` CLONES (clonefile), so they cost nothing until the
 * instance writes over the blocks they share. TPM state needs no file: QEMU's
 * tpm-emulator backend carries swtpm's state inside the migration stream and
 * pushes it back into swtpm on load.
 *
 * A person's notes on a save (title, text, tags) are NOT in this directory but
 * in the XDG data dir — see notes.ts — and follow the save's lifecycle here.
 *
 * ## Screenshots
 *
 * Every save keeps a picture of the screen, so a list of saves can show what
 * each one was. It is grabbed as one raw PPM screendump (~60 ms) while the
 * guest is stopped, so it shows exactly the saved instant, and encoded to PNG
 * only after the guest is running again (or QEMU has quit), so the guest is
 * not held stopped for it. A screenshot is a nicety: any failure — a headless
 * guest has no framebuffer — skips the files and never fails the save. The
 * PNGs are not counted in the manifest's `bytes`, which stays the cost of the
 * machine state (RAM and disks), the figure retention and `saves` reason about.
 *
 * ## Consistency
 *
 * The guest is STOPPED (QMP `stop`) before anything is written, and stays
 * stopped until the disks are cloned. `stop` drains and flushes every block
 * device, qcow2 metadata caches included, and the migration's completion
 * inactivates them — so RAM, disk and NVRAM all describe the same instant.
 * Then `cont`, and the guest's clock is resynced (it stood still meanwhile).
 *
 * ## Loading
 *
 * A migration stream can only be fed to a QEMU started with `-incoming`, so a
 * load always (re)starts QEMU: quit the running one (its state is being
 * discarded anyway), clone the save's disks back into the instance, launch
 * with `-incoming "exec:zstd -dc …"`, `cont`, wait for the agent, fix the clock.
 *
 * ## RAM formats
 *
 * The manifest's `format` says how the RAM was written, and `load` sets up the
 * incoming side to match:
 *
 *   zstd    (default) one stream through `zstd -3`: ~5x smaller, but a load is
 *           bound by single-stream decompression — 3.3-4.6 s measured. Right for
 *           autosaves, stows and anything kept a while.
 *   mapped  QEMU's `mapped-ram` + `multifd` to a `file:` URI: every RAM page has
 *           a fixed offset in a sparse file, written and read by several
 *           threads at once, so a load is ~1-1.5 s. Uncompressed (zero pages
 *           are holes, so it allocates about what the guest has touched). Right
 *           for goldens and test resets, loaded over and over.
 *   raw     one uncompressed stream (`file:`). Kept so older saves still load.
 *
 * Migration capabilities stick to a QEMU process, and a QEMU loaded from a
 * mapped save has them on — so every save sets all of them explicitly, or a
 * zstd save after a mapped load would fail (`exec:` cannot carry mapped-ram).
 *
 * ## Why not `savevm` into a file
 *
 * QEMU 11.1 has no "savevm to a path"; the only file-shaped outputs are a
 * migration (`exec:`/`file:` URIs) or an external snapshot chain. Migration
 * needs exactly the device properties savevm already needed — virtio-blk (not
 * NVMe, which is non-migratable), qcow2 NVRAM — so every image that can
 * `snapshot` can `save`. The writable result volume is not attached to a
 * running instance at all any more (qemu.ts), so it does not come into it.
 *
 * ## Compatibility
 *
 * A migration stream loads only into the same virtual hardware, on disks
 * descended from the same base. `compat` hashes exactly that: the base image's
 * identity (name, size, mtime and recorded build time — not 14 GB of content),
 * the QEMU device/machine arguments with per-instance paths and ports removed,
 * the firmware code image, and the QEMU version. `load` refuses a mismatch and
 * names which part differs.
 *
 * Processors and memory are among those arguments, and the machine's setting
 * for them can change (hardware.ts). So a save records the size QEMU ran at
 * (`hardware`; absent: LEGACY), is judged against the instance measured at
 * that size (compatFor), and loads at that size.
 *
 * The display device is another of those arguments, and the instance's
 * preference for it (display.json) can change too. So a save likewise records
 * the display its QEMU was RUNNING (`display`, read off the process; a guest
 * whose display cannot be identified is not saved), is judged with it, and
 * loads with it. `load` never writes display.json: the next cold boot still
 * uses the preference. A legacy save has no record and is judged against the
 * preference, as it always was.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Size } from "./cua"
import { encodePng, fitScale, parsePpm, resize, scaled } from "./cua"
import type { DisplayConfig } from "./display"
import {
  LEGACY_SIZE_BOUNDS,
  RAMFB,
  VIRTIO_GPU,
  displayArgs,
  displayFromCommandLine,
  parseDisplayConfig,
  readDisplay,
  rejectedLegacySize,
  runningCommand,
  sameDevice,
  sharesFolderFromCommandLine,
} from "./display"
import type { Hardware } from "./hardware"
import { LEGACY, hardwareFrom, readHardware, runningHardware } from "./hardware"
import { capture, requireFirmware } from "./host"
import { currentQemuCompat, runtimeBin } from "./runtime"
import { ensureInstance } from "./instance"
import type { Note } from "./notes"
import { copyNote, readNote, removeNote, removeNotes } from "./notes"
import type { InstanceMeta, Paths } from "./paths"
import { basePath, home, imageMetaPath, instanceDir, pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as qmp from "./qmp"
import * as finder from "./finder"
import { clearSavingRunning, markSavingRunning } from "./frozen"
import { instanceOf } from "./smbstate"

// ---------------------------------------------------------------------------
// The on-disk contract

export const SAVE_KINDS = ["manual", "auto", "baseline", "stow", "golden"] as const
export type SaveKind = (typeof SAVE_KINDS)[number]

/** Taken automatically the first time a fresh instance is ready; `rewind` goes here. */
export const BASELINE = "baseline"
/** Written by `winvm stow`, consumed by the next `winvm start`. */
export const STOW = "stow"
/** The default name of a golden save (`winvm golden create`, golden.ts). */
export const GOLDEN = "golden"

export const RAM_FORMATS = ["zstd", "mapped", "raw"] as const
export type RamFormat = (typeof RAM_FORMATS)[number]

/**
 * Threads per side for a mapped save. Measured 4-8 as the sweet spot on an
 * M-series host with a 4 GiB guest; beyond that the file system is the limit.
 */
export const MULTIFD_CHANNELS = 8

export interface CompatParts {
  /** Digest of the base image's identity (name, size, mtime, recorded build time). */
  readonly base: string
  /** Digest of the normalised QEMU hardware arguments. */
  readonly hardware: string
  /** Digest of the UEFI code image. */
  readonly firmware: string
  /** The runtime's QEMU version and patch set, e.g. "11.1.2+patches:none". */
  readonly qemu: string
}

export interface Manifest {
  readonly name: string
  readonly instance: string
  readonly kind: SaveKind
  /** Explicitly kept by the user: never reclaim or replace it. Absent in older saves: false. */
  readonly protected?: boolean
  /** ISO 8601. */
  readonly createdAt: string
  /** Total bytes allocated by the save's files. Clones share blocks, so this overstates new space used. */
  readonly bytes: number
  /** See "Compatibility" above. A save loads only where this matches. */
  readonly compat: string
  /** Base image name. */
  readonly image: string
  readonly note?: string
  /** The parts `compat` hashes, so a refusal can say which one differs. */
  readonly compatParts?: CompatParts
  /** RAM/device stream file name within the save directory. */
  readonly ramFile?: string
  /** Bytes of that stream on disk. */
  readonly ramBytes?: number
  /** Wall time the guest was stopped to take the save. */
  readonly saveMs?: number
  /** How the RAM was written (see "RAM formats"). Absent in older saves: inferred from `ramFile`. */
  readonly format?: RamFormat
  /** Set on a copy made by `cloneSave`: the save it was cloned from. */
  readonly clonedFrom?: { readonly instance: string; readonly createdAt: string }
  /** The screen at the saved instant, full size (FILES.screen); absent when none could be taken. */
  readonly screenshot?: string
  /** The same, fitted inside THUMB_BOX (FILES.thumb). */
  readonly thumbnail?: string
  /** The framebuffer's size when the screenshot was taken. */
  readonly screenSize?: { readonly width: number; readonly height: number }
  /**
   * The processors and memory QEMU ran with (hardware.ts). `load` and the stow
   * recall start QEMU at this size, so changing the machine's setting never
   * strands a save. Absent in saves from before the setting: LEGACY.
   */
  readonly hardware?: Hardware
  /**
   * The display QEMU was launched with when the save was taken (display.ts
   * runningDisplay), which `compat` hashes. `load`, `clone` and the stow
   * recall check and launch with THIS, never with display.json (the cold-boot
   * preference, which may have changed since). Absent in saves from before the
   * record: those are judged against the preference, strictly.
   */
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

/** The box a save's thumbnail is fitted inside: small enough for a list, sharp enough for a card. */
export const THUMB_BOX: Size = { width: 480, height: 300 }

export const savesRoot = (): string => resolve(home(), "saves")
export const savesDir = (instance: string): string => resolve(savesRoot(), instance)
export const saveDir = (instance: string, name: string): string => resolve(savesDir(instance), name)

// ---------------------------------------------------------------------------
// Pure logic (unit-tested)

/**
 * A save name is a directory name, shown in tables and typed on command lines:
 * letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 64.
 * Leading dots are reserved for in-progress and lock entries.
 * Returns why a name is unacceptable, or null.
 */
export function nameError(name: string): string | null {
  if (name.length === 0) return "a save name cannot be empty"
  if (name.length > 64) return "a save name is at most 64 characters"
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return `"${name}" is not a valid save name — use letters, digits, ".", "_" and "-", starting with a letter or digit`
  }
  return null
}

/** Default save name: the local time, sortable and shell-safe — `2026-10-21_16-43-05`. */
export function defaultName(d: Date): string {
  const z = (n: number): string => String(n).padStart(2, "0")
  return (
    `${String(d.getFullYear())}-${z(d.getMonth() + 1)}-${z(d.getDate())}_` +
    `${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`
  )
}

/** Parse and validate a manifest. Throws with the first thing wrong. */
export function parseManifest(text: string): Manifest {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch (error) {
    throw new Error(`manifest is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("manifest is not an object")
  const r = o as Record<string, unknown>
  const str = (k: string): string => {
    const v = r[k]
    if (typeof v !== "string" || v === "") throw new Error(`manifest.${k} must be a non-empty string`)
    return v
  }
  const name = str("name")
  const err = nameError(name)
  if (err !== null) throw new Error(`manifest.name: ${err}`)
  const kind = str("kind")
  if (!(SAVE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`manifest.kind must be one of ${SAVE_KINDS.join(", ")}, got "${kind}"`)
  }
  const createdAt = str("createdAt")
  if (Number.isNaN(Date.parse(createdAt))) throw new Error(`manifest.createdAt is not a date: "${createdAt}"`)
  const bytes = r["bytes"]
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    throw new Error("manifest.bytes must be a non-negative number")
  }
  const protection = r["protected"]
  if (protection !== undefined && typeof protection !== "boolean") throw new Error("manifest.protected must be a boolean")
  const note = r["note"]
  if (note !== undefined && typeof note !== "string") throw new Error("manifest.note must be a string")
  const format = r["format"]
  if (format !== undefined && !(RAM_FORMATS as readonly unknown[]).includes(format)) {
    throw new Error(`manifest.format must be one of ${RAM_FORMATS.join(", ")}, got ${JSON.stringify(format)}`)
  }
  const hw = r["hardware"]
  if (hw !== undefined) {
    const h = hw as Record<string, unknown> | null
    const whole = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v > 0
    if (typeof hw !== "object" || h === null || !whole(h["cpus"]) || !whole(h["memoryMiB"])) {
      throw new Error("manifest.hardware must be { cpus, memoryMiB }, positive whole numbers")
    }
  }
  // Replayed onto QEMU's command line, so a profile is exact or refused: never a guess.
  let display: DisplayConfig | undefined
  if (Object.hasOwn(r, "display")) {
    const parsed = parseDisplayConfig(r["display"])
    if (parsed === null) throw new Error("manifest.display must be ramfb or virtio-gpu (optionally with a legacySize of whole numbers)")
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
  } as Manifest
}

/** The size a save was taken at: its record, or LEGACY for a save from before the record. */
export const saveHardware = (m: Pick<Manifest, "hardware">): Hardware => (m.hardware === undefined ? LEGACY : hardwareFrom(m.hardware))

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex")

/** Flags whose values are host-side plumbing, not virtual hardware. */
const PLUMBING = new Set(["-name", "-vnc", "-qmp", "-serial", "-pidfile", "-display", "-loadvm", "-incoming", "-rtc"])

/**
 * The QEMU arguments that define the virtual machine, with everything
 * per-instance or host-side removed: file and socket paths, the VNC port,
 * pidfile, monitor, `-snapshot`, and `-rtc` (its base only seeds a clock that
 * is resynced after every load anyway). What is left must match exactly for a
 * migration stream to load.
 */
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
    out.push(a.split(",").map((kv) => kv.replace(/^(file|path)=.*$/, "$1=*")).join(","))
  }
  return out
}

/** Identity of a base image without reading 14 GB of it. */
export function baseIdentity(image: string, size: number, mtimeMs: number, created: string): string {
  return sha(JSON.stringify([image, size, Math.round(mtimeMs), created])).slice(0, 16)
}

export function compatHash(parts: CompatParts): string {
  return sha(JSON.stringify(["winvm-save-v1", parts.base, parts.hardware, parts.firmware, parts.qemu])).slice(0, 16)
}

/** Human names of the parts that differ, for a refusal message. */
export function compatDiff(saved: CompatParts, now: CompatParts): readonly string[] {
  const out: string[] = []
  if (saved.base !== now.base) out.push("the base image was rebuilt or replaced")
  if (saved.hardware !== now.hardware) out.push("the virtual hardware (QEMU arguments) changed")
  if (saved.firmware !== now.firmware) out.push("the UEFI firmware changed")
  if (saved.qemu !== now.qemu) out.push(`QEMU changed (${saved.qemu} -> ${now.qemu})`)
  return out
}

export type CompatPart = keyof CompatParts

/** Which parts differ, as keys: what `saves --json` reports for an incompatible save. */
export function compatDiffKeys(saved: CompatParts, now: CompatParts): CompatPart[] {
  return (["base", "hardware", "firmware", "qemu"] as const).filter((k) => saved[k] !== now[k])
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

/** Single-quote for `/bin/sh` — the migration `exec:` URI goes through a shell. */
export const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

/** A save's RAM format: the manifest's word, else what its file name implies (saves before `format`). */
export function ramFormatOf(m: Pick<Manifest, "format" | "ramFile">): RamFormat {
  if (m.format !== undefined) return m.format
  if (m.ramFile === FILES.ramRaw) return "raw"
  if (m.ramFile === FILES.ramMapped) return "mapped"
  return "zstd"
}

export const ramFileFor = (f: RamFormat): string =>
  f === "mapped" ? FILES.ramMapped : f === "raw" ? FILES.ramRaw : FILES.ram

export interface MigrationPlan {
  /** For `migrate-set-capabilities`, on both sides. Always complete — see "RAM formats". */
  readonly capabilities: readonly { readonly capability: string; readonly state: boolean }[]
  /** For `migrate-set-parameters`, on both sides. */
  readonly parameters: Readonly<Record<string, unknown>>
  /** The URI the saving side migrates to. */
  readonly uri: string
  /**
   * QEMU's `-incoming` for the loading side. "defer" means capabilities must be
   * set first and the stream started with `migrate-incoming` on `uri`.
   */
  readonly incoming: string
}

/** How to write, and read back, RAM in a format. Pure, so it is tested without a VM. */
export function migrationPlan(format: RamFormat, ramPath: string, zstd: string, channels = MULTIFD_CHANNELS): MigrationPlan {
  const mapped = format === "mapped"
  const capabilities = [
    { capability: "mapped-ram", state: mapped },
    { capability: "multifd", state: mapped },
  ]
  // The default precopy bandwidth cap (128 MiB/s) would make a 4 GiB guest take
  // half a minute for no reason; the guest is stopped, so there is no dirtying
  // to race.
  const parameters: Record<string, unknown> = { "max-bandwidth": 64 * 1024 ** 3 }
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
      return { capabilities, parameters, uri: `file:${ramPath}`, incoming: `file:${ramPath}` }
    case "mapped":
      return { capabilities, parameters, uri: `file:${ramPath}`, incoming: "defer" }
  }
}

// ---------------------------------------------------------------------------
// Compatibility, measured on this host

let firmwareDigest: string | null = null
let qemuVersion: string | null = null

/**
 * `display` measures the instance as if it had that display device instead of
 * its own, without touching display.json: `saves` uses it to tell a save that
 * differs only by its display device from one that differs by more.
 * `hardware` likewise measures it at a size other than its setting: a save is
 * judged, and loaded, at the size it was taken at (compatFor).
 */
export function currentCompat(
  instance: string,
  meta: InstanceMeta,
  display?: DisplayConfig,
  hardware?: Hardware,
): { readonly hash: string; readonly parts: CompatParts } {
  const st = statSync(basePath(meta.image))
  let created = ""
  try {
    created = readFileSync(imageMetaPath(meta.image), "utf8")
  } catch {
    // Adopted images may have no metadata; size and mtime still identify them.
  }
  firmwareDigest ??= sha(readFileSync(requireFirmware().code)).slice(0, 16)
  qemuVersion ??= currentQemuCompat()
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
    qemu: qemuVersion,
  }
  return { hash: compatHash(parts), parts }
}

/**
 * The instance's compatibility as `m` is judged and loaded: measured at the
 * size `m` was taken at, and with the display it was taken with (`m.display`;
 * a legacy save has none and is judged against the preference, display.json).
 * The display is resolved HERE, once, and returned: the caller that launches
 * must launch with the very display whose hardware was checked.
 */
export function compatFor(
  instance: string,
  meta: InstanceMeta,
  m: Pick<Manifest, "hardware" | "display">,
): ReturnType<typeof currentCompat> & { readonly display: DisplayConfig } {
  const display = m.display ?? readDisplay(pathsFor(instance))
  return { ...currentCompat(instance, meta, display, saveHardware(m)), display }
}

/**
 * The hardware digest this instance had before winvm added the shared folder
 * and clipboard devices (share.ts), or null when it has none of them (ramfb,
 * or a runtime without them), so nothing was stranded. Measured at `hardware`
 * (default LEGACY: every save from before the devices was taken at that size).
 */
export function hardwareBeforeDevices(instance: string, meta: InstanceMeta, hardware: Hardware = LEGACY): string | null {
  const o = { installMedia: false, ephemeral: false, virtioBoot: readImageMeta(meta.image)?.virtioBoot === true, hardware }
  const p = pathsFor(instance)
  const now = qemu.qemuArgs(instance, p, meta, o)
  const before = qemu.qemuArgs(instance, p, meta, { ...o, shareDevices: "none" })
  if (now.join(" ") === before.join(" ")) return null
  return sha(JSON.stringify(hardwareArgs(before))).slice(0, 16)
}

/** True when a save was taken on this instance's hardware as it was before the shared folder devices. */
export const takenBeforeDevices = (m: Pick<Manifest, "compatParts">, before: string | null): boolean =>
  before !== null && m.compatParts?.hardware === before

/**
 * The saves of `instance` that stopped loading when the shared folder and
 * clipboard devices arrived: named by `start`, `saves`, `load` and the stow
 * recall, as `display` names those a device switch strands.
 */
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
  return listSaves(instance).flatMap((s) => (s.manifest !== null && takenBeforeDevices(s.manifest, before) ? [s.name] : []))
}

/** The sentence `start` and `saves` print about them, or null. */
export function strandedNote(instance: string, names: readonly string[]): string | null {
  if (names.length === 0) return null
  const flag = instance === "default" ? "" : ` -i ${instance}`
  return (
    `${String(names.length)} save${names.length === 1 ? "" : "s"} of "${instance}" (${names.join(", ")}) ` +
    `${names.length === 1 ? "was" : "were"} taken before winvm added the shared folder and clipboard devices and will not load. ` +
    `They are kept; \`winvm saves${flag} rm <name>\` deletes one.`
  )
}

// ---------------------------------------------------------------------------
// Listing

export interface Listed {
  readonly name: string
  readonly manifest: Manifest | null
  readonly error?: string
}

export function readSave(instance: string, name: string): Manifest | null {
  try {
    return parseManifest(readFileSync(resolve(saveDir(instance, name), FILES.manifest), "utf8"))
  } catch {
    return null
  }
}

/** Why a save will not load here: a part of `compat`, with a display-device change told apart from other hardware. */
export type IncompatibleReason = "base" | "hardware" | "display" | "firmware" | "qemu"

export interface SaveEntry {
  readonly name: string
  readonly kind: SaveKind
  readonly protected: boolean
  readonly createdAt: string
  readonly bytes: number
  /** How the RAM was written. */
  readonly format: RamFormat
  /** Whether it loads into this instance as it is now; null when that could not be worked out. */
  readonly compatible: boolean | null
  /** Only when `compatible` is false and the save recorded its parts: which ones differ. */
  readonly incompatible?: readonly IncompatibleReason[]
  /** The `--note` given to `winvm save`, kept in the manifest. */
  readonly note?: string
  /** Absolute path of the save's screen.png / thumb.png; null when it has none. */
  readonly screenshot: string | null
  readonly thumbnail: string | null
  readonly screenSize?: { readonly width: number; readonly height: number }
  /** The person's note (notes.ts): its title, and the whole note. */
  readonly title: string | null
  readonly notes: Note | null
  /** Why it does not load, when winvm knows: e.g. taken before the shared folder devices. */
  readonly why?: string
}

/** What `savesReport` needs to know about this host, passed in so the report stays pure. */
export interface ReportContext {
  /** The instance's compatibility now; null when it could not be worked out. */
  readonly compat: { readonly hash: string; readonly parts: CompatParts } | null
  /**
   * The hardware part as it would be with each OTHER display device: a save
   * whose hardware matches one of these differs only by its display.
   */
  readonly displayHardware?: readonly string[]
  /** The hardware part before the shared folder devices (hardwareBeforeDevices); null when nothing was stranded. */
  readonly beforeDevices?: string | null
  /** Absolute path of `file` in save `save`'s directory when it exists, else null. */
  readonly file?: (save: string, file: string) => string | null
  readonly note?: (save: string) => Note | null
  /**
   * `compat` and `displayHardware` measured at another size and display
   * (hardware.ts, display.ts): a save is judged at the size it was taken at and
   * with the display it was taken with, so the display is part of what is asked
   * (and of the memoisation key). `image` is the save's, for an instance that
   * no longer exists (a retained save), which a save with a display can still be
   * judged on. Absent: every save is judged against `compat` as it is.
   */
  readonly at?: (hw: Hardware, display?: DisplayConfig, image?: string) => Pick<ReportContext, "compat" | "displayHardware">
}

/** The context a save is judged in: the instance measured at the save's own size and display. */
const contextFor = (m: Manifest, ctx: ReportContext): ReportContext =>
  ctx.at === undefined ? ctx : { ...ctx, ...ctx.at(saveHardware(m), m.display, m.image) }

/** Why `m` will not load here; null when it will, or when it cannot say. */
function reasons(m: Manifest, ctx: ReportContext): IncompatibleReason[] | null {
  if (ctx.compat === null || m.compat === ctx.compat.hash || m.compatParts === undefined) return null
  const saved = m.compatParts
  const out = compatDiffKeys(saved, ctx.compat.parts).map((k): IncompatibleReason =>
    k === "hardware" && (ctx.displayHardware ?? []).includes(saved.hardware) ? "display" : k,
  )
  return out.length > 0 ? out : null
}

/** `winvm saves --json`: the readable saves, oldest first, whether each loads here, and what to show for it. */
export function savesReport(rows: readonly Listed[], ctx: ReportContext): SaveEntry[] {
  const file = ctx.file ?? ((): null => null)
  const note = ctx.note ?? ((): null => null)
  return rows.flatMap((r) => {
    const m = r.manifest
    if (m === null) return []
    const c = contextFor(m, ctx)
    const differ = reasons(m, c)
    const n = note(r.name)
    return [
      {
        name: m.name,
        kind: m.kind,
        protected: m.protected === true,
        createdAt: m.createdAt,
        bytes: m.bytes,
        format: ramFormatOf(m),
        compatible: c.compat === null ? null : m.compat === c.compat.hash,
        ...(differ === null ? {} : { incompatible: differ }),
        ...(m.note === undefined ? {} : { note: m.note }),
        ...(c.compat !== null && m.compat !== c.compat.hash && takenBeforeDevices(m, ctx.beforeDevices ?? null)
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

/** Absolute path of a file in a save's directory, or null when it is not there. */
export function saveFile(instance: string, save: string, file: string): string | null {
  const path = resolve(saveDir(instance, save), file)
  return existsSync(path) ? path : null
}

/**
 * Everything `savesReport` needs for this instance as it is now. Never throws:
 * what cannot be worked out (no firmware, no base image) is reported unknown.
 */
export function reportContext(instance: string): ReportContext {
  const meta = readMeta(instance)
  const measured = new Map<string, Pick<ReportContext, "compat" | "displayHardware">>()
  /**
   * The instance's compatibility, and with each other display device, at `hw`
   * and `shown` (a save's own; the preference when absent); memoised per pair.
   * A retained save's instance is gone, so a save that recorded its display is
   * measured on a stand-in for the instance load would recreate; one that did
   * not has nothing to measure against, and stays unknown.
   */
  const at = (hw?: Hardware, shown?: DisplayConfig, image?: string): Pick<ReportContext, "compat" | "displayHardware"> => {
    const standIn: InstanceMeta | null = meta ?? (shown !== undefined && image !== undefined ? { image, vnc: 0, created: "" } : null)
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
    } catch {
      // Unknown is reported as unknown; `compat` keeps whatever was worked out.
    }
    const out = { compat, displayHardware }
    measured.set(key, out)
    return out
  }
  let beforeDevices: string | null = null
  try {
    if (meta !== null) beforeDevices = hardwareBeforeDevices(instance, meta)
  } catch {
    // unknown
  }
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
      out.push({ name, manifest: parseManifest(readFileSync(resolve(saveDir(instance, name), FILES.manifest), "utf8")) })
    } catch (error) {
      out.push({ name, manifest: null, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return out.sort((a, b) => (a.manifest?.createdAt ?? "").localeCompare(b.manifest?.createdAt ?? ""))
}

export const hasSave = (instance: string, name: string): boolean => readSave(instance, name) !== null

/** A protected save needs an explicit destructive override, never an automatic caller's permission. */
export class ProtectedSave extends Error {}

/**
 * Check before replacing/deleting any files. Unreadable manifests fail closed:
 * protection cannot be inferred safely; an explicit `saves rm --force` can
 * still remove a damaged save. The caller holds the instance's save lock.
 */
export function assertRemovable(instance: string, name: string, force = false): void {
  const err = nameError(name)
  if (err !== null) throw new Error(err)
  if (force || !existsSync(saveDir(instance, name))) return
  const m = parseManifest(readFileSync(resolve(saveDir(instance, name), FILES.manifest), "utf8"))
  if (m.protected === true) {
    throw new ProtectedSave(`save "${name}" is protected — unprotect it first, or explicitly delete it with \`winvm saves -i ${instance} rm ${name} --force\``)
  }
}

/**
 * Why an instance's saves can't all be swept away (a protected save, or one
 * whose manifest can't be read, so its protection is unknown), or null.
 */
export function removalBlocker(instance: string): string | null {
  for (const s of listSaves(instance)) {
    try {
      assertRemovable(instance, s.name)
    } catch (error) {
      return error instanceof ProtectedSave ? error.message : `save "${s.name}" has an unreadable manifest`
    }
  }
  return null
}

/**
 * Change only retention metadata, under the same lock as creation and rotation.
 * Works with a stopped or running machine: no QEMU or guest call is needed.
 * A stow is a one-shot resume slot, not a checkpoint to retain.
 */
export function setSaveProtection(instance: string, name: string, protect: boolean): Manifest {
  const err = nameError(name)
  if (err !== null) throw new Error(err)
  return withLockSync(instance, () => {
    const m = readSave(instance, name)
    if (m === null) throw new Error(`instance "${instance}" has no readable save "${name}"`)
    if (protect && (m.kind === "stow" || name === STOW)) {
      throw new Error("the stow save is a one-shot resume slot and cannot be protected — take a named checkpoint instead")
    }
    const next = { ...m, protected: protect }
    const file = resolve(saveDir(instance, name), FILES.manifest)
    const tmp = `${file}.tmp-${String(process.pid)}`
    try {
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
      renameSync(tmp, file)
    } finally {
      rmSync(tmp, { force: true })
    }
    return next
  })
}

/** The save, and the note on it. Caller holds the lock; protection is rechecked at deletion time. */
export function removeSave(instance: string, name: string, o: { readonly force?: boolean } = {}): void {
  assertRemovable(instance, name, o.force)
  rmSync(saveDir(instance, name), { recursive: true, force: true })
  forgetNote(instance, name)
}

/**
 * Every save of an instance, for `destroy`. Left behind, they are not just
 * gigabytes nobody can see in `ls`: a new instance of the same name inherits
 * them, so its first `start` recalls the old stow and `rewind` goes back to the
 * old baseline.
 */
export function removeAllSaves(instance: string): void {
  withLockSync(instance, () => {
    // Preflight everything before deleting anything: a protected (or damaged)
    // save is never swept away with its instance. `destroy --keep-saves` keeps it.
    for (const s of listSaves(instance)) assertRemovable(instance, s.name)
    // Keep the lock itself in place until the operation ends, including note
    // removal. Removing the directory would let a second writer in early.
    for (const entry of readdirSync(savesDir(instance))) {
      if (entry !== ".lock") rmSync(resolve(savesDir(instance), entry), { recursive: true, force: true })
    }
    try {
      removeNotes(instance)
    } catch {
      // An instance name notes.ts refuses has no notes to remove.
    }
  })
}

/** Notes are a nicety: a name notes.ts refuses, or a file it cannot delete, never fails a save operation. */
function forgetNote(instance: string, name: string): void {
  try {
    removeNote(instance, name)
  } catch {
    // see above
  }
}

function readNoteSafe(instance: string, name: string): Note | null {
  try {
    return readNote(instance, name)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// "This instance has never been started": the trigger for the automatic baseline

const pendingMarker = (instance: string): string => resolve(instanceDir(instance), "baseline.pending")
export const markPristine = (instance: string): void => writeFileSync(pendingMarker(instance), `${new Date().toISOString()}\n`)
export const isPristine = (instance: string): boolean => existsSync(pendingMarker(instance))
export const clearPristine = (instance: string): void => rmSync(pendingMarker(instance), { force: true })

// ---------------------------------------------------------------------------
// One save/load at a time per instance

/**
 * Two of these at once on one instance — a user's `load` racing an idle
 * watcher's automatic save — would quit QEMU under a migration, or clone a disk
 * mid-swap. A lock file holding the owner's pid; a dead owner's lock is stale.
 */
function acquireSaveLock(instance: string): string {
  mkdirSync(savesDir(instance), { recursive: true })
  const lock = resolve(savesDir(instance), ".lock")
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" })
      break
    } catch {
      const owner = Number.parseInt(readFileSync(lock, "utf8").trim(), 10)
      let alive = false
      try {
        if (Number.isFinite(owner)) {
          process.kill(owner, 0)
          alive = true
        }
      } catch {
        alive = false
      }
      if (alive || attempt > 0) {
        throw new Error(`instance "${instance}" is busy: another winvm (pid ${String(owner)}) is saving or loading it`)
      }
      rmSync(lock, { force: true })
    }
  }
  return lock
}

export async function withLock<T>(instance: string, fn: () => Promise<T>): Promise<T> {
  const lock = acquireSaveLock(instance)
  try {
    return await fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

/** Synchronous metadata changes and manual deletion share the migration lock. */
export function withLockSync<T>(instance: string, fn: () => T): T {
  const lock = acquireSaveLock(instance)
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Mechanics

const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

/** APFS clone (`cp -c`): near-free, shares blocks until either side writes. Plain copy elsewhere. */
export function cloneFile(src: string, dst: string): void {
  rmSync(dst, { force: true })
  if (spawnSync("cp", ["-c", src, dst], { stdio: "ignore" }).status === 0) return
  if (spawnSync("cp", [src, dst], { stdio: "inherit" }).status !== 0) throw new Error(`could not copy ${src} -> ${dst}`)
}

/** The fitted size of a thumbnail: inside `box`, aspect kept, never larger than `native`. */
export const thumbSize = (native: Size, box: Size = THUMB_BOX): Size => scaled(native, fitScale(native, box))

/** The raw screendump's name inside a save's in-progress directory: a dot-file, so a clone never copies one left behind. */
const SCREEN_PPM = ".screen.ppm"

/**
 * Grab the screen as a raw PPM into `dir`, for writeScreenshots. Raw because
 * it is the cheapest dump QEMU makes (~60 ms) and this runs while the guest is
 * stopped. Returns the file, or null when there is no screen to take — never
 * throws, never waits long.
 */
export async function captureScreen(qmpPath: string, dir: string, timeoutMs = 5000): Promise<string | null> {
  const file = resolve(dir, SCREEN_PPM)
  try {
    await qmp.execute(qmpPath, "screendump", { filename: file }, timeoutMs)
    return existsSync(file) ? file : null
  } catch {
    rmSync(file, { force: true })
    return null
  }
}

/**
 * Encode a raw screendump as the save's screen.png and thumb.png in `dir`, and
 * delete the PPM. Returns the screen's size, or null (and no files) when it
 * could not be read or written.
 */
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

/** Whether a running instance was started with `-snapshot`, whose disk writes go nowhere durable. */
export function isEphemeral(p: Paths): boolean {
  const pid = qemu.pidOf(p)
  if (pid === null) return false
  return / -snapshot( |$)/.test(capture("ps", ["-o", "command=", "-p", String(pid)]))
}

async function waitMigration(p: Paths, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = (await qmp.execute(p.qmp, "query-migrate")) as Record<string, unknown>
    const s = r["status"]
    if (s === "completed") return r
    if (s === "failed" || s === "cancelled") throw new Error(`migration ${s}: ${String(r["error-desc"] ?? "no detail")}`)
    await sleep(250)
  }
  throw new Error("the save did not finish in time")
}

/** Ask QEMU to exit now (no guest shutdown), and wait until it has. */
export async function quitQemu(p: Paths, timeoutMs = 120_000): Promise<void> {
  const pid = qemu.pidOf(p)
  if (pid === null) return
  // The guest's drives in Finder go first, while their server still answers
  // (a load, a golden reset; `stow` unmounted before it froze the guest).
  finder.beforeDown(instanceOf(p))
  try {
    await qmp.execute(p.qmp, "quit", undefined, 20_000)
  } catch {
    // The monitor may drop before it answers; the pid is what decides.
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (qemu.pidOf(p) === null) {
      qemu.stopSidecars(p)
      return
    }
    // QEMU is usually gone ~10 ms after `quit`; a 250 ms poll was a quarter of a mapped load.
    await sleep(20)
  }
  process.kill(pid, "SIGKILL")
  while (qemu.pidOf(p) !== null) await sleep(250)
  qemu.stopSidecars(p)
}

export interface CreateOptions {
  readonly name: string
  readonly kind: SaveKind
  readonly note?: string
  /** How to write the RAM; see "RAM formats". Default "zstd". */
  readonly format?: RamFormat
  /** Older spelling: false means `format: "raw"`. Ignored when `format` is given. */
  readonly compress?: boolean
  /** Quit QEMU once saved instead of resuming (stow). */
  readonly quitAfter?: boolean
}

export interface CreateResult {
  readonly manifest: Manifest
  /** QEMU's own figures for the stream: RAM transferred before compression. */
  readonly rawRamBytes: number
  /** Whether the guest was running before (and so has been resumed). */
  readonly resumed: boolean
}

/**
 * Save the running instance. The caller checks readiness and holds the lock.
 * On return the guest is running again (if it was) — its clock is the caller's
 * job (clock.ts), because it needs the agent.
 */
export async function createSave(instance: string, o: CreateOptions): Promise<CreateResult> {
  // Refuse replacement before touching QEMU, disk files or the old note.
  assertRemovable(instance, o.name)
  const p = pathsFor(instance)
  const meta = readMeta(instance)
  if (meta === null) throw new Error(`no such instance "${instance}"`)
  if (!qemu.isRunning(p)) throw new Error(`instance "${instance}" is not running — a save captures a live guest`)
  if (isEphemeral(p)) throw new Error(`instance "${instance}" is --ephemeral; its disk changes are not durable, so it cannot be saved`)
  const nameErr = nameError(o.name)
  if (nameErr !== null) throw new Error(nameErr)
  // The size and display QEMU runs at, not the settings: a guest loaded from a
  // save runs at the save's size and display whatever the machine is set to
  // (hardware.ts, display.ts). An unidentifiable display is refused HERE, while
  // nothing has been stopped or written: not after the guest is already frozen.
  const pid = qemu.pidOf(p)
  const hardware = (pid === null ? null : runningHardware(pid)) ?? readHardware(p)
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
  // Restoring launches the shared folder's devices by the display alone
  // (qemu.launchDevices), so a process running with a different set (the ramfb
  // boot of `share install` has them) could not be loaded: QEMU would refuse the
  // stream after the guest was stopped and its disks replaced. Refused here,
  // like an unidentified display, while nothing has been stopped or written.
  const replayShares = qemu.launchDevices(p, { installMedia: false, display }).devices !== "none"
  if (sharesFolderFromCommandLine(command) !== replayShares) {
    throw new Error(
      `"${instance}" is running a temporary setup configuration (its shared folder devices differ from what restoring a ${display.device} guest launches, as during \`winvm share install\`), ` +
        "so a save could not be restored; nothing was saved. Save after it finishes",
    )
  }
  const compat = currentCompat(instance, meta, display, hardware)

  const tmp = resolve(savesDir(instance), `.${o.name}.partial-${String(process.pid)}`)
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
  // Not the user's pause, for anyone reading the status meanwhile (frozen.ts).
  if (wasRunning) markSavingRunning(p)
  try {
    if (wasRunning) await qmp.execute(p.qmp, "stop")
    // The screen exactly as saved; encoded once the guest runs again.
    ppm = await captureScreen(p.qmp, tmp)
    await qmp.execute(p.qmp, "migrate-set-capabilities", { capabilities: plan.capabilities })
    await qmp.execute(p.qmp, "migrate-set-parameters", plan.parameters)
    await qmp.execute(p.qmp, "migrate", { uri: plan.uri })
    migrated = await waitMigration(p, 30 * 60_000)
    // Still stopped, block devices flushed and inactive: the disks now match
    // the RAM just written.
    cloneFile(p.overlay, resolve(tmp, FILES.overlay))
    cloneFile(p.vars, resolve(tmp, FILES.vars))
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    if (wasRunning) await qmp.execute(p.qmp, "cont").catch(() => undefined)
    clearSavingRunning(p)
    throw error
  }
  try {
    if (o.quitAfter === true) {
      await quitQemu(p)
    } else if (wasRunning) {
      await qmp.execute(p.qmp, "cont")
    }
  } finally {
    clearSavingRunning(p)
  }
  const saveMs = Date.now() - started
  const screen = ppm === null ? null : writeScreenshots(ppm, tmp)

  const ramBytes = allocated(ramPath)
  const bytes = ramBytes + allocated(resolve(tmp, FILES.overlay)) + allocated(resolve(tmp, FILES.vars))
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
    ...(screen === null ? {} : { screenshot: FILES.screen, thumbnail: FILES.thumb, screenSize: screen }),
  }
  writeFileSync(resolve(tmp, FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`)

  // Replace any save of the same name only once the new one is complete.
  const final = saveDir(instance, o.name)
  const old = resolve(savesDir(instance), `.${o.name}.old-${String(process.pid)}`)
  const replaced = existsSync(final)
  if (replaced) renameSync(final, old)
  renameSync(tmp, final)
  rmSync(old, { recursive: true, force: true })
  // The old save's note described the old moment, not this one.
  if (replaced) forgetNote(instance, o.name)

  const ram = migrated["ram"] as { transferred?: number; total?: number } | undefined
  return { manifest, rawRamBytes: ram?.transferred ?? 0, resumed: wasRunning && o.quitAfter !== true }
}

export class IncompatibleSave extends Error {}

/**
 * Copy save `name` of instance `from` to instance `to` (created if missing,
 * on the save's image), for a pool of identical instances: `winvm test --pool`
 * takes one golden and hands every member a copy rather than booting and
 * settling each one.
 *
 * Every file is an APFS clone, so a 4 GiB mapped-ram golden costs nothing to
 * copy and each instance's loads stay independent (copy-on-write). The
 * migration stream holds no per-instance identity a load depends on: QEMU's
 * paths, sockets and VNC port are not in it (see "Compatibility"), the disks
 * descend from the same base, and TPM state travels inside the stream. Refuses
 * — IncompatibleSave — when `to`'s hardware hash differs from the save's.
 *
 * The copy's manifest names `to` and records `clonedFrom`, so a caller can
 * tell a stale copy from a current one. The guest inside still holds `from`'s
 * agent token: the caller copies that across (agentfwd.ts state) too.
 */
export async function cloneSave(from: string, to: string, name: string): Promise<Manifest> {
  const m = readSave(from, name)
  if (m === null) throw new Error(`instance "${from}" has no save "${name}"`)
  // A new copy gets the source's cold-boot preference. A save with a recorded
  // display is judged and launched by that (compatFor) whatever the preference;
  // a legacy save has only the preference to be judged by, so it must match.
  if (readMeta(to) === null) ensureInstance(to, m.image, readDisplay(pathsFor(from)))
  const meta = readMeta(to)
  if (meta === null) throw new Error(`could not create instance "${to}"`)
  if (meta.image !== m.image) {
    throw new IncompatibleSave(`save "${name}" is of image "${m.image}", but instance "${to}" runs "${meta.image}"`)
  }
  const now = compatFor(to, meta, m)
  if (now.hash !== m.compat) {
    const why = m.compatParts === undefined ? [] : compatDiff(m.compatParts, now.parts)
    throw new IncompatibleSave(`"${to}" differs from "${from}"${why.length > 0 ? `: ${why.join("; ")}` : ""}`)
  }
  const src = saveDir(from, name)
  return await withLock(to, async () => {
    assertRemovable(to, name)
    const tmp = resolve(savesDir(to), `.${name}.partial-${String(process.pid)}`)
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    try {
      for (const f of readdirSync(src)) {
        if (f.startsWith(".") || f === FILES.manifest) continue
        cloneFile(resolve(src, f), resolve(tmp, f))
      }
      const copy = { ...m, instance: to, clonedFrom: { instance: from, createdAt: m.createdAt } }
      writeFileSync(resolve(tmp, FILES.manifest), `${JSON.stringify(copy, null, 2)}\n`)
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
    } catch {
      // The copy loads either way; a note is not worth failing it for.
    }
    return parseManifest(readFileSync(resolve(final, FILES.manifest), "utf8"))
  })
}


/**
 * Put an instance into a save's state, running or not. QEMU is restarted
 * either way (see "Loading" above). On return the guest is running; waiting for
 * its agent and fixing its clock is the caller's job.
 */
export async function loadSave(instance: string, name: string): Promise<Manifest> {
  const m = readSave(instance, name)
  if (m === null) throw new Error(`instance "${instance}" has no save "${name}" — \`winvm saves -i ${instance}\``)
  const created = readMeta(instance) === null
  if (created) ensureInstance(instance, m.image)
  const meta = readMeta(instance)
  if (meta === null) throw new Error(`no such instance "${instance}"`)
  if (meta.image !== m.image) {
    throw new IncompatibleSave(`save "${name}" is of image "${m.image}", but instance "${instance}" runs "${meta.image}"`)
  }
  // Judged, and launched below, at the save's own size and display: changing
  // the machine's setting or its display preference never makes a save
  // unloadable, and loading never writes either (hardware.ts, display.ts).
  const now = compatFor(instance, meta, m)
  if (m.compat !== now.hash) {
    const devices = takenBeforeDevices(m, hardwareBeforeDevices(instance, meta))
    const diff = m.compatParts === undefined ? [] : compatDiff(m.compatParts, now.parts)
    const why = diff.map((w) =>
      devices && w === "the virtual hardware (QEMU arguments) changed" ? "it was taken before winvm added the shared folder and clipboard devices" : w,
    )
    // Without a recorded display the instance's own is all it can be judged by.
    const manual =
      m.display === undefined && !devices && (m.compatParts === undefined || diff.some((w) => w.startsWith("the virtual hardware")))
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
  for (const f of [ramPath, resolve(dir, FILES.overlay), resolve(dir, FILES.vars)]) {
    if (!existsSync(f)) throw new Error(`save "${name}" is incomplete: ${f} is missing`)
  }

  const p = pathsFor(instance)
  await quitQemu(p)
  // Clone to a temporary name and rename over, so a failure halfway never
  // leaves the instance with one disk from the save and one from before.
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
    // The display the compatibility check above was made with: the save's own, never display.json.
    display: now.display,
  })
  if (plan.incoming === "defer") {
    await qmp.execute(p.qmp, "migrate-set-capabilities", { capabilities: plan.capabilities })
    await qmp.execute(p.qmp, "migrate-set-parameters", plan.parameters)
    await qmp.execute(p.qmp, "migrate-incoming", { uri: plan.uri })
  }
  // The stream records the source's run state, and a save stops the guest
  // first — so the destination ends PAUSED, and is continued here.
  const deadline = Date.now() + 30 * 60_000
  for (;;) {
    if (!qemu.isRunning(p)) {
      let why = ""
      try {
        why = readFileSync(p.qemuLog, "utf8").trim()
      } catch {
        // no log
      }
      throw new Error(`QEMU exited while loading save "${name}"${why === "" ? "" : `:\n  ${why.split("\n").join("\n  ")}`}`)
    }
    let s = "unknown"
    try {
      s = await qmp.status(p.qmp)
    } catch {
      // The monitor is busy while the stream is read; ask again.
    }
    if (s === "running") break
    if (s === "paused" || s === "postmigrate" || s === "prelaunch") {
      await qmp.execute(p.qmp, "cont")
      break
    }
    if (Date.now() > deadline) throw new Error(`loading save "${name}" did not finish in time (state: ${s})`)
    // Short: on a mapped save the whole load is about a second.
    await sleep(50)
  }
  return m
}
