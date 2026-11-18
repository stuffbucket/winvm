import type { Args } from "./args"
import { imageName, instanceName } from "./args"
import { alignGuestTimeZone, formatOffset, syncGuestClock } from "./clock"
import { ensureInstance } from "./instance"
import { withOperation } from "./operation"
import type { Paths } from "./paths"
import { pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import { nameError } from "./savename"
import * as saves from "./saves"
import { capture } from "./shell"
import * as watcher from "./watch"

export interface CpuSample {
  readonly atMs: number
  readonly cpuSec: number
}

export function parseCpuTime(s: string): number {
  const t = s.trim()
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t)
  if (m === null) return Number.NaN
  const [, d, h, min, sec] = m
  return (
    Number(d ?? 0) * 86_400 +
    Number(h ?? 0) * 3600 +
    Number(min) * 60 +
    Number(sec)
  )
}

export function parseSmp(cmdline: string): number {
  const m = /(?:^|\s)-smp\s+(?:cpus=)?(\d+)/.exec(cmdline)
  return m?.[1] === undefined ? 1 : Number(m[1])
}

export function cpuPercent(a: CpuSample, b: CpuSample, vcpus: number): number {
  const wall = (b.atMs - a.atMs) / 1000
  if (wall <= 0) return 0
  return ((b.cpuSec - a.cpuSec) / wall / Math.max(1, vcpus)) * 100
}

export function isSettled(
  samples: readonly CpuSample[],
  vcpus: number,
  maxPct: number,
  forMs: number,
): boolean {
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

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s.trim())
  if (m === null)
    throw new Error(`not a duration: "${s}" (e.g. 90s, 10m, 500ms)`)
  const n = Number(m[1])
  const unit = m[2] ?? "s"
  return Math.round(
    n *
      (unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60_000
            : 3_600_000),
  )
}

export function parsePercent(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(s.trim())
  const n = m === null ? Number.NaN : Number(m[1])
  if (!Number.isFinite(n) || n < 0 || n > 100)
    throw new Error(`not a percentage: "${s}" (e.g. 3%)`)
  return n
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

function sampleCpu(pid: number): CpuSample {
  return {
    atMs: Date.now(),
    cpuSec: parseCpuTime(capture("ps", ["-o", "time=", "-p", String(pid)])),
  }
}

export interface SettleOptions {
  readonly cpuPct?: number
  readonly forMs?: number
  readonly maxWaitMs?: number
  readonly sampleMs?: number
}

export interface SettleResult {
  readonly settled: boolean
  readonly waitedMs: number
  readonly lastPct: number
}

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
    if (qemu.pidOf(p) !== pid)
      throw new Error("QEMU exited while waiting for the guest to settle")
    samples.push(sampleCpu(pid))
    const [a, b] = samples.slice(-2)
    if (a !== undefined && b !== undefined) lastPct = cpuPercent(a, b, vcpus)
    const waitedMs = Date.now() - started
    progress(lastPct, waitedMs)
    if (isSettled(samples, vcpus, cpuPct, forMs))
      return { settled: true, waitedMs, lastPct }
    if (waitedMs >= maxWaitMs) return { settled: false, waitedMs, lastPct }
  }
}

export interface CreateGoldenOptions extends SettleOptions {
  readonly name?: string
  readonly from?: string
  readonly image?: string
  readonly log?: (line: string) => void
}

export interface CreateGoldenResult {
  readonly manifest: saves.Manifest
  readonly settled: boolean
  readonly settleWaitedMs: number
  readonly lastCpuPct: number
  readonly ms: number
}

export const createGolden = async (
  instance: string,
  o: CreateGoldenOptions = {},
): Promise<CreateGoldenResult> =>
  await withOperation(
    instance,
    "golden-create",
    async () => await createGoldenHeld(instance, o),
  )

async function createGoldenHeld(
  instance: string,
  o: CreateGoldenOptions,
): Promise<CreateGoldenResult> {
  const log = o.log ?? (() => undefined)
  const name = o.name ?? saves.GOLDEN
  const nameErr = nameError(name)
  if (nameErr !== null) throw new Error(nameErr)
  if (name === saves.STOW)
    throw new Error(`"${saves.STOW}" is reserved for \`winvm stow\``)
  const started = Date.now()
  const p = pathsFor(instance)
  await watcher.stopWatcher(instance)

  if (o.from !== undefined) {
    const from = o.from
    log(`loading "${from}"`)
    saves.retireLoaded(instance, from, await saves.loadSave(instance, from))
    if (!(await qga.waitResponsive(p.qga, 300_000)))
      throw new Error(`guest did not answer after loading "${from}"`)
  } else if (qemu.isRunning(p)) {
    log("checking the guest has finished starting")
    if (!(await qga.waitReady(p.qga, 600_000)))
      throw new Error("the guest is not ready (still booting or in OOBE)")
  } else {
    ensureInstance(
      instance,
      readMeta(instance)?.image ?? o.image ?? "win11-arm64",
    )
    const meta = readMeta(instance)
    if (meta === null)
      throw new Error(`could not create instance "${instance}"`)
    log("booting")
    await qemu.launch(instance, p, meta, {
      installMedia: false,
      ephemeral: false,
      virtioBoot: readImageMeta(meta.image)?.virtioBoot === true,
    })
    if (!(await qga.waitReady(p.qga, 600_000)))
      throw new Error(`guest never became ready — see ${p.serial}`)
  }
  const meta = readMeta(instance)
  if (meta === null) throw new Error(`no such instance "${instance}"`)
  if (readImageMeta(meta.image)?.virtioBoot !== true) {
    throw new Error(
      `image "${meta.image}" predates virtio boot, so its disk is NVMe, which QEMU cannot save. Rebuild the image.`,
    )
  }

  const cpuPct = o.cpuPct ?? 3
  const forMs = o.forMs ?? 60_000
  log(
    `waiting for the guest to settle (CPU <= ${String(cpuPct)}% for ${String(Math.round(forMs / 1000))} s)`,
  )
  const settle = await waitSettled(p, o, (pct, waited) => {
    log(
      `  ${String(Math.round(waited / 1000)).padStart(4)} s  cpu ${pct.toFixed(1)}%`,
    )
  })
  if (!settle.settled)
    log(
      `warning: still busy after ${String(Math.round(settle.waitedMs / 1000))} s; taking the golden anyway`,
    )

  try {
    await alignGuestTimeZone(p)
  } catch {}
  await syncGuestClock(p)
  const note =
    `settled: ${settle.settled ? "yes" : "no"}, cpu ${settle.lastPct.toFixed(1)}% ` +
    `after ${String(Math.round(settle.waitedMs / 1000))} s`
  log("saving (mapped-ram)")
  const r = await saves.createSave(instance, {
    name,
    kind: "golden",
    format: "mapped",
    note,
  })
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
  readonly ms: number
  readonly restoredMs: number
  readonly responsiveMs: number
  readonly clockMs: number
  readonly clockOffsetMs: number
  readonly manifest: saves.Manifest
}

export async function resetToGolden(
  instance: string,
  name: string = saves.GOLDEN,
  o: { readonly timeoutMs?: number } = {},
): Promise<ResetResult> {
  const started = Date.now()
  const manifest = await saves.loadSave(instance, name)
  saves.retireLoaded(instance, name, manifest)
  const restoredMs = Date.now() - started
  const p = pathsFor(instance)
  if (!(await qga.waitResponsive(p.qga, o.timeoutMs ?? 120_000))) {
    throw new Error(
      `guest did not answer after loading "${name}" — see ${p.serial}`,
    )
  }
  const responsiveAt = Date.now()
  const c = await syncGuestClock(p)
  const done = Date.now()
  return {
    ms: done - started,
    restoredMs,
    responsiveMs: responsiveAt - started - restoredMs,
    clockMs: done - responsiveAt,
    clockOffsetMs: c.beforeOffsetMs,
    manifest,
  }
}

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}
const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)
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
        log: (l) => {
          console.log(l)
        },
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
