import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"
import { gunzipSync } from "node:zlib"

import { keeperHint } from "./keeper"
import { type KeeperUse, keeperUse } from "./kept"
import { home, PACKAGE_DIR } from "./paths"
import { findRuntime, type Runtime, runtimeBin, verifyRuntime } from "./runtime"
import { capture, have, spawnText } from "./shell"

let dataDirs: {
  readonly key: string
  readonly dirs: readonly string[]
} | null = null
export function qemuDataDirs(): readonly string[] {
  const override = process.env.WINVM_QEMU_DATA
  const key = `${override ?? ""}\n${home()}`
  if (dataDirs?.key === key) return dataDirs.dirs
  const found = ((): readonly string[] => {
    if (override !== undefined && override !== "") return [resolve(override)]
    const vendored = expandVendoredFirmware()
    if (vendored !== null) return [vendored]
    const asked = spawnText(runtimeBin("qemu-system-aarch64"), ["-L", "help"])
    return `${asked.stdout}${asked.stderr}`
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("/"))
      .map((l) => resolve(l))
  })()
  dataDirs = { key, dirs: found }
  return found
}

let tpmPpi: boolean | null = null
export function tpmTisHasPpi(): boolean {
  if (tpmPpi !== null) return tpmPpi
  const rt = findRuntime()
  if (rt === null) return false
  const r = spawnText(resolve(rt.dir, "bin", "qemu-system-aarch64"), [
    "-M",
    "virt",
    "-device",
    "tpm-tis-device,help",
  ])
  tpmPpi = parseHasPpi(`${r.stdout}${r.stderr}`)
  return tpmPpi
}

export const parseHasPpi = (help: string): boolean => /^\s*ppi=/m.test(help)

function expandVendoredFirmware(): string | null {
  const src = resolve(PACKAGE_DIR, "firmware")
  const gz = [`${CODE_NAMES[0]}.gz`, `${VARS_NAMES[0]}.gz`]
  if (!gz.every((f) => existsSync(resolve(src, f)))) return null

  const dest = resolve(home(), "firmware")
  mkdirSync(dest, { recursive: true })
  for (const f of gz) {
    const out = resolve(dest, f.replace(/\.gz$/, ""))
    if (sizeOrZero(out) === EXPECTED_FIRMWARE_BYTES) continue
    writeFileSync(out, gunzipSync(readFileSync(resolve(src, f))))
  }
  return dest
}

const EXPECTED_FIRMWARE_BYTES = 64 * 1024 * 1024

const sizeOrZero = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function findFirmware(names: readonly string[]): string | null {
  for (const dir of qemuDataDirs()) {
    for (const name of names) {
      const candidate = resolve(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const CODE_NAMES = [
  "edk2-aarch64-code.fd",
  "AAVMF_CODE.fd",
  "QEMU_EFI.fd",
] as const
const VARS_NAMES = [
  "edk2-arm-vars.fd",
  "AAVMF_VARS.fd",
  "QEMU_VARS.fd",
] as const

export const firmwareCode = (): string | null => findFirmware(CODE_NAMES)
export const firmwareVars = (): string | null => findFirmware(VARS_NAMES)

export function requireFirmware(): {
  readonly code: string
  readonly vars: string
} {
  const code = firmwareCode()
  const vars = firmwareVars()
  if (code === null || vars === null)
    throw new Error(`UEFI firmware not found — ${firmwareHint()}`)
  return { code, vars }
}

export function firmwareHint(): string {
  const dirs = qemuDataDirs()
  return (
    `looked for ${CODE_NAMES.join(" / ")} in ${dirs.length === 0 ? "(no QEMU data directories found)" : dirs.join(", ")}` +
    " — set WINVM_QEMU_DATA to point at them"
  )
}

export const TOOLS_URL =
  "https://github.com/utmapp/qemu/releases/download/v10.0.2-utm/utm-guest-tools-0.1.271.iso"
export const TOOLS_SHA256 =
  "65b6a69b392ee01dd314c10f3dad9ebbf9c4160be43f5f0dd6bb715944d9095b"

export const PWSH_VERSION = "7.6.7"
export const PWSH_URL = `https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/PowerShell-${PWSH_VERSION}-win-arm64.msi`
export const PWSH_SHA256 =
  "ddb2f3613a0ad27817b90601a0827f7347e81dfa5bce18d4be8009b8cb0e0a31"

export interface Check {
  readonly label: string
  readonly ok: boolean
  readonly hint: string
}

export function runtimeCheck(
  rt: Runtime | null,
  problems: readonly string[],
): Check {
  if (rt === null)
    return { label: "runtime (not installed)", ok: false, hint: "winvm setup" }
  if (rt.source === "override") {
    const note =
      problems.length === 0 ? "" : ` (unverified: ${problems[0] ?? ""})`
    return { label: `runtime override ${rt.dir}${note}`, ok: true, hint: "" }
  }
  const version = rt.manifest?.version ?? "?"
  if (problems.length > 0) {
    const more =
      problems.length > 1 ? ` (and ${String(problems.length - 1)} more)` : ""
    return {
      label: `runtime ${version} does not verify: ${problems[0] ?? ""}${more}`,
      ok: false,
      hint: "winvm setup",
    }
  }
  return {
    label: `runtime ${version} (QEMU ${rt.manifest?.qemu ?? "?"}, ${rt.source})`,
    ok: true,
    hint: "",
  }
}

export type KeeperNeed = "required" | "optional"

export function keeperCheck(use: KeeperUse, need: KeeperNeed): Check {
  if (use.kind === "keeper")
    return {
      label: `keeper ${use.keeper.path} (${use.keeper.source})`,
      ok: true,
      hint: "",
    }
  return need === "required"
    ? {
        label: "keeper not installed: winvm starts no VM without it",
        ok: false,
        hint: keeperHint(),
      }
    : {
        label: `keeper not installed yet, so no VM starts until one is: ${keeperHint()}`,
        ok: true,
        hint: "",
      }
}

export function macosCheck(productVersion: string, arch: string): Check {
  const label = `macOS ${productVersion} on ${arch === "arm64" ? "Apple Silicon" : arch}`
  if (arch !== "arm64")
    return { label, ok: false, hint: "winvm needs an Apple Silicon Mac" }
  const major = Number.parseInt(productVersion.split(".")[0] ?? "0", 10)
  return major >= 15
    ? { label, ok: true, hint: "" }
    : { label, ok: false, hint: "winvm needs macOS 15 or later" }
}

export function hostChecks(keeper: KeeperNeed): readonly Check[] {
  const rt = findRuntime()
  return [
    macosCheck(capture("sw_vers", ["-productVersion"]), process.arch),
    runtimeCheck(rt, rt === null ? [] : verifyRuntime(rt)),
    keeperCheck(keeperUse(), keeper),
    {
      label: `UEFI firmware${firmwareCode() === null ? "" : ` (${String(firmwareCode())})`}`,
      ok: firmwareCode() !== null && firmwareVars() !== null,
      hint: firmwareHint(),
    },
    { label: "hdiutil", ok: have("hdiutil"), hint: "macOS built-in" },
  ]
}

export interface ChecksReport {
  readonly ready: boolean
  readonly checks: readonly Check[]
  readonly timeMachine: string
}

export const checksReport = (
  checks: readonly Check[],
  timeMachine: string,
): ChecksReport => ({
  ready: checks.every((c) => c.ok),
  checks,
  timeMachine,
})

export function printChecks(checks: readonly Check[]): number {
  for (const c of checks)
    console.log(
      `${c.ok ? "ok  " : "MISS"}  ${c.label}${c.ok ? "" : `  -> ${c.hint}`}`,
    )
  return checks.filter((c) => !c.ok).length
}

export function hostMissing(keeper: KeeperNeed): boolean {
  const missing = hostChecks(keeper).filter((c) => !c.ok)
  if (missing.length === 0) return false
  console.error("::error::missing prerequisites — run `winvm doctor`")
  for (const c of missing) console.error(`  ${c.label} -> ${c.hint}`)
  return true
}

export function requireHost(keeper: KeeperNeed): void {
  if (hostMissing(keeper)) process.exit(1)
}
