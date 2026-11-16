import type { Dirent } from "node:fs"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { resolve } from "node:path"

import { capture, download, quiet, run } from "./shell"
import { PACKAGE_DIR, media, mediaDir, pinnedBunVersion } from "./paths"

const ASSETS = resolve(PACKAGE_DIR, "assets")

const WINVM_EXTRAS = [
  "defender.ps1",
  "logon.ps1",
  "agent-install.ps1",
  "runinsession.cs",
  "winvm-ui.cs",
  "conpty.cs",
  "winvm-display.cs",
] as const

export const agentBunVersion = (): string => pinnedBunVersion() ?? Bun.version

export function bunZip(): string {
  const v = agentBunVersion()
  const f = resolve(mediaDir(), `bun-windows-aarch64-${v}.zip`)
  if (!existsSync(f)) {
    mkdirSync(mediaDir(), { recursive: true })
    download(
      `https://github.com/oven-sh/bun/releases/download/bun-v${v}/bun-windows-aarch64.zip`,
      f,
    )
  }
  return f
}

export function makeResultVolume(dest: string): void {
  rmSync(dest, { force: true })
  run("dd", ["if=/dev/zero", `of=${dest}`, "bs=1m", "count=64", "status=none"])

  const dev = capture("hdiutil", ["attach", "-nomount", dest]).split(/\s+/)[0]
  if (dev === undefined || dev === "")
    throw new Error("could not attach result image")
  run("newfs_msdos", ["-F", "32", "-v", "MAXRESULT", dev])
  detachOrThrow(dev, dest)

  const mnt = mkdtempSync(resolve(tmpdir(), "winvm-result-"))
  try {
    if (
      quiet("hdiutil", ["attach", "-nobrowse", "-mountpoint", mnt, dest]) !== 0
    ) {
      throw new Error("could not mount result image")
    }
    writeFileSync(
      resolve(mnt, "startup.nsh"),
      readFileSync(resolve(ASSETS, "startup.nsh")),
    )
    writeFileSync(
      resolve(mnt, "autounattend.xml"),
      readFileSync(resolve(ASSETS, "autounattend.xml")),
    )
    writeFileSync(
      resolve(mnt, "SetupComplete.cmd"),
      readFileSync(resolve(ASSETS, "SetupComplete.cmd")),
    )
    writeFileSync(
      resolve(mnt, "provision.ps1"),
      readFileSync(resolve(ASSETS, "provision.ps1")),
    )
    detachOrThrow(mnt, dest)
  } finally {
    rmSync(mnt, { recursive: true, force: true })
  }
}

function detachOrThrow(target: string, image: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (quiet("hdiutil", ["detach", target]) === 0) return
    Bun.sleepSync(1000)
  }
  if (quiet("hdiutil", ["detach", "-force", target]) === 0) return
  throw new Error(`could not detach ${image} (${target}); see \`hdiutil info\``)
}

export function resolveWindowsIso(explicit: string | undefined): string | null {
  const fromFlag = explicit ?? process.env.WINVM_ISO
  if (fromFlag !== undefined && fromFlag !== "") {
    const path = resolve(fromFlag.replace(/^~(?=\/)/, homedir()))
    if (!existsSync(path)) {
      console.error(`::error::no such ISO: ${path}`)
      return null
    }
    return path
  }
  if (existsSync(media.iso())) return media.iso()

  const found = discoverIsos()
  const [only] = found
  if (found.length === 1 && only !== undefined) {
    console.log(`using ${only}`)
    return only
  }
  if (found.length > 1) {
    console.log("found more than one candidate; pass --iso to choose:")
    for (const f of found) console.log(`  ${f}`)
    return null
  }
  return promptForIso()
}

function discoverIsos(): readonly string[] {
  const roots = [
    resolve(homedir(), "vm"),
    resolve(homedir(), "isos"),
    mediaDir(),
  ]
  const out: string[] = []
  for (const root of roots) {
    for (const entry of listDir(root)) {
      const path = resolve(root, entry.name)
      if (entry.isFile() && /arm64.*\.iso$/i.test(entry.name)) out.push(path)
      else if (entry.isDirectory()) {
        for (const inner of listDir(path)) {
          if (inner.isFile() && /arm64.*\.iso$/i.test(inner.name))
            out.push(resolve(path, inner.name))
        }
      }
    }
  }
  return [...new Set(out)]
}

function listDir(dir: string): readonly Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function promptForIso(): string | null {
  if (!process.stdin.isTTY) return null
  console.log(`No Windows 11 ARM64 ISO found. Get one from:\n  ${ISO_SOURCE}`)
  const answer = prompt("Path to the ISO (blank to cancel):")?.trim() ?? ""
  if (answer === "") return null
  const path = resolve(
    answer.replace(/^~(?=\/)/, homedir()).replace(/^['"]|['"]$/g, ""),
  )
  if (!existsSync(path)) {
    console.error(`::error::no such ISO: ${path}`)
    return null
  }
  return path
}

export const ISO_SOURCE =
  "https://www.microsoft.com/en-us/software-download/windows11arm64 " +
  "(multi-edition ARM64, no sign-in; the generated link expires after 24h)"

export function checkIsoIsArm64(iso: string): boolean {
  const mnt = mkdtempSync(resolve(tmpdir(), "winvm-iso-"))
  try {
    if (
      quiet("hdiutil", [
        "attach",
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        mnt,
        iso,
      ]) !== 0
    ) {
      console.warn(
        `warning: could not mount ${iso} to check its architecture; continuing`,
      )
      return true
    }
    const ok =
      existsSync(resolve(mnt, "efi/boot/bootaa64.efi")) ||
      existsSync(resolve(mnt, "EFI/BOOT/BOOTAA64.EFI"))
    if (!ok) {
      console.error(
        `::error::${iso} has no \\efi\\boot\\bootaa64.efi, so it is not Windows ARM64 media.\n  ${ISO_SOURCE}`,
      )
    }
    return ok
  } finally {
    quiet("hdiutil", ["detach", mnt])
    rmSync(mnt, { recursive: true, force: true })
  }
}

export interface ProvisionResult {
  readonly status: string | null
  readonly virtio: string | null
  readonly log: string
}

export function readResult(image: string): ProvisionResult {
  const mnt = mkdtempSync(resolve(tmpdir(), "winvm-result-"))
  try {
    if (
      quiet("hdiutil", [
        "attach",
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        mnt,
        image,
      ]) !== 0
    ) {
      return { status: null, virtio: null, log: "" }
    }
    const read = (n: string): string | null => {
      const f = resolve(mnt, n)
      return existsSync(f) ? readFileSync(f, "utf8") : null
    }
    return {
      status: read("status.txt")?.trim() ?? null,
      virtio: read("virtio.txt")?.trim() ?? null,
      log: read("provision.log") ?? "",
    }
  } finally {
    quiet("hdiutil", ["detach", mnt])
    rmSync(mnt, { recursive: true, force: true })
  }
}

export function buildSeed(
  payloadDir: string | undefined,
  bunVersion: string | undefined,
  shareMedia?: string,
): void {
  const dir = media.seedDir()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(resolve(dir, "payload"), { recursive: true })
  mkdirSync(resolve(dir, "winvm"), { recursive: true })
  for (const f of WINVM_EXTRAS)
    copyFileSync(resolve(ASSETS, f), resolve(dir, "winvm", f))
  copyFileSync(
    resolve(PACKAGE_DIR, "src", "guestagent.ts"),
    resolve(dir, "winvm", "guestagent.ts"),
  )
  if (
    run("unzip", [
      "-q",
      "-o",
      "-j",
      bunZip(),
      "bun-windows-aarch64/bun.exe",
      "-d",
      resolve(dir, "winvm"),
    ]) !== 0
  ) {
    throw new Error("could not unpack bun.exe for the guest agent")
  }
  if (existsSync(media.pwsh()))
    copyFileSync(
      media.pwsh(),
      resolve(dir, "winvm", "PowerShell-win-arm64.msi"),
    )
  if (shareMedia !== undefined) {
    mkdirSync(resolve(dir, "winvm", "viofs"), { recursive: true })
    for (const f of readdirSync(shareMedia))
      copyFileSync(resolve(shareMedia, f), resolve(dir, "winvm", "viofs", f))
    copyFileSync(
      resolve(ASSETS, "viofs-install.ps1"),
      resolve(dir, "winvm", "viofs", "viofs-install.ps1"),
    )
  }
  copyFileSync(
    resolve(ASSETS, "autounattend.xml"),
    resolve(dir, "autounattend.xml"),
  )
  copyFileSync(resolve(ASSETS, "provision.ps1"), resolve(dir, "provision.ps1"))
  copyFileSync(
    resolve(ASSETS, "SetupComplete.cmd"),
    resolve(dir, "SetupComplete.cmd"),
  )

  if (payloadDir !== undefined) {
    const src = resolve(payloadDir)
    if (!existsSync(src)) throw new Error(`no such payload directory: ${src}`)
    run("cp", ["-R", `${src}/.`, resolve(dir, "payload")])
  }

  if (bunVersion !== undefined) {
    download(
      `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-windows-aarch64.zip`,
      resolve(dir, "payload", "bun-windows-aarch64.zip"),
    )
  }

  rmSync(media.seed(), { force: true })
  run("hdiutil", [
    "makehybrid",
    "-iso",
    "-joliet",
    "-default-volume-name",
    "WINVMSEED",
    "-o",
    media.seed(),
    dir,
  ])
}
