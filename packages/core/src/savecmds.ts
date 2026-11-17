import { readFileSync } from "node:fs"
import * as agent from "./agent"
import type { Args } from "./args"
import { instanceName } from "./args"
import {
  alignGuestTimeZone,
  formatOffset,
  measureOffset,
  syncGuestClock,
} from "./clock"
import * as finder from "./finder"
import * as frozen from "./frozen"
import { lockWindows } from "./lock"
import * as notes from "./notes"
import { AUTOMATIC_ENV } from "./operation"
import type { InstanceMeta, Paths } from "./paths"
import { pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as qmp from "./qmp"
import { currentQemuCompat } from "./runtime"
import { nameError } from "./savename"
import * as saves from "./saves"
import * as snapshot from "./snapshot"
import * as watcher from "./watch"

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

const RESPONSIVE_MS = 300_000

async function settle(p: Paths, label: string): Promise<boolean> {
  if (!(await qga.waitResponsive(p.qga, RESPONSIVE_MS))) {
    console.error(
      `::error::guest did not answer after ${label} — see ${p.serial}`,
    )
    return false
  }
  try {
    const c = await syncGuestClock(p)
    console.log(
      `  clock: guest was ${formatOffset(c.beforeOffsetMs)} from the host, now ${formatOffset(c.afterOffsetMs)}`,
    )
  } catch (error) {
    console.warn(
      `warning: could not set the guest clock (${msg(error)}) — try \`winvm clock\``,
    )
  }
  return true
}

function requireSaveable(
  name: string,
): { p: Paths; meta: InstanceMeta } | string {
  const p = pathsFor(name)
  const meta = readMeta(name)
  if (meta === null) return `no such instance "${name}"`
  if (!qemu.isRunning(p))
    return `instance "${name}" is not running — a save captures a live guest`
  if (readImageMeta(meta.image)?.virtioBoot !== true) {
    return `image "${meta.image}" predates virtio boot, so its disk is NVMe, which QEMU cannot save. Rebuild the image.`
  }
  return { p, meta }
}

async function doSave(
  name: string,
  o: saves.CreateOptions & { readonly checkReady: boolean },
): Promise<number> {
  const s = requireSaveable(name)
  if (typeof s === "string") return fail(s)
  const { p } = s
  const state = await qmp.status(p.qmp)
  if (o.checkReady && state === "running") {
    process.stdout.write("checking the guest has finished starting… ")
    const ready = await qga.waitReady(p.qga, RESPONSIVE_MS)
    process.stdout.write("\n")
    if (!ready)
      return fail(
        `guest "${name}" is not ready — saving one that is still booting wedges it (--force to override)`,
      )
  }
  let r: saves.CreateResult
  try {
    r = await saves.createSave(name, o)
  } catch (error) {
    fail(msg(error))
    return error instanceof saves.StowNotRecallable ? saves.STOW_REFUSED : 1
  }
  const m = r.manifest
  console.log(
    `saved "${m.name}" (${m.kind}, ${saves.ramFormatOf(m)}) in ${secs(m.saveMs ?? 0)}: ` +
      `RAM ${saves.formatBytes(r.rawRamBytes)} -> ${saves.formatBytes(m.ramBytes ?? 0)} on disk, ` +
      `${saves.formatBytes(m.bytes)} total (disks are clones)`,
  )
  if (r.resumed) await settle(p, "the save")
  return 0
}

export function formatFlag(
  args: Args,
): { readonly format: saves.RamFormat } | { readonly error: string } {
  const f =
    args.flags.get("format") ?? (args.flags.has("fast") ? "mapped" : "zstd")
  const format = saves.RAM_FORMATS.find((known) => known === f)
  if (format === undefined)
    return {
      error: `--format must be one of ${saves.RAM_FORMATS.join(", ")}, got "${f}"`,
    }
  return { format }
}

export async function save(args: Args): Promise<number> {
  const name = instanceName(args)
  const saveName = args.positional[0] ?? saves.defaultName(new Date())
  const err = nameError(saveName)
  if (err !== null) return fail(err)
  if (saveName === saves.STOW)
    return fail(`"${saves.STOW}" is reserved for \`winvm stow\``)
  const parsed = formatFlag(args)
  if ("error" in parsed) return fail(parsed.error)
  const note = args.flags.get("note")
  return await doSave(name, {
    name: saveName,
    kind: saveName === saves.BASELINE ? "baseline" : "manual",
    format: parsed.format,
    ...(note === undefined ? {} : { note }),
    checkReady: !args.flags.has("force"),
  })
}

async function doLoad(
  name: string,
  saveName: string,
  verb: string,
): Promise<number> {
  const p = pathsFor(name)
  const wasRunning = qemu.isRunning(p)
  const started = Date.now()
  finder.beforeDown(name)
  let m: saves.Manifest
  try {
    m = await saves.loadSave(name, saveName)
  } catch (error) {
    return fail(msg(error))
  }
  const restoredMs = Date.now() - started
  if (!(await settle(p, verb))) return 1
  if (m.kind === "stow") saves.removeSave(name, m.name)
  else if (saves.hasSave(name, saves.STOW)) {
    saves.removeSave(name, saves.STOW)
    console.log(`  (discarded the stow save; "${m.name}" supersedes it)`)
  }
  console.log(
    `${verb} "${name}" from "${m.name}" (${m.kind}, taken ${new Date(m.createdAt).toLocaleString()}) ` +
      `in ${secs(Date.now() - started)} — ${wasRunning ? "was running" : "was stopped"}; state restored in ${secs(restoredMs)}`,
  )
  await finder.afterUp(name)
  return 0
}

export async function load(args: Args): Promise<number> {
  const name = instanceName(args)
  let saveName = args.positional[0]
  if (saveName === undefined) {
    const newest = saves
      .listSaves(name)
      .filter((s) => s.manifest !== null)
      .at(-1)
    if (newest === undefined) return fail(`instance "${name}" has no saves`)
    saveName = newest.name
  }
  watcher.touchActivity(name)
  const rewatch = watcher.rewatchAfterRestore(name, args)
  const code = await doLoad(name, saveName, "loaded")
  if (code === 0) {
    watcher.touchActivity(name)
    rewatch()
  }
  return code
}

export function list(args: Args): number {
  const name = instanceName(args)
  if (args.positional[0] === "rm") {
    const target = args.positional[1]
    if (target === undefined) return fail("usage: winvm saves rm <name>")
    if (!saves.hasSave(name, target))
      return fail(`instance "${name}" has no save "${target}"`)
    let hadNote = false
    try {
      hadNote = notes.readNote(name, target) !== null
    } catch {
      hadNote = false
    }
    saves.removeSave(name, target)
    console.log(`deleted save "${target}"${hadNote ? " and its note" : ""}`)
    return 0
  }
  if (args.positional[0] === "note") return note(args)
  const rows = saves.listSaves(name)
  const report = saves.savesReport(
    rows,
    rows.length > 0 ? saves.reportContext(name) : { compat: null },
  )
  if (args.flags.has("json")) {
    console.log(JSON.stringify(report, null, 2))
    return 0
  }
  if (rows.length === 0) {
    console.log(`instance "${name}" has no saves (${saves.savesDir(name)})`)
    return 0
  }
  console.log(
    `  ${"NAME".padEnd(22)} ${"KIND".padEnd(9)} ${"FORMAT".padEnd(7)} ${"CREATED".padEnd(19)} ${"SIZE".padStart(8)}  COMPATIBLE`,
  )
  for (const r of rows) {
    const m = r.manifest
    if (m === null) {
      console.log(`  ${r.name.padEnd(22)} (unreadable: ${r.error ?? "?"})`)
      continue
    }
    const d = new Date(m.createdAt)
    const created = `${saves.defaultName(d).slice(0, 10)} ${saves.defaultName(d).slice(11).replaceAll("-", ":")}`
    const entry = report.find((e) => e.name === m.name)
    const ok =
      entry?.compatible == null
        ? "?"
        : entry.compatible
          ? "yes"
          : entry.why === undefined
            ? "no"
            : "no (before the shared folder)"
    console.log(
      `  ${m.name.padEnd(22)} ${m.kind.padEnd(9)} ${saves.ramFormatOf(m).padEnd(7)} ${created.padEnd(19)} ${saves.formatBytes(m.bytes).padStart(8)}  ${ok}` +
        (m.note === undefined ? "" : `  ${m.note}`),
    )
  }
  console.log(`\n  ${saves.savesDir(name)}`)
  return 0
}

const NOTE_USAGE =
  "usage: winvm saves note [-i name] <save> [--title T] [--text TEXT|-] [--tags a,b,c] [--clear] [--json]"

const readStdin = (): string => readFileSync(0, "utf8")

export function note(args: Args, stdin: () => string = readStdin): number {
  const name = instanceName(args)
  const target = args.positional[1]
  if (target === undefined) return fail(NOTE_USAGE)
  const err = nameError(target)
  if (err !== null) return fail(err)
  if (!saves.hasSave(name, target))
    return fail(`instance "${name}" has no save "${target}"`)
  const json = args.flags.has("json")
  const title = args.flags.get("title")
  let text = args.flags.get("text")
  const tags = args.flags.get("tags")
  const clear = args.flags.has("clear")
  try {
    if (
      title === undefined &&
      text === undefined &&
      tags === undefined &&
      !clear
    ) {
      const n = notes.readNote(name, target)
      if (json) console.log(JSON.stringify(n, null, 2))
      else if (n === null) console.log(`save "${target}" has no note`)
      else printNote(n)
      return 0
    }
    if (text === "-") text = stdin().replace(/\s+$/, "")
    const had = notes.readNote(name, target) !== null
    if (clear) notes.removeNote(name, target)
    const patch: notes.NotePatch = {
      ...(title === undefined ? {} : { title }),
      ...(text === undefined ? {} : { text }),
      ...(tags === undefined ? {} : { tags: tags.split(",") }),
    }
    const written =
      Object.keys(patch).length === 0
        ? null
        : notes.writeNote(name, target, patch)
    const result =
      written === null || notes.isEmptyNote(written) ? null : written
    if (json) console.log(JSON.stringify(result, null, 2))
    else if (result !== null)
      console.log(`updated the note on save "${target}"`)
    else
      console.log(
        had
          ? `deleted the note on save "${target}"`
          : `save "${target}" has no note`,
      )
    return 0
  } catch (error) {
    return fail(msg(error))
  }
}

function printNote(n: notes.Note): void {
  console.log(`title: ${n.title ?? "(none)"}`)
  if (n.tags.length > 0) console.log(`tags:  ${n.tags.join(", ")}`)
  console.log(`updated ${new Date(n.updatedAt).toLocaleString()}`)
  if (n.text !== "") console.log(`\n${n.text}`)
}

export async function pause(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) return fail(`instance "${name}" is not running`)
  finder.beforeDown(name)
  await qmp.execute(p.qmp, "stop")
  frozen.clearAsleep(p)
  console.log(`paused "${name}" — \`winvm resume -i ${name}\` to continue`)
  return 0
}

export async function resume(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) return fail(`instance "${name}" is not running`)
  const state = await qmp.status(p.qmp)
  const was = frozen.markedAsleep(p, qemu.pidOf(p)) ? "asleep" : "paused"
  if (state !== "running") await qmp.execute(p.qmp, "cont")
  else console.log(`"${name}" was not ${was}`)
  frozen.clearAsleep(p)
  if (!(await settle(p, was === "asleep" ? "waking" : "resuming"))) return 1
  if (state !== "running")
    console.log(
      was === "asleep"
        ? `woke "${name}" — Windows is at its lock screen`
        : `resumed "${name}"`,
    )
  await finder.afterUp(name)
  return 0
}

async function lockGuest(name: string): Promise<boolean> {
  try {
    const c = await agent.ensure(name)
    const r = await lockWindows(c)
    if (r.enabled !== null)
      console.log(
        `  enabled the Windows account "${r.enabled}" so it can sign back in from the lock screen`,
      )
    if (!r.confirmed)
      console.warn(
        "warning: the lock screen did not appear in time; locked anyway",
      )
    return true
  } catch (error) {
    console.error(`::error::could not lock Windows in "${name}": ${msg(error)}`)
    return false
  }
}

export async function lock(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) return fail(`instance "${name}" is not running`)
  if (!(await lockGuest(name))) return 1
  console.log(`locked "${name}"`)
  return 0
}

export async function sleep(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  const pid = qemu.pidOf(p)
  if (pid === null) return fail(`instance "${name}" is not running`)
  const already = await frozen.frozenState(p)
  if (already !== null) return fail(`instance "${name}" is already ${already}`)
  if (!(await lockGuest(name))) return 1
  finder.beforeDown(name)
  await qmp.execute(p.qmp, "stop")
  frozen.markAsleep(p, pid)
  console.log(`"${name}" is asleep — \`winvm wake -i ${name}\` wakes it`)
  return 0
}

export async function stow(args: Args): Promise<number> {
  const name = instanceName(args)
  if (process.env[AUTOMATIC_ENV] !== "1") await watcher.stopWatcher(name)
  finder.beforeDown(name)
  const started = Date.now()
  const code = await doSave(name, {
    name: saves.STOW,
    kind: "stow",
    quitAfter: true,
    checkReady: !args.flags.has("force"),
  })
  if (code !== 0) {
    await finder.afterUp(name)
    return code
  }
  console.log(
    `stowed "${name}" in ${secs(Date.now() - started)} — QEMU is stopped; \`winvm start -i ${name}\` recalls it`,
  )
  return 0
}

export async function clock(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) return fail(`instance "${name}" is not running`)
  if ((await qmp.status(p.qmp)) !== "running")
    return fail(
      `instance "${name}" is paused — \`winvm resume\` fixes the clock too`,
    )
  if (args.flags.has("check")) {
    const o = await measureOffset(p)
    console.log(
      `guest clock is ${formatOffset(o.offsetMs)} from the host (±${String(Math.ceil(o.rttMs / 2))} ms)`,
    )
    return 0
  }
  await alignZone(p)
  const c = await syncGuestClock(p)
  console.log(
    `guest clock was ${formatOffset(c.beforeOffsetMs)} from the host; now ${formatOffset(c.afterOffsetMs)}`,
  )
  return 0
}

async function alignZone(p: Paths): Promise<void> {
  try {
    const z = await alignGuestTimeZone(p)
    if (z === null)
      console.warn(
        "warning: could not map the host's time zone to a Windows one; guest zone left as is",
      )
    else if (z.changed)
      console.log(
        `  time zone: ${z.from === "" ? "?" : z.from} -> ${z.to} (RTC read as UTC)`,
      )
  } catch (error) {
    console.warn(`warning: could not set the guest time zone (${msg(error)})`)
  }
}

export async function recallStow(
  name: string,
  args: Args,
): Promise<number | null> {
  if (!saves.hasSave(name, saves.STOW) || args.flags.has("ephemeral"))
    return null
  if (args.flags.has("boot")) {
    saves.removeSave(name, saves.STOW)
    console.log("discarded the stow save (--boot)")
    return null
  }
  const meta = readMeta(name)
  if (meta !== null) {
    const m = saves.readSave(name, saves.STOW)
    const by = m?.compatParts?.qemu
    const installed = currentQemuCompat()
    if (
      by !== undefined &&
      saves.isUnknownRuntime(by) &&
      !saves.recallable(by, installed)
    ) {
      console.error(
        `::error::the stow of "${name}" was written by ${by === saves.UNKNOWN_RUNTIME ? "a QEMU" : `QEMU ${saves.versionOfRuntime(by)}`} from a winvm runtime this winvm can't identify, ` +
          `and this winvm runs QEMU ${saves.versionOfRuntime(installed)}; recalling it could fail or give Windows different hardware, so it was not recalled. ` +
          `\`winvm start -i ${name} --boot\` discards the stow and starts Windows afresh from its disk`,
      )
      return 1
    }
    if (m !== null && m.compat !== saves.compatFor(name, meta, m).hash) {
      const devices = saves.takenBeforeDevices(
        m,
        saves.hardwareBeforeDevices(name, meta),
      )
      console.warn(
        devices
          ? `warning: the stow save was taken before winvm added the shared folder and clipboard devices and cannot be recalled; ` +
              `booting instead, so Windows starts afresh from its disk (the stow is kept — \`winvm saves -i ${name}\`)`
          : `warning: the stow save no longer matches this VM's hardware; booting instead (it is kept — \`winvm saves -i ${name}\`)`,
      )
      return null
    }
  }
  const code = await doLoad(name, saves.STOW, "recalled")
  if (code !== 0 && saves.hasSave(name, saves.STOW))
    console.error(
      `  the stow is kept; \`winvm start -i ${name} --boot\` discards it and starts Windows afresh from its disk`,
    )
  return code
}

export const markPristine = saves.markPristine

export async function afterBoot(name: string, args: Args): Promise<void> {
  const p = pathsFor(name)
  await alignZone(p)
  try {
    const c = await syncGuestClock(p)
    console.log(
      `  clock: guest was ${formatOffset(c.beforeOffsetMs)} from the host, now ${formatOffset(c.afterOffsetMs)}`,
    )
  } catch (error) {
    console.warn(`warning: could not set the guest clock (${msg(error)})`)
  }
  if (!saves.isPristine(name) || args.flags.has("ephemeral")) return
  if (args.flags.has("no-autosave")) {
    saves.clearPristine(name)
    return
  }
  const meta = readMeta(name)
  if (meta === null || readImageMeta(meta.image)?.virtioBoot !== true) {
    saves.clearPristine(name)
    return
  }
  const existing = saves.readSave(name, saves.BASELINE)
  if (
    existing !== null &&
    existing.compat === saves.compatFor(name, meta, existing).hash
  ) {
    saves.clearPristine(name)
    return
  }
  console.log("taking the automatic baseline save (--no-autosave skips this)")
  const code = await doSave(name, {
    name: saves.BASELINE,
    kind: "baseline",
    checkReady: false,
  })
  if (code === 0) saves.clearPristine(name)
}

export async function rewindViaSave(
  name: string,
  tag: string | undefined,
): Promise<number | null> {
  const p = pathsFor(name)
  const snapTag = tag ?? snapshot.DEFAULT_TAG
  let hasSnap: boolean
  try {
    hasSnap = (
      qemu.isRunning(p) ? await snapshot.listLive(p) : snapshot.list(p)
    ).some((s) => s.tag === snapTag)
  } catch {
    hasSnap = false
  }
  if (hasSnap) return null
  const saveName = tag ?? saves.BASELINE
  if (!saves.hasSave(name, saveName)) return null
  return await doLoad(name, saveName, "rewound")
}

export async function afterRewind(name: string): Promise<void> {
  const p = pathsFor(name)
  try {
    const c = await syncGuestClock(p)
    console.log(
      `  clock: guest was ${formatOffset(c.beforeOffsetMs)} from the host, now ${formatOffset(c.afterOffsetMs)}`,
    )
  } catch (error) {
    console.warn(`warning: could not set the guest clock (${msg(error)})`)
  }
  if (saves.hasSave(name, saves.STOW)) saves.removeSave(name, saves.STOW)
}

export function afterReset(name: string): void {
  if (saves.hasSave(name, saves.STOW)) saves.removeSave(name, saves.STOW)
  saves.markPristine(name)
}
