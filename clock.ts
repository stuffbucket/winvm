/**
 * Keep the guest's clock on the host's.
 *
 * WHY A RESTORED GUEST IS IN THE PAST. Windows keeps time from the CPU's
 * virtual counter once it is running and reads the RTC only at boot. Anything
 * that freezes the machine — `pause`, a save (the guest is stopped while its
 * RAM is written), `stow`, `load`, `rewind` — stops that counter too, so the
 * guest resumes believing no time passed: a save loaded an hour later is an
 * hour slow, and a guest paused for two minutes is two minutes slow. The RTC
 * device does not help: QEMU's PL031 is driven by the host clock and is correct
 * after a restore, but Windows never looks at it again.
 *
 * So the fix is to TELL the guest the time, through the guest agent:
 * `guest-set-time` with UTC nanoseconds (qemu-ga on Windows requires the
 * argument — it has no RTC-reading mode there — and calls SetSystemTime as
 * SYSTEM). The guest's time zone is irrelevant to this: the agent's clock is
 * UTC on both ends.
 *
 * A COLD BOOT WAS WRONG TOO, for a different reason: the answer file pins the
 * guest's time zone to UTC, while QEMU was started with `-rtc base=localtime`,
 * so a Pacific host handed it Pacific wall time labelled as UTC — seven hours
 * slow. qemu.ts now uses `base=utc`, which matches what the guest assumes; the
 * boot path syncs as well, so a host or guest with other ideas is corrected
 * either way.
 */
import { FFIType, dlopen, ptr } from "bun:ffi"

import type { Paths } from "./paths"
import * as qga from "./qga"

export interface OffsetSample {
  /** guest − host, in ms. Negative: the guest is behind. */
  readonly offsetMs: number
  /** Round trip of the probe; the offset is uncertain by about half of it. */
  readonly rttMs: number
}

async function guestNowNs(p: Paths): Promise<number> {
  const r = await qga.call(p.qga, { execute: "guest-get-time" }, 20_000)
  const t = r["return"]
  if (typeof t !== "number") throw new Error(`guest-get-time: ${JSON.stringify(r)}`)
  return t
}

/**
 * One offset measurement, taken as the best of a few probes: the guest's answer
 * is compared with the host time at the MIDPOINT of the round trip, and the
 * probe with the shortest round trip is the least uncertain.
 */
export async function measureOffset(p: Paths, probes = 3): Promise<OffsetSample> {
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

/**
 * Set the guest's clock to the host's, and report the offset before and after.
 * The guest must be running and its agent answering (see qga.waitResponsive).
 *
 * The set is aimed at the moment the guest will apply it — host time plus half
 * the measured round trip — and corrected once more if it still misses by more
 * than 50 ms, which removes most of the agent's (emulated x86) processing lag.
 */
export async function syncGuestClock(p: Paths): Promise<{ beforeOffsetMs: number; afterOffsetMs: number }> {
  const before = await measureOffset(p)
  let after = before
  let bias = 0
  for (let round = 0; round < 3; round += 1) {
    const ns = (Date.now() + after.rttMs / 2 + bias) * 1e6
    const r = await qga.call(p.qga, { execute: "guest-set-time", arguments: { time: Math.round(ns) } }, 20_000)
    if (r["error"] !== undefined) throw new Error(`guest-set-time: ${JSON.stringify(r["error"])}`)
    after = await measureOffset(p)
    if (Math.abs(after.offsetMs) <= 50) break
    bias -= after.offsetMs
  }
  return { beforeOffsetMs: before.offsetMs, afterOffsetMs: after.offsetMs }
}

/** "-27583.1 s", "+12 ms" — offsets span milliseconds to hours. */
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

// ---------------------------------------------------------------------------
// Time zone: the guest's DISPLAYED time should read like the host's.
//
// Correct UTC is not enough on its own: the answer file pins the guest to UTC,
// so its taskbar reads seven hours off a Pacific host even when its clock is
// exact. The host's IANA zone is mapped to a Windows zone id by the host's own
// ICU (`ucal_getWindowsTimeZoneID` in macOS's libicucore — the CLDR
// windowsZones table, with no copy of it kept here), then set with `tzutil`.
//
// Once the zone is not UTC, the RTC's meaning must not depend on it: Windows
// reads the RTC as LOCAL time unless RealTimeIsUniversal=1, and qemu.ts feeds
// it UTC. So the same step sets that key; from then on a cold boot is right in
// any zone, and every boot is resynced anyway.

const TZ_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation"
const SYS32 = "C:\\Windows\\System32"

/** The host's zone as a Windows zone id ("Pacific Standard Time"), or null if it cannot be mapped. */
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
      const id = new Uint16Array([...iana].map((c) => c.charCodeAt(0)))
      const out = new Uint16Array(128)
      const status = new Int32Array(1)
      const n = lib.symbols.ucal_getWindowsTimeZoneID(ptr(id), id.length, ptr(out), out.length, ptr(status))
      if ((status[0] ?? 1) > 0 || n <= 0) return null
      return String.fromCharCode(...out.subarray(0, n))
    } finally {
      lib.close()
    }
  } catch {
    return null
  }
}

/** Parse `tzutil /g` + `reg query … RealTimeIsUniversal` output (one cmd.exe run). */
export function parseGuestTz(out: string): { zone: string; rtcUtc: boolean } {
  const zone = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? ""
  const m = /RealTimeIsUniversal\s+REG_\w+\s+0x([0-9a-f]+)/i.exec(out)
  return { zone, rtcUtc: m?.[1] !== undefined && Number.parseInt(m[1], 16) === 1 }
}

/**
 * Put the guest in the host's time zone, with its RTC read as UTC. Costs one
 * guest command when nothing needs changing. Returns null when the host zone
 * cannot be mapped (the guest is left alone).
 */
export async function alignGuestTimeZone(p: Paths): Promise<{ from: string; to: string; changed: boolean } | null> {
  const want = hostWindowsTimeZone()
  if (want === null) return null
  const now = parseGuestTz(
    (await qga.exec(p.qga, `${SYS32}\\cmd.exe`, ["/c", `tzutil /g & echo. & reg query ${TZ_KEY} /v RealTimeIsUniversal`])).stdout,
  )
  if (now.zone === want && now.rtcUtc) return { from: now.zone, to: want, changed: false }
  if (!now.rtcUtc) {
    const r = await qga.exec(p.qga, `${SYS32}\\reg.exe`, [
      "add", TZ_KEY, "/v", "RealTimeIsUniversal", "/t", "REG_DWORD", "/d", "1", "/f",
    ])
    if (r.exitcode !== 0) throw new Error(`could not set RealTimeIsUniversal: ${r.stderr.trim() || r.stdout.trim()}`)
  }
  if (now.zone !== want) {
    // Called directly, not through cmd: qemu-ga quotes an argument with spaces
    // correctly, and cmd.exe would mangle the nested quotes.
    const r = await qga.exec(p.qga, `${SYS32}\\tzutil.exe`, ["/s", want])
    if (r.exitcode !== 0) throw new Error(`tzutil /s "${want}" failed: ${r.stderr.trim() || r.stdout.trim()}`)
  }
  return { from: now.zone, to: want, changed: true }
}
