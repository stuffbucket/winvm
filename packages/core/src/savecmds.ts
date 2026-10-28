/**
 * The save verbs: save, load, saves, pause, resume, stow, clock — plus the
 * hooks `start` and `rewind` call. The mechanics live in saves.ts and clock.ts;
 * this file decides when they run and what is printed.
 *
 *   save [name]        RAM + disk + NVRAM to files (default name: a timestamp);
 *                      --fast (= --format mapped) for a save loaded over and over
 *   load [name]        back to a save, running or stopped (default: the newest);
 *                      the save's manifest says which RAM format to read
 *   saves [rm <name>]  list them, with compatibility; or delete one (and its note)
 *   saves note <name>  a person's note on a save — title, text, tags (notes.ts);
 *                      shown with none of --title/--text/--tags/--clear, else written
 *   pause / resume     freeze / unfreeze the vCPUs (resume fixes the clock)
 *   stow               save as "stow" and shut QEMU down; `start` recalls it
 *   clock [--check]    guest-vs-host clock offset, and fix it
 *
 * HOW `rewind` RELATES. `rewind [tag]` keeps meaning "go back to your
 * checkpoint, no reboot". An internal snapshot of that tag wins when one exists
 * (default tag "fresh", the old behaviour, untouched); otherwise it loads the
 * save of that name, and with no tag the automatic "baseline". So on a new
 * instance, where no one has taken "fresh", `rewind` goes back to the baseline
 * taken at its first boot — the state you most often want back.
 */
import { readFileSync } from "node:fs"

import type { Args } from "./args"
import { instanceName } from "./args"
import { alignGuestTimeZone, formatOffset, measureOffset, syncGuestClock } from "./clock"
import * as notes from "./notes"
import type { InstanceMeta, Paths } from "./paths"
import { pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as qmp from "./qmp"
import * as saves from "./saves"
import * as snapshot from "./snapshot"
import * as watcher from "./watch"

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** Generous: the host this runs on may be heavily loaded. */
const RESPONSIVE_MS = 300_000

/**
 * Wait for the agent, then put the guest's clock right. Never fatal: a guest
 * that answers late still loaded fine, and the clock can be fixed with
 * `winvm clock`.
 */
async function settle(p: Paths, label: string): Promise<boolean> {
  if (!(await qga.waitResponsive(p.qga, RESPONSIVE_MS))) {
    console.error(`::error::guest did not answer after ${label} — see ${p.serial}`)
    return false
  }
  try {
    const c = await syncGuestClock(p)
    console.log(`  clock: guest was ${formatOffset(c.beforeOffsetMs)} from the host, now ${formatOffset(c.afterOffsetMs)}`)
  } catch (error) {
    console.warn(`warning: could not set the guest clock (${msg(error)}) — try \`winvm clock\``)
  }
  return true
}

function requireSaveable(name: string): { p: Paths; meta: InstanceMeta } | string {
  const p = pathsFor(name)
  const meta = readMeta(name)
  if (meta === null) return `no such instance "${name}"`
  if (!qemu.isRunning(p)) return `instance "${name}" is not running — a save captures a live guest`
  if (readImageMeta(meta.image)?.virtioBoot !== true) {
    return `image "${meta.image}" predates virtio boot, so its disk is NVMe, which QEMU cannot save. Rebuild the image.`
  }
  return { p, meta }
}

/**
 * Save, then resume and fix the clock. Shared by `save`, the automatic
 * baseline and `stow`. `ready` is skipped for a guest that is already paused —
 * it cannot answer, and it was ready when it was paused or it would not be here.
 */
async function doSave(
  name: string,
  o: saves.CreateOptions & { readonly checkReady: boolean },
): Promise<number> {
  const s = requireSaveable(name)
  if (typeof s === "string") return fail(s)
  const { p } = s
  const state = await qmp.status(p.qmp)
  // REFUSE TO FREEZE A GUEST THAT IS STILL STARTING: restoring a Windows
  // caught mid-boot or mid-OOBE livelocks it (see qga.waitReady).
  if (o.checkReady && state === "running") {
    process.stdout.write("checking the guest has finished starting… ")
    const ready = await qga.waitReady(p.qga, RESPONSIVE_MS)
    process.stdout.write("\n")
    if (!ready) return fail(`guest "${name}" is not ready — saving one that is still booting wedges it (--force to override)`)
  }
  let r: saves.CreateResult
  try {
    r = await saves.withLock(name, async () => await saves.createSave(name, o))
  } catch (error) {
    return fail(msg(error))
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

/** `--fast` is `--format mapped`; otherwise `--format zstd|mapped|raw`, default zstd. */
export function formatFlag(args: Args): saves.RamFormat | string {
  const f = args.flags.get("format") ?? (args.flags.has("fast") ? "mapped" : "zstd")
  if (!(saves.RAM_FORMATS as readonly string[]).includes(f)) {
    return `--format must be one of ${saves.RAM_FORMATS.join(", ")}, got "${f}"`
  }
  return f as saves.RamFormat
}

export async function save(args: Args): Promise<number> {
  const name = instanceName(args)
  const saveName = args.positional[0] ?? saves.defaultName(new Date())
  const err = saves.nameError(saveName)
  if (err !== null) return fail(err)
  if (saveName === saves.STOW) return fail(`"${saves.STOW}" is reserved for \`winvm stow\``)
  const format = formatFlag(args)
  if (!(saves.RAM_FORMATS as readonly string[]).includes(format)) return fail(format)
  const note = args.flags.get("note")
  return await doSave(name, {
    name: saveName,
    kind: saveName === saves.BASELINE ? "baseline" : "manual",
    format: format as saves.RamFormat,
    ...(note === undefined ? {} : { note }),
    checkReady: !args.flags.has("force"),
  })
}

/** Load `saveName` into instance `name`, wait for it, fix the clock. Shared with rewind and start. */
async function doLoad(name: string, saveName: string, verb: string): Promise<number> {
  const p = pathsFor(name)
  const wasRunning = qemu.isRunning(p)
  const started = Date.now()
  let m: saves.Manifest
  try {
    m = await saves.withLock(name, async () => await saves.loadSave(name, saveName))
  } catch (error) {
    return fail(msg(error))
  }
  const restoredMs = Date.now() - started
  if (!(await settle(p, verb))) return 1
  // A stow is a one-shot: once recalled it is spent. Loading anything else
  // supersedes it — otherwise the next `start` would silently replace what
  // was just loaded with an older stow.
  if (m.kind === "stow") saves.removeSave(name, m.name)
  else if (saves.hasSave(name, saves.STOW)) {
    saves.removeSave(name, saves.STOW)
    console.log(`  (discarded the stow save; "${m.name}" supersedes it)`)
  }
  console.log(
    `${verb} "${name}" from "${m.name}" (${m.kind}, taken ${new Date(m.createdAt).toLocaleString()}) ` +
      `in ${secs(Date.now() - started)} — ${wasRunning ? "was running" : "was stopped"}; state restored in ${secs(restoredMs)}`,
  )
  return 0
}

export async function load(args: Args): Promise<number> {
  const name = instanceName(args)
  let saveName = args.positional[0]
  if (saveName === undefined) {
    const newest = saves.listSaves(name).filter((s) => s.manifest !== null).at(-1)
    if (newest === undefined) return fail(`instance "${name}" has no saves`)
    saveName = newest.name
  }
  // A load is someone using the guest: the watcher's idle clock restarts. (A
  // save is not — the watcher's own autosaves go through the same code.)
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
    if (!saves.hasSave(name, target)) return fail(`instance "${name}" has no save "${target}"`)
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
  if (args.flags.has("json")) {
    const ctx = rows.length > 0 ? saves.reportContext(name) : { compat: null }
    console.log(JSON.stringify(saves.savesReport(rows, ctx), null, 2))
    return 0
  }
  const meta = readMeta(name)
  let compat: string | null = null
  try {
    if (meta !== null && rows.length > 0) compat = saves.currentCompat(name, meta).hash
  } catch {
    compat = null
  }
  if (rows.length === 0) {
    console.log(`instance "${name}" has no saves (${saves.savesDir(name)})`)
    return 0
  }
  console.log(`  ${"NAME".padEnd(22)} ${"KIND".padEnd(9)} ${"FORMAT".padEnd(7)} ${"CREATED".padEnd(19)} ${"SIZE".padStart(8)}  COMPATIBLE`)
  for (const r of rows) {
    const m = r.manifest
    if (m === null) {
      console.log(`  ${r.name.padEnd(22)} (unreadable: ${r.error ?? "?"})`)
      continue
    }
    const d = new Date(m.createdAt)
    const created = `${saves.defaultName(d).slice(0, 10)} ${saves.defaultName(d).slice(11).replaceAll("-", ":")}`
    const ok = compat === null ? "?" : m.compat === compat ? "yes" : "no"
    console.log(
      `  ${m.name.padEnd(22)} ${m.kind.padEnd(9)} ${saves.ramFormatOf(m).padEnd(7)} ${created.padEnd(19)} ${saves.formatBytes(m.bytes).padStart(8)}  ${ok}` +
        (m.note === undefined ? "" : `  ${m.note}`),
    )
  }
  console.log(`\n  ${saves.savesDir(name)}`)
  return 0
}

const NOTE_USAGE = "usage: winvm saves note [-i name] <save> [--title T] [--text TEXT|-] [--tags a,b,c] [--clear] [--json]"

/** Standard input, whole: `--text -`. */
const readStdin = (): string => readFileSync(0, "utf8")

/**
 * `saves note <save>`: with none of --title/--text/--tags/--clear, show the
 * note; otherwise change it — --clear first (so `--clear --title T` replaces
 * the whole note), then the fields given, merged into what is there.
 */
export function note(args: Args, stdin: () => string = readStdin): number {
  const name = instanceName(args)
  const target = args.positional[1]
  if (target === undefined) return fail(NOTE_USAGE)
  const err = saves.nameError(target)
  if (err !== null) return fail(err)
  if (!saves.hasSave(name, target)) return fail(`instance "${name}" has no save "${target}"`)
  const json = args.flags.has("json")
  const title = args.flags.get("title")
  let text = args.flags.get("text")
  const tags = args.flags.get("tags")
  const clear = args.flags.has("clear")
  try {
    if (title === undefined && text === undefined && tags === undefined && !clear) {
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
    const written = Object.keys(patch).length === 0 ? null : notes.writeNote(name, target, patch)
    const result = written === null || notes.isEmptyNote(written) ? null : written
    if (json) console.log(JSON.stringify(result, null, 2))
    else if (result !== null) console.log(`updated the note on save "${target}"`)
    else console.log(had ? `deleted the note on save "${target}"` : `save "${target}" has no note`)
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
  await qmp.execute(p.qmp, "stop")
  console.log(`paused "${name}" — \`winvm resume -i ${name}\` to continue`)
  return 0
}

export async function resume(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) return fail(`instance "${name}" is not running`)
  const state = await qmp.status(p.qmp)
  if (state !== "running") await qmp.execute(p.qmp, "cont")
  else console.log(`"${name}" was not paused`)
  if (!(await settle(p, "resuming"))) return 1
  if (state !== "running") console.log(`resumed "${name}"`)
  return 0
}

export async function stow(args: Args): Promise<number> {
  const name = instanceName(args)
  // Like `stop`: end the watcher first (waiting out an autosave in progress).
  // A no-op when the watcher itself is the one running this stow.
  await watcher.stopWatcher(name)
  const started = Date.now()
  const code = await doSave(name, {
    name: saves.STOW,
    kind: "stow",
    quitAfter: true,
    checkReady: !args.flags.has("force"),
  })
  if (code !== 0) return code
  console.log(`stowed "${name}" in ${secs(Date.now() - started)} — QEMU is stopped; \`winvm start -i ${name}\` recalls it`)
  return 0
}

export async function clock(args: Args): Promise<number> {
  const name = instanceName(args)
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) return fail(`instance "${name}" is not running`)
  if ((await qmp.status(p.qmp)) !== "running") return fail(`instance "${name}" is paused — \`winvm resume\` fixes the clock too`)
  if (args.flags.has("check")) {
    const o = await measureOffset(p)
    console.log(`guest clock is ${formatOffset(o.offsetMs)} from the host (±${String(Math.ceil(o.rttMs / 2))} ms)`)
    return 0
  }
  await alignZone(p)
  const c = await syncGuestClock(p)
  console.log(`guest clock was ${formatOffset(c.beforeOffsetMs)} from the host; now ${formatOffset(c.afterOffsetMs)}`)
  return 0
}

/** Guest time zone = host's, RTC read as UTC. Never fatal. */
async function alignZone(p: Paths): Promise<void> {
  try {
    const z = await alignGuestTimeZone(p)
    if (z === null) console.warn("warning: could not map the host's time zone to a Windows one; guest zone left as is")
    else if (z.changed) console.log(`  time zone: ${z.from === "" ? "?" : z.from} -> ${z.to} (RTC read as UTC)`)
  } catch (error) {
    console.warn(`warning: could not set the guest time zone (${msg(error)})`)
  }
}

// ---------------------------------------------------------------------------
// Hooks for commands.ts

/**
 * `start` with a stow present: recall it instead of booting. Returns null when
 * there is nothing to recall (or it cannot be), so `start` boots as usual.
 * `--boot` discards the stow and boots cold.
 */
export async function recallStow(name: string, args: Args): Promise<number | null> {
  if (!saves.hasSave(name, saves.STOW) || args.flags.has("ephemeral")) return null
  if (args.flags.has("boot")) {
    saves.removeSave(name, saves.STOW)
    console.log("discarded the stow save (--boot)")
    return null
  }
  const meta = readMeta(name)
  if (meta !== null) {
    const m = saves.readSave(name, saves.STOW)
    if (m !== null && m.compat !== saves.currentCompat(name, meta).hash) {
      console.warn(`warning: the stow save no longer matches this VM's hardware; booting instead (it is kept — \`winvm saves -i ${name}\`)`)
      return null
    }
  }
  return await doLoad(name, saves.STOW, "recalled")
}

/** Remember that this instance has never booted, so its first ready moment is captured. */
export const markPristine = saves.markPristine

/**
 * After `start` saw the guest ready: fix the clock, and on an instance's first
 * boot take the "baseline" save — unless `--no-autosave`, `--ephemeral`, or a
 * compatible baseline already exists (a reset instance keeps its baseline).
 */
export async function afterBoot(name: string, args: Args): Promise<void> {
  const p = pathsFor(name)
  await alignZone(p)
  try {
    const c = await syncGuestClock(p)
    console.log(`  clock: guest was ${formatOffset(c.beforeOffsetMs)} from the host, now ${formatOffset(c.afterOffsetMs)}`)
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
  if (existing !== null && existing.compat === saves.currentCompat(name, meta).hash) {
    saves.clearPristine(name)
    return
  }
  console.log("taking the automatic baseline save (--no-autosave skips this)")
  // `start` has just waited for waitReady, so the guest is past OOBE.
  const code = await doSave(name, { name: saves.BASELINE, kind: "baseline", checkReady: false })
  if (code === 0) saves.clearPristine(name)
}

/**
 * `rewind [tag]`: an internal snapshot of that tag wins when one exists (the
 * old behaviour); otherwise load the save of that name, or "baseline" when no
 * tag is given. Returns null to let the snapshot path run.
 */
export async function rewindViaSave(name: string, tag: string | undefined): Promise<number | null> {
  const p = pathsFor(name)
  const snapTag = tag ?? snapshot.DEFAULT_TAG
  let hasSnap: boolean
  try {
    hasSnap = (qemu.isRunning(p) ? await snapshot.listLive(p) : snapshot.list(p)).some((s) => s.tag === snapTag)
  } catch {
    hasSnap = false
  }
  if (hasSnap) return null
  const saveName = tag ?? saves.BASELINE
  if (!saves.hasSave(name, saveName)) return null
  return await doLoad(name, saveName, "rewound")
}

/** After a snapshot rewind: the guest's clock stood still since the snapshot. */
export async function afterRewind(name: string): Promise<void> {
  const p = pathsFor(name)
  try {
    const c = await syncGuestClock(p)
    console.log(`  clock: guest was ${formatOffset(c.beforeOffsetMs)} from the host, now ${formatOffset(c.afterOffsetMs)}`)
  } catch (error) {
    console.warn(`warning: could not set the guest clock (${msg(error)})`)
  }
  // A rewind supersedes a stow, exactly as a load does.
  if (saves.hasSave(name, saves.STOW)) saves.removeSave(name, saves.STOW)
}

/** `reset` puts the instance back to its base, so a stow would bring back what was discarded. */
export function afterReset(name: string): void {
  if (saves.hasSave(name, saves.STOW)) saves.removeSave(name, saves.STOW)
  saves.markPristine(name)
}
