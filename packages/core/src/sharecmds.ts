/**
 * `winvm share`: a Mac folder shown in Windows as a drive (virtio-fs; see
 * share.ts for the devices and the daemon).
 *
 *   share [-i name] [status] [--json]          what is shared, and whether Windows has it
 *   share [-i name] set PATH [--letter Z] [--readonly] [--json]
 *   share [-i name] clear [--json]             stop sharing (Windows sees an empty drive)
 *   share [-i name] install [--restart] [--json]   set up Windows' side on an existing machine
 *
 * ONE FOLDER PER MACHINE. One virtiofsd serves one directory for the life of
 * its QEMU, and QEMU does not survive its daemon going away (measured: QEMU
 * exits with "vhost_set_vring_call failed"), so the folder cannot be swapped
 * under a running guest. A change is saved at once and takes effect the next
 * time QEMU starts: a stop and start, or a stow and start, which keeps the
 * session. Only the drive letter changes live (the guest's service restarts).
 *
 * `install`, and why it boots on ramfb: see installGuest.
 */
import type { Args } from "./args"
import { instanceName, parseArgs } from "./args"
import * as agent from "./agent"
import * as commands from "./commands"
import { RAMFB, readDisplay, writeDisplay } from "./display"
import type { Paths } from "./paths"
import { pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as qga from "./qga"
import * as saves from "./saves"
import * as share from "./share"
import { INSTALL_SCRIPT, ensureShareMedia, installScript, VIOFS_FILES, WINFSP_FILE } from "./sharemedia"

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const fail = (m: string): number => {
  console.error(`::error::${m}`)
  return 1
}

/** Where `install` stages the guest's files. */
const GUEST_DIR = "C:\\ProgramData\\winvm\\viofs"

export interface GuestShare {
  /** viofs is bound to the device and VirtioFsSvc exists; null: unknown (stopped, or no agent). */
  readonly installed: boolean | null
  /** The drive answers in Windows. */
  readonly mounted: boolean | null
}

export interface ShareStatus {
  readonly available: boolean
  readonly reason: string | null
  readonly folder: string | null
  readonly letter: string
  readonly readonly: boolean
  readonly running: boolean
  /** What the running machine's daemon serves: the folder, or null (stopped, or the empty drive). */
  readonly serving: string | null
  /** The folder (or read-only) changed since this QEMU started: Windows sees it at the next start. */
  readonly pending: boolean
  readonly guest: GuestShare
  /** Set when the folder chosen no longer exists (the drive is empty until it does). */
  readonly missing?: string
}

/** Pure: the status from what is on disk and what the guest said. */
export function shareStatus(o: {
  readonly cfg: share.ShareConfig | null
  readonly unavailable: string | null
  readonly running: boolean
  readonly serving: share.Served | null
  readonly wanted: share.Served
  readonly guest: GuestShare
}): ShareStatus {
  const pending = o.running && o.unavailable === null && o.serving !== null && !share.sameServed(o.serving, o.wanted)
  return {
    available: o.unavailable === null,
    reason: o.unavailable,
    folder: o.cfg?.path ?? null,
    letter: o.cfg?.letter ?? share.DEFAULT_LETTER,
    readonly: o.cfg?.readonly ?? false,
    running: o.running,
    serving: o.running ? (o.serving?.folder ?? null) : null,
    pending,
    guest: o.guest,
    ...(o.wanted.missing === undefined ? {} : { missing: o.wanted.missing }),
  }
}

/** One PowerShell round trip: is viofs bound, does VirtioFsSvc exist, does the drive answer. */
export const guestProbeScript = (letter: string): string =>
  "$s = Get-Service VirtioFsSvc -ErrorAction SilentlyContinue; " +
  "$d = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'PCI\\VEN_1AF4&DEV_105A*' } | Select-Object -First 1; " +
  `"{0}|{1}|{2}" -f [bool]$s, $(if ($d) { $d.Status } else { 'absent' }), (Test-Path '${letter}:\\')`

export function parseGuestProbe(out: string): GuestShare {
  const m = /(True|False)\|(\w+)\|(True|False)/.exec(out)
  if (m === null) return { installed: null, mounted: null }
  return { installed: m[1] === "True" && m[2] === "OK", mounted: m[3] === "True" }
}

async function guestShare(name: string, letter: string): Promise<GuestShare> {
  const c = await agent.connect(name, { timeoutMs: 1500 })
  if (c === null) return { installed: null, mounted: null }
  try {
    return parseGuestProbe((await c.pwsh(guestProbeScript(letter), { timeoutMs: 15_000 })).output)
  } catch {
    return { installed: null, mounted: null }
  }
}

export async function gather(name: string, p: Paths = pathsFor(name)): Promise<ShareStatus> {
  const cfg = share.readShare(p)
  const unavailable = share.unavailableReason(readDisplay(p))
  const running = qemu.isRunning(p)
  const guest = running && unavailable === null ? await guestShare(name, cfg?.letter ?? share.DEFAULT_LETTER) : { installed: null, mounted: null }
  return shareStatus({ cfg, unavailable, running, serving: share.readServing(p), wanted: share.servedFor(p, cfg), guest })
}

const tilde = (path: string): string => {
  const home = process.env["HOME"] ?? ""
  return home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

function printStatus(name: string, s: ShareStatus, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(s))
    return
  }
  const flag = name === "default" ? "" : ` -i ${name}`
  if (!s.available) {
    console.log(`shared folder: unavailable — ${s.reason ?? ""}`)
    return
  }
  if (s.folder === null) console.log(`shared folder: none (Windows shows ${s.letter}: as an empty drive) — \`winvm share${flag} set PATH\``)
  else console.log(`shared folder: ${tilde(s.folder)}${s.readonly ? " (read-only)" : ""} -> ${s.letter}: (${share.DRIVE_LABEL}) in Windows`)
  if (s.missing !== undefined) console.log(`  ${s.missing} does not exist; Windows sees an empty drive until it does`)
  if (s.pending) console.log("  changed since Windows started: it sees the change the next time it starts (stop and start, or stow and start)")
  if (s.guest.installed === false) {
    console.log(`  Windows is not set up for it yet — \`winvm share${flag} install${s.running ? " --restart" : ""}\` (restarts Windows)`)
  } else if (s.guest.installed === true && s.guest.mounted === false) {
    console.log(`  Windows has the driver but ${s.letter}: is not there yet (VirtioFsSvc starting?)`)
  }
}

// ---------------------------------------------------------------------------
// The verbs

export async function shareCmd(args: Args): Promise<number> {
  const name = instanceName(args)
  const meta = readMeta(name)
  if (meta === null) return fail(`no instance "${name}"`)
  const p = pathsFor(name)
  const asJson = args.flags.has("json")
  const verb = args.positional[0] ?? "status"
  try {
    switch (verb) {
      case "status":
        printStatus(name, await gather(name, p), asJson)
        return 0
      case "set":
        return await set(name, p, args, asJson)
      case "clear":
        return await clear(name, p, asJson)
      case "install":
        return await install(name, p, args, asJson)
      default:
        return fail(`unknown share verb "${verb}" — status, set PATH, clear or install`)
    }
  } catch (error) {
    return fail(msg(error))
  }
}

/** `--readonly PATH` parses as a flag with a value: take the value as the path. */
export function setArgs(args: Args): { readonly path: string | null; readonly readonly: boolean; readonly letter: string | null } {
  const ro = args.flags.get("readonly")
  const roIsPath = ro !== undefined && ro !== "true" && ro !== "false"
  const path = args.positional[1] ?? (roIsPath ? ro : null)
  return { path, readonly: ro !== undefined && ro !== "false", letter: args.flags.get("letter") ?? null }
}

async function set(name: string, p: Paths, args: Args, asJson: boolean): Promise<number> {
  const a = setArgs(args)
  if (a.path === null) return fail("usage: winvm share set PATH [--letter Z] [--readonly]")
  const unavailable = share.unavailableReason(readDisplay(p))
  if (unavailable !== null) return fail(`cannot share a folder with "${name}": ${unavailable}`)
  const path = share.expandPath(a.path)
  const bad = share.folderError(path)
  if (bad !== null) return fail(bad)
  const before = share.readShare(p)
  const letter = a.letter === null ? (before?.letter ?? share.DEFAULT_LETTER) : share.parseLetter(a.letter)
  if (letter === null) return fail(`--letter takes a drive letter from D to Z, got "${a.letter ?? ""}"`)
  share.writeShare(p, { path, letter, readonly: a.readonly })
  if (qemu.isRunning(p) && (before?.letter ?? share.DEFAULT_LETTER) !== letter) await applyLetter(name, letter, asJson)
  printStatus(name, await gather(name, p), asJson)
  return 0
}

async function clear(name: string, p: Paths, asJson: boolean): Promise<number> {
  share.writeShare(p, null)
  printStatus(name, await gather(name, p), asJson)
  return 0
}

/** Move the drive in a running guest (viofs-install.ps1 -LetterOnly: registry, name, service restart). Best effort. */
async function applyLetter(name: string, letter: string, quiet: boolean): Promise<void> {
  const c = await agent.connect(name, { timeoutMs: 1500 })
  if (c === null) return
  await c.putFile(installScript(), `${GUEST_DIR}\\${INSTALL_SCRIPT}`)
  const r = await c.exec(installArgv(["-LetterOnly", "-Letter", letter]), { timeoutMs: 120_000 })
  if (!quiet) console.log(r.code === 0 ? `Windows now shows the shared folder as ${letter}:` : `could not move the drive to ${letter}: ${r.stderr.trim() || r.stdout.trim()}`)
}

/** powershell.exe running the staged viofs-install.ps1. */
export const installArgv = (extra: readonly string[]): readonly string[] => [
  "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-File", `${GUEST_DIR}\\${INSTALL_SCRIPT}`, "-Label", share.DRIVE_LABEL, ...extra,
]

/**
 * `share install`: set up Windows' side on a machine whose image predates it.
 *
 * WHY RAMFB. Binding viofs to the device while the virtio-gpu display driver
 * runs bugchecked Windows (0x7E in viogpudo.sys+0x1180), whether done live or
 * left to the next boot. So the machine is started once on ramfb WITH the
 * virtio-fs device (and the clipboard port), the driver is installed and bound
 * there, Windows is shut down, and the display goes back. QEMU keeps the
 * device in one PCI slot (share.deviceArgs), so on virtio-gpu Windows finds it
 * already installed. The sequence:
 *
 *   1. a running machine is shut down cleanly (only with --restart);
 *   2. display -> ramfb, boot with the shared folder devices, no watcher, no
 *      autosave (the machine's saves and its baseline are not touched);
 *   3. stage viofs + WinFsp through the agent, run viofs-install.ps1;
 *   4. shut down; display -> what it was (also on any failure);
 *   5. start again if it was running (or --start).
 *
 * A stowed machine is refused, as `display` refuses it: its disk is
 * mid-session, and booting it here would throw the session away.
 */
async function install(name: string, p: Paths, args: Args, asJson: boolean): Promise<number> {
  const display = readDisplay(p)
  const unavailable = share.unavailableReason(display)
  if (unavailable !== null) return fail(`cannot set up the shared folder for "${name}": ${unavailable}`)
  const flag = name === "default" ? "" : ` -i ${name}`
  if (saves.hasSave(name, saves.STOW)) {
    return fail(`"${name}" is stowed (saved mid-session). Start it, then run this with --restart: \`winvm start${flag} && winvm share${flag} install --restart\``)
  }
  const wasRunning = qemu.isRunning(p)
  if (wasRunning) {
    const g = await guestShare(name, share.readShare(p)?.letter ?? share.DEFAULT_LETTER)
    if (g.installed === true) {
      console.error(`Windows in "${name}" already has the shared folder set up`)
      printStatus(name, await gather(name, p), asJson)
      return 0
    }
    if (!args.flags.has("restart")) {
      return fail(`setting up the shared folder restarts Windows in "${name}" twice — save your work, then \`winvm share${flag} install --restart\``)
    }
  }
  const media = await ensureShareMedia()
  const log = (line: string): void => {
    if (asJson) console.error(line)
    else console.log(line)
  }
  const cli = (...a: string[]): Args => parseArgs(["-i", name, ...a])
  if (wasRunning) {
    log("shutting Windows down")
    if ((await quietly(asJson, async () => await commands.stop(cli()))) !== 0) return fail(`could not shut "${name}" down`)
  }
  try {
    await quietly(asJson, async () => {
      await installGuest(name, p, media, log)
      return 0
    })
  } catch (error) {
    return fail(`the shared folder's setup failed: ${msg(error)}`)
  } finally {
    if (qemu.isRunning(p)) {
      if ((await quietly(asJson, async () => await commands.stop(cli()))) !== 0) commands.kill(cli())
    }
    writeDisplay(p, display)
  }
  if (wasRunning || args.flags.has("start")) {
    log("starting Windows again")
    if ((await quietly(asJson, async () => await commands.start(cli()))) !== 0) return fail(`"${name}" did not start again`)
    // So the status below can say what Windows has: its agent starts at logon, just after `start` returns.
    await agent.connect(name, { timeoutMs: 60_000 })
  }
  printStatus(name, await gather(name, p), asJson)
  return 0
}

/**
 * Run a verb that prints, with all it prints on stderr when stdout must stay
 * one JSON object (the app parses it). Verbs write with console.log and, for
 * progress dots, process.stdout.write.
 */
async function quietly(toStderr: boolean, f: () => Promise<number>): Promise<number> {
  if (!toStderr) return await f()
  const log = console.log
  const write = process.stdout.write.bind(process.stdout)
  console.log = (...a: unknown[]): void => {
    console.error(...a)
  }
  process.stdout.write = ((chunk: string | Uint8Array): boolean => process.stderr.write(chunk)) as typeof process.stdout.write
  try {
    return await f()
  } finally {
    console.log = log
    process.stdout.write = write
  }
}

/** Steps 2-3 of `install`: the ramfb boot with the devices, the guest's script. Leaves the guest running. */
async function installGuest(name: string, p: Paths, media: string, log: (line: string) => void): Promise<void> {
  const meta = readMeta(name)
  if (meta === null) throw new Error(`no instance "${name}"`)
  writeDisplay(p, RAMFB)
  log("starting Windows on the basic display to install the shared folder's driver")
  await qemu.launch(name, p, meta, {
    installMedia: false,
    ephemeral: false,
    virtioBoot: readImageMeta(meta.image)?.virtioBoot === true,
    shareDevices: "all",
  })
  const ready = await qga.untilReady(p.qga, 600_000, { noLogonMs: 120_000 })
  if (ready !== "ready") throw new Error(`Windows did not become ready on the basic display (${ready})`)
  const c = await agent.ensure(name, { waitMs: 60_000 })
  for (const f of [...Object.keys(VIOFS_FILES), WINFSP_FILE]) await c.putFile(`${media}/${f}`, `${GUEST_DIR}\\${f}`)
  await c.putFile(installScript(), `${GUEST_DIR}\\${INSTALL_SCRIPT}`)
  const letter = share.readShare(p)?.letter ?? share.DEFAULT_LETTER
  log("installing viofs and WinFsp in Windows")
  const r = await c.exec(installArgv(["-Source", GUEST_DIR, "-Letter", letter]), { timeoutMs: 600_000 })
  for (const line of `${r.stdout}${r.stderr}`.split(/\r?\n/)) if (line.trim() !== "") log(`  windows: ${line.trimEnd()}`)
  if (r.code !== 0) throw new Error(`viofs-install.ps1 exited ${String(r.code)}`)
  const g = parseGuestProbe((await c.pwsh(guestProbeScript(letter), { timeoutMs: 30_000 })).output)
  if (g.installed !== true) throw new Error("Windows did not bind the shared folder's driver")
  log(`installed; ${letter}: ${g.mounted === true ? "answers" : "appears once Windows restarts"}`)
}
