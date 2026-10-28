/**
 * The guest's drives in Finder: Windows' own file server, reached through a
 * forwarded port and mounted on the Mac.
 *
 *   winvm files open    [-i name] [c|home] [--path GUEST_PATH]   mount if needed, then show it in Finder
 *   winvm files mount   [-i name] [c|home]   (both when neither is named)
 *   winvm files unmount [-i name] [c|home]
 *   winvm files status  [-i name] [--json]
 *
 * HOW. The first mount has the agent set the guest up (POST /smb/setup, see
 * guestagent.smbSetupScript): an account, SMB_USER, that can log on over the
 * network and nowhere else, with a random password kept in smb.json
 * (smbstate.ts); two shares, C (C:\) and Home (the profile); and a firewall
 * rule letting in 10.0.2.2 alone — where slirp's forwarded connections come
 * from. agentfwd.ts forwards a stable host port to the guest's 445. Each share
 * is mounted on ~/winvm/<instance>/{C,Home}: soft, not browsable, no UI, no
 * keychain, and the password never on a command line (NetFS through bun:ffi,
 * in a child process so a stuck mount can be abandoned; netfs.ts).
 *
 * The setup runs again whenever a mount is refused: a guest loaded from
 * another machine's save holds that machine's password, and one loaded from
 * before the setup has no account at all.
 *
 * LIFECYCLE. A mount whose server goes away hangs whatever touches it, so
 * mounts never outlive the guest's QEMU, nor a guest that stops answering:
 *   beforeDown   stop, kill, stow (the watcher's idle stow too), load, rewind,
 *                reset, golden reset, destroy, pause, reboot: unmount first,
 *                remembering what was mounted (smb.json `mounted`)
 *   afterUp      start/recall, load, resume, reboot, rewind: mount it again
 *   cleanStale   a QEMU that died: the watcher, the next command and
 *                `diagnose` unmount what it left
 * An autosave keeps the mounts; the guest pauses for seconds and the mount is soft.
 *
 * UNMOUNTING SAFELY. Only a folder the mount table shows as THIS instance's
 * share (smbfs, from 127.0.0.1:<its port>, mounted exactly there) is ever
 * unmounted: `diskutil unmount force` given a folder that is not a mount point
 * unmounts the volume holding it — the Mac's Data volume, for a folder in the
 * home directory. Nothing here reads through a mount to check it, either:
 * macOS's privacy controls stop a process doing so until someone allows it,
 * and a dead server would hang it. The mount table is read without touching
 * any mount.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs"
import { resolve } from "node:path"

import * as agent from "./agent"
import { ensureSmbForward } from "./agentfwd"
import type { Args } from "./args"
import { instanceName } from "./args"
import { cliArgv, pathsFor, readMeta } from "./paths"
import { netfsMount } from "./netfs"
import * as qemu from "./qemu"
import type { MountEntry, ShareKey, SmbState } from "./smbstate"
import {
  SHARES,
  SHARE_KEYS,
  ensureSmb,
  findOurMount,
  instanceMountDir,
  isShareKey,
  mountDir,
  parseMountTable,
  readSmb,
  shareFor,
  withMounted,
  writeSmb,
} from "./smbstate"

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** NetFS's EAUTH: the server refused the user or the password. */
export const EAUTH = 80
/** What a mount attempt that never finished reports. */
export const ETIMEDOUT = 60

/** What the mechanics need from the Mac; tests pass fakes. */
export interface Sys {
  /** The kernel's mount table (`mount`), read without touching any mount. */
  mountTable(): readonly MountEntry[]
  /** Run a program, killed after `timeoutMs`. */
  run(cmd: string, args: readonly string[], timeoutMs: number): { readonly code: number | null; readonly out: string }
  /** Mount `url` on `dir`, signing in as user/password, giving up after `timeoutMs`: 0, or an errno. */
  mount(req: { readonly url: string; readonly dir: string; readonly user: string; readonly password: string }, timeoutMs: number): Promise<number>
  /** Set the guest up to share (agent POST /smb/setup); throws when it fails. */
  setup(instance: string, s: SmbState, log: (line: string) => void): Promise<void>
  /** Forward a host port to the guest's 445 (recorded in smb.json); returns it. */
  forward(instance: string): Promise<number>
  running(instance: string): boolean
  sleep(ms: number): Promise<void>
  log(line: string): void
}

function runSync(cmd: string, args: readonly string[], timeoutMs: number): { code: number | null; out: string } {
  const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error === undefined ? "" : String(r.error)}` }
}

/**
 * One mount, through NetFS in a child process (`winvm files _netfs`, the
 * request on stdin): NetFSMountURLSync cannot be interrupted, so a server that
 * accepts the connection and then says nothing would otherwise hang this
 * process. The child is abandoned after `timeoutMs`.
 */
async function mountInChild(req: { url: string; dir: string; user: string; password: string }, timeoutMs: number): Promise<number> {
  const limit = Math.min(timeoutMs, 25_000)
  const child = Bun.spawn([process.execPath, ...cliArgv("files", "_netfs")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
  child.stdin.write(JSON.stringify(req))
  await child.stdin.end()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), limit)
  })
  const done = await Promise.race([child.exited, timedOut])
  clearTimeout(timer)
  if (done === "timeout") {
    child.kill("SIGKILL")
    return ETIMEDOUT
  }
  const out = await new Response(child.stdout).text()
  const m = /"code":\s*(-?\d+)/.exec(out)
  return m === null ? -1 : Number(m[1])
}

async function guestSetup(instance: string, s: SmbState, log: (line: string) => void): Promise<void> {
  const c = await agent.ensure(instance, { log: (l) => log(`  ${l}`) })
  const r = await c.smbSetup({ user: s.user, password: s.password })
  for (const line of r.output.split(/\r?\n/)) if (line.trim() !== "") log(`  guest: ${line.trimEnd()}`)
  if (r.code !== 0 || r.timedOut) throw new Error(`setting up file sharing in the guest failed (exit ${String(r.code)})`)
}

export const realSys: Sys = {
  mountTable: () => parseMountTable(runSync("/sbin/mount", [], 10_000).out),
  run: runSync,
  mount: mountInChild,
  setup: guestSetup,
  forward: async (instance) => await ensureSmbForward(pathsFor(instance)),
  running: (instance) => qemu.isRunning(pathsFor(instance)),
  sleep: async (ms) => await Bun.sleep(ms),
  log: (line) => console.log(line),
}

// --- unmounting ----------------------------------------------------------------

export type UnmountOutcome = "not-mounted" | "unmounted" | "failed"

/**
 * Unmount one share, only if the mount table shows it mounted exactly on
 * `want.dir` from 127.0.0.1:`want.port`: `umount`, then, if it is still there
 * — checked again, so still our mount point — `diskutil unmount force`. Each
 * in a child process with a deadline. A folder that is not our mount point is
 * never handed to either.
 */
export function unmountShare(
  want: { readonly dir: string; readonly port: number; readonly share: string },
  sys: Sys = realSys,
  o: { readonly umountMs?: number } = {},
): UnmountOutcome {
  if (findOurMount(sys.mountTable(), want) === null) return "not-mounted"
  sys.run("/sbin/umount", [want.dir], o.umountMs ?? 15_000)
  if (findOurMount(sys.mountTable(), want) === null) return "unmounted"
  sys.run("/usr/sbin/diskutil", ["unmount", "force", want.dir], 30_000)
  return findOurMount(sys.mountTable(), want) === null ? "unmounted" : "failed"
}

/** Remove an empty mount folder, and the instance's folder if that is left empty. Never a mount point, never anything with files in it. */
function tidy(instance: string, dir: string, sys: Sys): void {
  const table = sys.mountTable()
  for (const d of [dir, instanceMountDir(instance)]) {
    if (table.some((e) => e.dir === d)) return
    try {
      if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d)
    } catch {
      return
    }
  }
}

/**
 * Unmount every share of `instance` that is mounted. Never throws. With the
 * guest gone (`dead`) a plain umount only waits on a server that will never
 * answer, so it gets a moment before the forced unmount.
 */
function unmountAll(
  instance: string,
  keys: readonly ShareKey[],
  sys: Sys,
  dead = false,
): { readonly unmounted: string[]; readonly failed: string[]; readonly failedKeys: ShareKey[] } {
  const s = readSmb(pathsFor(instance))
  const unmounted: string[] = []
  const failed: string[] = []
  const failedKeys: ShareKey[] = []
  if (s === null || s.hostPort === null) return { unmounted, failed, failedKeys }
  for (const key of keys) {
    const dir = mountDir(instance, key)
    try {
      const r = unmountShare({ dir, port: s.hostPort, share: SHARES[key].share }, sys, dead ? { umountMs: 2000 } : {})
      if (r === "unmounted") unmounted.push(dir)
      if (r === "failed") {
        failed.push(dir)
        failedKeys.push(key)
      } else tidy(instance, dir, sys)
    } catch (error) {
      failed.push(`${dir} (${errMsg(error)})`)
      failedKeys.push(key)
    }
  }
  return { unmounted, failed, failedKeys }
}

// --- mounting --------------------------------------------------------------------

export interface MountOptions {
  /** How long to keep trying while the guest's file server is not answering yet. */
  readonly waitMs?: number
  readonly sys?: Sys
}

/** Keep trying every 0.5 s until `deadline`; a refused sign-in is final. */
async function tryMount(
  req: { url: string; dir: string; user: string; password: string },
  want: { readonly dir: string; readonly port: number; readonly share: string },
  deadline: number,
  sys: Sys,
): Promise<number> {
  for (;;) {
    // No attempt outlives the deadline: a guest whose firewall drops the
    // connection leaves NetFS waiting far longer.
    const code = await sys.mount(req, Math.max(3000, deadline - Date.now()))
    if (code === 0) return 0
    // An attempt abandoned just as it finished may have mounted after all.
    if (findOurMount(sys.mountTable(), want) !== null) return 0
    if (code === EAUTH || Date.now() + 500 >= deadline) return code
    await sys.sleep(500)
  }
}

const describeCode = (code: number): string =>
  code === EAUTH
    ? "the guest refused the sign-in"
    : code === ETIMEDOUT
      ? "the guest's file server did not answer"
      : `error ${String(code)}`

/**
 * Mount `keys` of a running instance, setting the guest up first when it never
 * was, and again when a mount is refused. Records them in smb.json `mounted`.
 * Returns where each one is mounted.
 */
export async function mountShares(instance: string, keys: readonly ShareKey[], o: MountOptions = {}): Promise<readonly string[]> {
  const sys = o.sys ?? realSys
  const p = pathsFor(instance)
  if (!sys.running(instance)) throw new Error(`instance "${instance}" is not running — \`winvm start -i ${instance}\``)
  const { state: first, created } = ensureSmb(p)
  const port = await sys.forward(instance)
  let state: SmbState = { ...(readSmb(p) ?? first), hostPort: port }
  let setUp = false
  const setup = async (why: string): Promise<void> => {
    sys.log(`setting up file sharing in the guest (${why})`)
    await sys.setup(instance, state, sys.log)
    setUp = true
  }
  if (created) await setup("first time")

  const dirs: string[] = []
  for (const key of keys) {
    const share = SHARES[key].share
    const dir = mountDir(instance, key)
    const want = { dir, port, share }
    const table = sys.mountTable()
    if (findOurMount(table, want) === null) {
      const other = table.find((e) => e.dir === dir)
      if (other !== undefined) throw new Error(`${dir} already has ${other.source} (${other.type}) mounted on it; unmount that first`)
      mkdirSync(dir, { recursive: true })
      const req = { url: `smb://127.0.0.1:${String(port)}/${share}`, dir, user: state.user, password: state.password }
      let code = await tryMount(req, want, Date.now() + (o.waitMs ?? 10_000), sys)
      if (code !== 0 && !setUp) {
        await setup(code === EAUTH ? "the guest refused the saved password" : "the guest's file server did not answer")
        code = await tryMount(req, want, Date.now() + 30_000, sys)
      }
      if (code !== 0) {
        tidy(instance, dir, sys)
        throw new Error(`could not mount ${share} on ${dir}: ${describeCode(code)}`)
      }
      if (findOurMount(sys.mountTable(), want) === null) throw new Error(`mounting ${share} reported success, but ${dir} is not in the mount table`)
      sys.log(`mounted ${share} on ${dir}`)
    }
    state = withMounted(state, key, true)
    writeSmb(p, state)
    dirs.push(dir)
  }
  return dirs
}

/** Unmount `keys` and forget them: they are not mounted again when the guest comes back. */
export function unmountShares(
  instance: string,
  keys: readonly ShareKey[],
  sys: Sys = realSys,
): { readonly unmounted: string[]; readonly failed: string[] } {
  const p = pathsFor(instance)
  const r = unmountAll(instance, keys, sys)
  const s = readSmb(p)
  if (s !== null) {
    let next = s
    for (const k of keys) if (!r.failedKeys.includes(k)) next = withMounted(next, k, false)
    writeSmb(p, next)
  }
  return r
}

// --- lifecycle hooks ---------------------------------------------------------------

/**
 * Before the guest goes away or stops answering (stop, kill, stow, load,
 * rewind, pause, reboot…): unmount its shares, keeping `mounted` so they come
 * back with it. A no-op for an instance that never shared. Never throws: what
 * it could not unmount it says, and cleanStale tries again.
 */
export function beforeDown(instance: string, sys: Sys = realSys): void {
  try {
    if (readSmb(pathsFor(instance)) === null) return
    const r = unmountAll(instance, SHARE_KEYS, sys)
    for (const d of r.unmounted) sys.log(`unmounted ${d}`)
    for (const d of r.failed) console.warn(`warning: could not unmount ${d}`)
  } catch (error) {
    console.warn(`warning: could not unmount the guest's drives (${errMsg(error)})`)
  }
}

/**
 * After the guest is back and answering (start, recall, load, resume, reboot,
 * rewind): mount again what was mounted, waiting up to 30 s for the file
 * server. Never throws.
 */
export async function afterUp(instance: string, sys: Sys = realSys): Promise<void> {
  const s = readSmb(pathsFor(instance))
  if (s === null || s.mounted.length === 0 || !sys.running(instance)) return
  try {
    await mountShares(instance, s.mounted, { waitMs: 30_000, sys })
  } catch (error) {
    console.warn(`warning: the guest's drives were not mounted again (${errMsg(error)}) — \`winvm files mount -i ${instance}\``)
  }
}

/**
 * Mounts left behind by a QEMU that is gone (killed, crashed): unmount them.
 * The watcher calls it when QEMU exits, the CLI before each command, and
 * `diagnose`. Returns what it unmounted. Never throws.
 *
 * SLOW, AND IT CANNOT BE HURRIED. With its server gone, macOS's SMB client
 * holds an unmount until the dead connection times out — about a minute,
 * measured, for `umount` and `diskutil unmount force` alike, and a process in
 * that wait does not die when killed. So it says so first.
 */
export function cleanStale(instance: string, sys: Sys = realSys): readonly string[] {
  try {
    const stale = staleMounts(instance, sys)
    if (stale.length === 0) return []
    console.error(`unmounting ${stale.join(" and ")}, left by a guest that is gone (this can take a minute)`)
    const r = unmountAll(instance, SHARE_KEYS, sys, true)
    for (const d of r.failed) console.warn(`warning: could not unmount ${d}, left by a guest that is gone`)
    return r.unmounted
  } catch {
    return []
  }
}

/** Our mounts of an instance whose QEMU is gone: what cleanStale would unmount. */
export function staleMounts(instance: string, sys: Sys = realSys): readonly string[] {
  const s = readSmb(pathsFor(instance))
  if (s === null || s.hostPort === null || sys.running(instance)) return []
  const port = s.hostPort
  const table = sys.mountTable()
  return SHARE_KEYS.map((key) => mountDir(instance, key)).filter((dir, i) => {
    const key = SHARE_KEYS[i] ?? "c"
    return findOurMount(table, { dir, port, share: SHARES[key].share }) !== null
  })
}

/**
 * cleanStale in a detached `winvm files _clean`, for a command that only looks
 * (status, which the app asks for every few seconds) and should not wait the
 * minute it can take. Never throws.
 */
export function cleanStaleLater(instance: string, sys: Sys = realSys): void {
  try {
    if (staleMounts(instance, sys).length === 0) return
    spawn(process.execPath, [...cliArgv("files", "_clean", "-i", instance)], { detached: true, stdio: "ignore" }).unref()
  } catch {
    // The next command that changes anything cleans up instead.
  }
}

// --- the CLI ---------------------------------------------------------------------------

export interface ShareStatus {
  readonly key: ShareKey
  readonly share: string
  readonly guest: string
  readonly dir: string
  readonly mounted: boolean
  /** Mounted again whenever the guest comes back. */
  readonly remembered: boolean
}

export interface FilesStatus {
  readonly instance: string
  readonly running: boolean
  readonly setUp: boolean
  readonly hostPort: number | null
  readonly shares: readonly ShareStatus[]
}

export function status(instance: string, sys: Sys = realSys): FilesStatus {
  const s = readSmb(pathsFor(instance))
  const table = s === null || s.hostPort === null ? [] : sys.mountTable()
  return {
    instance,
    running: sys.running(instance),
    setUp: s !== null,
    hostPort: s?.hostPort ?? null,
    shares: SHARE_KEYS.map((key) => {
      const dir = mountDir(instance, key)
      return {
        key,
        share: SHARES[key].share,
        guest: SHARES[key].guest,
        dir,
        mounted: s?.hostPort != null && findOurMount(table, { dir, port: s.hostPort, share: SHARES[key].share }) !== null,
        remembered: s?.mounted.includes(key) ?? false,
      }
    }),
  }
}

const USAGE =
  "usage: winvm files open    [-i name] [c|home] [--path GUEST_PATH]   mount if needed, then show it in Finder\n" +
  "       winvm files mount   [-i name] [c|home]    both when neither is named\n" +
  "       winvm files unmount [-i name] [c|home]\n" +
  "       winvm files status  [-i name] [--json]"

function keysOf(arg: string | undefined, fallback: readonly ShareKey[]): readonly ShareKey[] | string {
  if (arg === undefined) return fallback
  const k = arg.toLowerCase().replace(/[:\\]+$/, "")
  return isShareKey(k) ? [k] : `"${arg}" is not a share: c or home`
}

/** The NetFS helper `mountInChild` runs: the request on stdin, `{"code":N}` on stdout. */
async function netfsHelper(): Promise<number> {
  const req = JSON.parse(await Bun.stdin.text()) as { url: string; dir: string; user: string; password: string }
  let code: number
  try {
    code = netfsMount(req)
  } catch (error) {
    console.error(errMsg(error))
    code = -1
  }
  console.log(JSON.stringify({ code }))
  return code === 0 ? 0 : 1
}

export async function filesCmd(args: Args): Promise<number> {
  const sub = args.positional[0]
  if (sub === "_netfs") return await netfsHelper()
  const instance = instanceName(args)
  if (sub === "_clean") {
    cleanStale(instance)
    return 0
  }
  const json = args.flags.has("json")
  // With --json, stdout is the JSON alone; what happens on the way goes to stderr.
  const sys: Sys = json ? { ...realSys, log: (line) => console.error(line) } : realSys
  if (sub === undefined || !["open", "mount", "unmount", "status"].includes(sub)) {
    console.error(USAGE)
    return 2
  }
  if (readMeta(instance) === null) {
    console.error(`::error::no such instance "${instance}"`)
    return 1
  }
  if (sub === "status") {
    const st = status(instance)
    if (json) {
      console.log(JSON.stringify(st, null, 2))
      return 0
    }
    if (!st.setUp) console.log(`instance "${instance}" has not shared its drives yet — \`winvm files open -i ${instance}\``)
    for (const s of st.shares) {
      console.log(`  ${s.share.padEnd(5)} ${s.guest.padEnd(24)} ${s.mounted ? `mounted on ${s.dir}` : "not mounted"}${s.remembered && !s.mounted ? " (mounted again when the guest is back)" : ""}`)
    }
    return 0
  }

  if (sub === "unmount") {
    const keys = keysOf(args.positional[1], SHARE_KEYS)
    if (typeof keys === "string") return fail(keys)
    const r = unmountShares(instance, keys, sys)
    for (const d of r.unmounted) sys.log(`unmounted ${d}`)
    for (const d of r.failed) console.error(`::error::could not unmount ${d}`)
    if (json) console.log(JSON.stringify(status(instance), null, 2))
    return r.failed.length === 0 ? 0 : 1
  }

  // mount, open
  const guestPath = args.flags.get("path")
  let keys: readonly ShareKey[] | string
  let rel: readonly string[] = []
  if (sub === "open" && guestPath !== undefined) {
    const mapped = shareFor(guestPath)
    if (mapped === null) return fail(`${guestPath} is not on C:\\, so there is no share to show it from`)
    keys = [mapped.key]
    rel = mapped.rel
  } else {
    keys = keysOf(args.positional[1], sub === "open" ? ["home"] : SHARE_KEYS)
  }
  if (typeof keys === "string") return fail(keys)
  let dirs: readonly string[]
  try {
    dirs = await mountShares(instance, keys, { sys })
  } catch (error) {
    return fail(errMsg(error))
  }
  if (sub === "open") {
    const target = resolve(dirs[0] ?? mountDir(instance, keys[0] ?? "home"), ...rel)
    // Finder shows it; this process never reads through the mount (see the top).
    const r = runSync("/usr/bin/open", [target], 15_000)
    if (r.code !== 0) return fail(`could not show ${target} in Finder: ${r.out.trim()}`)
    if (!json) console.log(`opened ${target} in Finder`)
  }
  if (json) console.log(JSON.stringify(status(instance), null, 2))
  return 0
}

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}
