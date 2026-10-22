/**
 * Goldens: a save taken to be loaded over and over — the state every test job
 * starts from — and the reset that goes back to it.
 *
 *   winvm golden create [-i name] [--name golden] [--from <save>] [--image <img>]
 *                       [--settle-cpu 3%] [--settle-for 60s] [--max-wait 10m]
 *   winvm golden reset  [-i name] [--name golden]
 *
 * For code (a job runner), the same two operations are `createGolden` and
 * `resetToGolden` below; neither prints anything.
 *
 * ## Why a golden is not just a save
 *
 * TAKEN SETTLED. A Windows that has just booted, or just been restored, is
 * still busy — services starting, indexing, Defender, .NET — and a save carries
 * that work with it: every load replays it, competing with the job for the
 * guest's CPUs. Measured while planning CI: pooled jobs started from a save
 * taken right after boot ran SLOWER than sequential ones. So `create` waits
 * until the guest has been quiet for a while, judged from the HOST — QEMU's
 * own CPU time, as a share of the guest's vCPUs — because asking the guest
 * (the agent, PowerShell) is itself work that keeps it busy.
 *
 * MAPPED-RAM. Written in the `mapped` RAM format (saves.ts, "RAM formats"):
 * ~7 s to take and twice the disk of zstd, but it restores in ~0.5 s rather
 * than ~2.5 s, and a golden is taken once and loaded hundreds of times.
 *
 * CLOCK. The guest's clock is set just before the save so the golden's own
 * notion of time is sane, and after every reset (it stood still since the
 * save) — see clock.ts.
 */
import type { Args } from "./args"
import { imageName, instanceName } from "./args"
import { alignGuestTimeZone, formatOffset, syncGuestClock } from "./clock"
import { capture } from "./host"
import { ensureInstance } from "./instance"
import type { Paths } from "./paths"
import { pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as saves from "./saves"
import * as watcher from "./watch"

// ---------------------------------------------------------------------------
// Pure logic (unit-tested)

export interface CpuSample {
  /** Wall clock, ms. */
  readonly atMs: number
  /** The QEMU process's accumulated CPU time, seconds (all threads). */
  readonly cpuSec: number
}

/** `ps -o time=` output — `[[dd-]hh:]mm:ss.ss` — in seconds. NaN if unreadable. */
export function parseCpuTime(s: string): number {
  const t = s.trim()
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t)
  if (m === null) return Number.NaN
  const [, d, h, min, sec] = m
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec)
}

/** The `-smp` count on a QEMU command line (`-smp 4` or `-smp cpus=4,...`); 1 if absent. */
export function parseSmp(cmdline: string): number {
  const m = /(?:^|\s)-smp\s+(?:cpus=)?(\d+)/.exec(cmdline)
  return m?.[1] === undefined ? 1 : Number(m[1])
}

/** CPU use between two samples, as a percentage of ALL the guest's vCPUs (100 = every vCPU flat out). */
export function cpuPercent(a: CpuSample, b: CpuSample, vcpus: number): number {
  const wall = (b.atMs - a.atMs) / 1000
  if (wall <= 0) return 0
  return ((b.cpuSec - a.cpuSec) / wall / Math.max(1, vcpus)) * 100
}

/**
 * Whether the guest has been quiet for the last `forMs`: the samples cover at
 * least that window, and every interval inside it was at or under `maxPct`.
 * Every interval, not the average — a quiet minute with one burst in it is a
 * guest that is still doing something.
 */
export function isSettled(samples: readonly CpuSample[], vcpus: number, maxPct: number, forMs: number): boolean {
  const last = samples.at(-1)
  if (last === undefined) return false
  let start = -1
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i]
    if (s !== undefined && s.atMs <= last.atMs - forMs) {
      start = i
      break
    }
  }
  if (start < 0) return false
  for (let i = start; i < samples.length - 1; i += 1) {
    const a = samples[i]
    const b = samples[i + 1]
    if (a === undefined || b === undefined) return false
    if (cpuPercent(a, b, vcpus) > maxPct) return false
  }
  return true
}

/** "60s", "10m", "500ms", "1h", or a bare number of seconds — in ms. Throws on anything else. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s.trim())
  if (m === null) throw new Error(`not a duration: "${s}" (e.g. 90s, 10m, 500ms)`)
  const n = Number(m[1])
  const unit = m[2] ?? "s"
  return Math.round(n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000))
}

/** "3%" or "3" — a percentage of the guest's vCPUs. Throws outside 0-100. */
export function parsePercent(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(s.trim())
  const n = m === null ? Number.NaN : Number(m[1])
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`not a percentage: "${s}" (e.g. 3%)`)
  return n
}

// ---------------------------------------------------------------------------
// Settling, measured from the host

const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

function sampleCpu(pid: number): CpuSample {
  return { atMs: Date.now(), cpuSec: parseCpuTime(capture("ps", ["-o", "time=", "-p", String(pid)])) }
}

export interface SettleOptions {
  /** Quiet means at or under this share of the guest's vCPUs, percent. Default 3. */
  readonly cpuPct?: number
  /** ...for this long. Default 60 s. */
  readonly forMs?: number
  /** Give up waiting after this long (the golden is still taken, marked unsettled). Default 10 min. */
  readonly maxWaitMs?: number
  /** Default 5 s. */
  readonly sampleMs?: number
}

export interface SettleResult {
  readonly settled: boolean
  readonly waitedMs: number
  /** CPU over the last sample interval, % of all vCPUs. */
  readonly lastPct: number
}

/** Wait until the instance's guest is quiet (see the top of this file). */
export async function waitSettled(
  p: Paths,
  o: SettleOptions = {},
  progress: (pct: number, waitedMs: number) => void = () => undefined,
): Promise<SettleResult> {
  const pid = qemu.pidOf(p)
  if (pid === null) throw new Error("the instance is not running")
  const vcpus = parseSmp(capture("ps", ["-o", "command=", "-p", String(pid)]))
  const cpuPct = o.cpuPct ?? 3
  const forMs = o.forMs ?? 60_000
  const maxWaitMs = o.maxWaitMs ?? 600_000
  const sampleMs = o.sampleMs ?? 5000
  const started = Date.now()
  const samples: CpuSample[] = [sampleCpu(pid)]
  let lastPct = Number.NaN
  for (;;) {
    await sleep(sampleMs)
    if (qemu.pidOf(p) !== pid) throw new Error("QEMU exited while waiting for the guest to settle")
    samples.push(sampleCpu(pid))
    const [a, b] = samples.slice(-2)
    if (a !== undefined && b !== undefined) lastPct = cpuPercent(a, b, vcpus)
    const waitedMs = Date.now() - started
    progress(lastPct, waitedMs)
    if (isSettled(samples, vcpus, cpuPct, forMs)) return { settled: true, waitedMs, lastPct }
    if (waitedMs >= maxWaitMs) return { settled: false, waitedMs, lastPct }
  }
}

// ---------------------------------------------------------------------------
// The API

export interface CreateGoldenOptions extends SettleOptions {
  /** Save name. Default "golden". */
  readonly name?: string
  /** Start from this save of the instance instead of the guest as it is (or a cold boot if stopped). */
  readonly from?: string
  /** Image for a cold boot of an instance that does not exist yet. Default "win11-arm64". */
  readonly image?: string
  /** One line per step / settle sample, for a CLI; silent by default. */
  readonly log?: (line: string) => void
}

export interface CreateGoldenResult {
  readonly manifest: saves.Manifest
  /** False when `maxWaitMs` ran out first; the golden was taken anyway. */
  readonly settled: boolean
  readonly settleWaitedMs: number
  readonly lastCpuPct: number
  /** Whole operation, boot/load included. */
  readonly ms: number
}

/**
 * Bring the instance up (as it is, from `from`, or by booting it), wait for the
 * guest to settle, set its clock, and save it as a mapped-ram golden. On return
 * the guest is running, clock synced. Stops the instance's idle watcher first:
 * a guest left idle on purpose is exactly what it would autosave or stow.
 */
export async function createGolden(instance: string, o: CreateGoldenOptions = {}): Promise<CreateGoldenResult> {
  const log = o.log ?? (() => undefined)
  const name = o.name ?? saves.GOLDEN
  const nameErr = saves.nameError(name)
  if (nameErr !== null) throw new Error(nameErr)
  if (name === saves.STOW) throw new Error(`"${saves.STOW}" is reserved for \`winvm stow\``)
  const started = Date.now()
  const p = pathsFor(instance)
  await watcher.stopWatcher(instance)

  if (o.from !== undefined) {
    const from = o.from
    log(`loading "${from}"`)
    await saves.withLock(instance, async () => await saves.loadSave(instance, from))
    if (!(await qga.waitResponsive(p.qga, 300_000))) throw new Error(`guest did not answer after loading "${from}"`)
  } else if (qemu.isRunning(p)) {
    log("checking the guest has finished starting")
    if (!(await qga.waitReady(p.qga, 600_000))) throw new Error("the guest is not ready (still booting or in OOBE)")
  } else {
    ensureInstance(instance, readMeta(instance)?.image ?? o.image ?? "win11-arm64")
    const meta = readMeta(instance)
    if (meta === null) throw new Error(`could not create instance "${instance}"`)
    log("booting")
    await qemu.launch(instance, p, meta, {
      installMedia: false,
      ephemeral: false,
      virtioBoot: readImageMeta(meta.image)?.virtioBoot === true,
    })
    if (!(await qga.waitReady(p.qga, 600_000))) throw new Error(`guest never became ready — see ${p.serial}`)
  }
  const meta = readMeta(instance)
  if (meta === null) throw new Error(`no such instance "${instance}"`)
  if (readImageMeta(meta.image)?.virtioBoot !== true) {
    throw new Error(`image "${meta.image}" predates virtio boot, so its disk is NVMe, which QEMU cannot save. Rebuild the image.`)
  }

  const cpuPct = o.cpuPct ?? 3
  const forMs = o.forMs ?? 60_000
  log(`waiting for the guest to settle (CPU <= ${String(cpuPct)}% for ${String(Math.round(forMs / 1000))} s)`)
  const settle = await waitSettled(p, o, (pct, waited) => {
    log(`  ${String(Math.round(waited / 1000)).padStart(4)} s  cpu ${pct.toFixed(1)}%`)
  })
  if (!settle.settled) log(`warning: still busy after ${String(Math.round(settle.waitedMs / 1000))} s; taking the golden anyway`)

  try {
    await alignGuestTimeZone(p)
  } catch {
    // Display only; the clock below is what matters.
  }
  await syncGuestClock(p)
  const note =
    `settled: ${settle.settled ? "yes" : "no"}, cpu ${settle.lastPct.toFixed(1)}% ` +
    `after ${String(Math.round(settle.waitedMs / 1000))} s`
  log("saving (mapped-ram)")
  const r = await saves.withLock(
    instance,
    async () => await saves.createSave(instance, { name, kind: "golden", format: "mapped", note }),
  )
  // It stood still while being saved.
  await syncGuestClock(p).catch(() => undefined)
  return {
    manifest: r.manifest,
    settled: settle.settled,
    settleWaitedMs: settle.waitedMs,
    lastCpuPct: settle.lastPct,
    ms: Date.now() - started,
  }
}

export interface ResetResult {
  /** The whole reset: from the call to a responsive guest with a correct clock. */
  readonly ms: number
  /** Old QEMU gone, disks cloned back, RAM loaded, vCPUs running. */
  readonly restoredMs: number
  /** Then until the agent ran a command (a nonce echo) for us. */
  readonly responsiveMs: number
  /** Then setting the guest's clock. */
  readonly clockMs: number
  /** How far behind the guest's clock was before it was set, ms. */
  readonly clockOffsetMs: number
  readonly manifest: saves.Manifest
}

/**
 * Put the instance back to a golden (any save, in fact; mapped ones are the
 * fast ones), running or not, and return once the guest runs commands with a
 * correct clock. Throws if the save cannot be loaded or the guest never answers.
 * Prints nothing, and starts no watcher.
 */
export async function resetToGolden(
  instance: string,
  name: string = saves.GOLDEN,
  o: { readonly timeoutMs?: number } = {},
): Promise<ResetResult> {
  const started = Date.now()
  const manifest = await saves.withLock(instance, async () => await saves.loadSave(instance, name))
  const restoredMs = Date.now() - started
  const p = pathsFor(instance)
  if (!(await qga.waitResponsive(p.qga, o.timeoutMs ?? 120_000))) {
    throw new Error(`guest did not answer after loading "${name}" — see ${p.serial}`)
  }
  const responsiveAt = Date.now()
  const c = await syncGuestClock(p)
  const done = Date.now()
  // A stow would bring back what this just discarded at the next `start`.
  if (saves.hasSave(instance, saves.STOW)) saves.removeSave(instance, saves.STOW)
  return {
    ms: done - started,
    restoredMs,
    responsiveMs: responsiveAt - started - restoredMs,
    clockMs: done - responsiveAt,
    clockOffsetMs: c.beforeOffsetMs,
    manifest,
  }
}

// ---------------------------------------------------------------------------
// CLI

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

export async function golden(args: Args): Promise<number> {
  const instance = instanceName(args)
  const sub = args.positional[0]
  const name = args.flags.get("name") ?? args.positional[1] ?? saves.GOLDEN
  try {
    if (sub === "create") {
      const f = (k: string): string | undefined => args.flags.get(k)
      const cpu = f("settle-cpu")
      const forS = f("settle-for")
      const max = f("max-wait")
      const from = f("from")
      const r = await createGolden(instance, {
        name,
        image: imageName(args),
        ...(from === undefined ? {} : { from }),
        ...(cpu === undefined ? {} : { cpuPct: parsePercent(cpu) }),
        ...(forS === undefined ? {} : { forMs: parseDuration(forS) }),
        ...(max === undefined ? {} : { maxWaitMs: parseDuration(max) }),
        log: (l) => console.log(l),
      })
      const m = r.manifest
      console.log(
        `golden "${m.name}" of "${instance}": ${r.settled ? "settled" : "NOT settled"} after ${secs(r.settleWaitedMs)} ` +
          `(cpu ${r.lastCpuPct.toFixed(1)}%), saved in ${secs(m.saveMs ?? 0)}, ` +
          `RAM ${saves.formatBytes(m.ramBytes ?? 0)} on disk, ${saves.formatBytes(m.bytes)} total; ${secs(r.ms)} in all`,
      )
      return 0
    }
    if (sub === "reset") {
      const r = await resetToGolden(instance, name)
      console.log(
        `reset "${instance}" to "${r.manifest.name}" (${saves.ramFormatOf(r.manifest)}) in ${secs(r.ms)}: ` +
          `restored ${String(r.restoredMs)} ms, responsive +${String(r.responsiveMs)} ms, ` +
          `clock +${String(r.clockMs)} ms (was ${formatOffset(r.clockOffsetMs)})`,
      )
      return 0
    }
  } catch (error) {
    return fail(errMsg(error))
  }
  return fail(
    "usage: winvm golden create [-i name] [--name golden] [--from <save>] [--settle-cpu 3%] [--settle-for 60s] [--max-wait 10m]\n" +
      "       winvm golden reset  [-i name] [--name golden]",
  )
}
