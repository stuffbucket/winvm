import { FFIType, dlopen, ptr } from "bun:ffi"

import type { Paths } from "./paths"
import * as qga from "./qga"

export interface OffsetSample {
  readonly offsetMs: number
  readonly rttMs: number
}

async function guestNowNs(p: Paths): Promise<number> {
  const r = await qga.call(p.qga, { execute: "guest-get-time" }, 20_000)
  const t = r["return"]
  if (typeof t !== "number")
    throw new Error(`guest-get-time: ${JSON.stringify(r)}`)
  return t
}

export async function measureOffset(
  p: Paths,
  probes = 3,
): Promise<OffsetSample> {
  let best: OffsetSample | null = null
  for (let i = 0; i < probes; i += 1) {
    const t0 = Date.now()
    const g = (await guestNowNs(p)) / 1e6
    const t1 = Date.now()
    const sample = { offsetMs: Math.round(g - (t0 + t1) / 2), rttMs: t1 - t0 }
    if (best === null || sample.rttMs < best.rttMs) best = sample
  }
  if (best === null) throw new Error("no clock probe completed")
  return best
}

export async function syncGuestClock(
  p: Paths,
): Promise<{ beforeOffsetMs: number; afterOffsetMs: number }> {
  const before = await measureOffset(p)
  let after = before
  let bias = 0
  for (let round = 0; round < 3; round += 1) {
    const ns = (Date.now() + after.rttMs / 2 + bias) * 1e6
    const r = await qga.call(
      p.qga,
      { execute: "guest-set-time", arguments: { time: Math.round(ns) } },
      20_000,
    )
    if (r["error"] !== undefined)
      throw new Error(`guest-set-time: ${JSON.stringify(r["error"])}`)
    after = await measureOffset(p)
    if (Math.abs(after.offsetMs) <= 50) break
    bias -= after.offsetMs
  }
  return { beforeOffsetMs: before.offsetMs, afterOffsetMs: after.offsetMs }
}

export function formatOffset(ms: number): string {
  const sign = ms < 0 ? "-" : "+"
  const a = Math.abs(ms)
  if (a < 1000) return `${sign}${String(Math.round(a))} ms`
  if (a < 120_000) return `${sign}${(a / 1000).toFixed(1)} s`
  const h = Math.floor(a / 3_600_000)
  const m = Math.floor((a % 3_600_000) / 60_000)
  const s = Math.round((a % 60_000) / 1000)
  return `${sign}${h > 0 ? `${String(h)}h ` : ""}${String(m)}m ${String(s)}s`
}

const TZ_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation"
const SYS32 = "C:\\Windows\\System32"

export function hostWindowsTimeZone(): string | null {
  const iana = Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    const lib = dlopen("/usr/lib/libicucore.A.dylib", {
      ucal_getWindowsTimeZoneID: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
    })
    try {
      const id = Uint16Array.from(iana, (c) => c.charCodeAt(0))
      const out = new Uint16Array(128)
      const status = new Int32Array(1)
      const n = lib.symbols.ucal_getWindowsTimeZoneID(
        ptr(id),
        id.length,
        ptr(out),
        out.length,
        ptr(status),
      )
      if ((status[0] ?? 1) > 0 || n <= 0) return null
      return String.fromCharCode(...out.subarray(0, n))
    } finally {
      lib.close()
    }
  } catch {
    return null
  }
}

export function parseGuestTz(out: string): { zone: string; rtcUtc: boolean } {
  const zone =
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  const m = /RealTimeIsUniversal\s+REG_\w+\s+0x([0-9a-f]+)/i.exec(out)
  return {
    zone,
    rtcUtc: m?.[1] !== undefined && Number.parseInt(m[1], 16) === 1,
  }
}

export async function alignGuestTimeZone(
  p: Paths,
): Promise<{ from: string; to: string; changed: boolean } | null> {
  const want = hostWindowsTimeZone()
  if (want === null) return null
  const now = parseGuestTz(
    (
      await qga.exec(p.qga, `${SYS32}\\cmd.exe`, [
        "/c",
        `tzutil /g & echo. & reg query ${TZ_KEY} /v RealTimeIsUniversal`,
      ])
    ).stdout,
  )
  if (now.zone === want && now.rtcUtc)
    return { from: now.zone, to: want, changed: false }
  if (!now.rtcUtc) {
    const r = await qga.exec(p.qga, `${SYS32}\\reg.exe`, [
      "add",
      TZ_KEY,
      "/v",
      "RealTimeIsUniversal",
      "/t",
      "REG_DWORD",
      "/d",
      "1",
      "/f",
    ])
    if (r.exitcode !== 0)
      throw new Error(
        `could not set RealTimeIsUniversal: ${r.stderr.trim() || r.stdout.trim()}`,
      )
  }
  if (now.zone !== want) {
    const r = await qga.exec(p.qga, `${SYS32}\\tzutil.exe`, ["/s", want])
    if (r.exitcode !== 0)
      throw new Error(
        `tzutil /s "${want}" failed: ${r.stderr.trim() || r.stdout.trim()}`,
      )
  }
  return { from: now.zone, to: want, changed: true }
}
