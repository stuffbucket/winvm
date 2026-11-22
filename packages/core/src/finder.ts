import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs"
import { resolve } from "node:path"

import * as agent from "./agent"
import { ensureSmbForward } from "./agentfwd"
import type { Args } from "./args"
import { instanceName } from "./args"
import { refuseFrozen } from "./frozen"
import { netfsMount } from "./netfs"
import { currentOp } from "./opcontext"
import { cliArgv, pathsFor, readMeta } from "./paths"
import * as qemu from "./qemu"
import { spawnText } from "./shell"
import type { MountEntry, ShareKey, SmbState } from "./smbstate"
import {
  ensureSmb,
  findOurMount,
  instanceMountDir,
  isShareKey,
  mountDir,
  parseMountTable,
  readSmb,
  SHARE_KEYS,
  SHARES,
  shareFor,
  withMounted,
  writeSmb,
} from "./smbstate"

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

export const EAUTH = 80
export const ETIMEDOUT = 60

export interface Sys {
  mountTable(): readonly MountEntry[]
  run(
    cmd: string,
    args: readonly string[],
    timeoutMs: number,
  ): { readonly code: number | null; readonly out: string }
  mount(
    req: {
      readonly url: string
      readonly dir: string
      readonly user: string
      readonly password: string
    },
    timeoutMs: number,
  ): Promise<number>
  setup(
    instance: string,
    s: SmbState,
    log: (line: string) => void,
  ): Promise<void>
  forward(instance: string): Promise<number>
  running(instance: string): boolean
  sleep(ms: number): Promise<void>
  log: (line: string) => void
}

function runSync(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
): { code: number | null; out: string } {
  const r = spawnText(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL" })
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}${r.error === undefined ? "" : String(r.error)}`,
  }
}

async function mountInChild(
  req: { url: string; dir: string; user: string; password: string },
  timeoutMs: number,
): Promise<number> {
  const limit = Math.min(timeoutMs, 25_000)
  const child = Bun.spawn([process.execPath, ...cliArgv("files", "_netfs")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  await child.stdin.write(JSON.stringify(req))
  await child.stdin.end()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((res) => {
    timer = setTimeout(() => {
      res("timeout")
    }, limit)
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

async function guestSetup(
  instance: string,
  s: SmbState,
  log: (line: string) => void,
): Promise<void> {
  const c = await agent.ensure(instance, {
    log: (l) => {
      log(`  ${l}`)
    },
  })
  const r = await c.smbSetup({ user: s.user, password: s.password })
  for (const line of r.output.split(/\r?\n/))
    if (line.trim() !== "") log(`  guest: ${line.trimEnd()}`)
  if (r.code !== 0 || r.timedOut)
    throw new Error(
      `setting up file sharing in the guest failed (exit ${String(r.code)})`,
    )
}

export const realSys: Sys = {
  mountTable: () => parseMountTable(runSync("/sbin/mount", [], 10_000).out),
  run: runSync,
  mount: mountInChild,
  setup: guestSetup,
  forward: async (instance) => await ensureSmbForward(pathsFor(instance)),
  running: (instance) => qemu.isRunning(pathsFor(instance)),
  sleep: async (ms) => {
    await Bun.sleep(ms)
  },
  log: (line) => {
    console.log(line)
  },
}

export type UnmountOutcome = "not-mounted" | "unmounted" | "failed"

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

function unmountAll(
  instance: string,
  keys: readonly ShareKey[],
  sys: Sys,
  dead = false,
): {
  readonly unmounted: string[]
  readonly failed: string[]
  readonly failedKeys: ShareKey[]
} {
  const s = readSmb(pathsFor(instance))
  const unmounted: string[] = []
  const failed: string[] = []
  const failedKeys: ShareKey[] = []
  if (s === null || s.hostPort === null)
    return { unmounted, failed, failedKeys }
  for (const key of keys) {
    const dir = mountDir(instance, key)
    try {
      const r = unmountShare(
        { dir, port: s.hostPort, share: SHARES[key].share },
        sys,
        dead ? { umountMs: 2000 } : {},
      )
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

export interface MountOptions {
  readonly waitMs?: number
  readonly sys?: Sys
}

async function tryMount(
  req: { url: string; dir: string; user: string; password: string },
  want: { readonly dir: string; readonly port: number; readonly share: string },
  deadline: number,
  sys: Sys,
): Promise<number> {
  for (;;) {
    const code = await sys.mount(req, Math.max(3000, deadline - Date.now()))
    if (code === 0) return 0
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

export async function mountShares(
  instance: string,
  keys: readonly ShareKey[],
  o: MountOptions = {},
): Promise<readonly string[]> {
  const sys = o.sys ?? realSys
  const p = pathsFor(instance)
  if (!sys.running(instance))
    throw new Error(
      `instance "${instance}" is not running — \`winvm start -i ${instance}\``,
    )
  const { state: first, created } = ensureSmb(p)
  const port = await sys.forward(instance)
  let state: SmbState = { ...(readSmb(p) ?? first), hostPort: port }
  let setUp = false as boolean
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
      if (other !== undefined)
        throw new Error(
          `${dir} already has ${other.source} (${other.type}) mounted on it; unmount that first`,
        )
      mkdirSync(dir, { recursive: true })
      const req = {
        url: `smb://127.0.0.1:${String(port)}/${share}`,
        dir,
        user: state.user,
        password: state.password,
      }
      let code = await tryMount(
        req,
        want,
        Date.now() + (o.waitMs ?? 10_000),
        sys,
      )
      if (code !== 0 && !setUp) {
        await setup(
          code === EAUTH
            ? "the guest refused the saved password"
            : "the guest's file server did not answer",
        )
        code = await tryMount(req, want, Date.now() + 30_000, sys)
      }
      if (code !== 0) {
        tidy(instance, dir, sys)
        throw new Error(
          `could not mount ${share} on ${dir}: ${describeCode(code)}`,
        )
      }
      if (findOurMount(sys.mountTable(), want) === null)
        throw new Error(
          `mounting ${share} reported success, but ${dir} is not in the mount table`,
        )
      sys.log(`mounted ${share} on ${dir}`)
    }
    state = withMounted(state, key, true)
    writeSmb(p, state)
    dirs.push(dir)
  }
  return dirs
}

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
    for (const k of keys)
      if (!r.failedKeys.includes(k)) next = withMounted(next, k, false)
    writeSmb(p, next)
  }
  return r
}

export function beforeDown(instance: string, sys: Sys = realSys): void {
  try {
    if (readSmb(pathsFor(instance)) === null) return
    const r = unmountAll(instance, SHARE_KEYS, sys)
    for (const d of r.unmounted) sys.log(`unmounted ${d}`)
    for (const d of r.failed) console.warn(`warning: could not unmount ${d}`)
  } catch (error) {
    console.warn(
      `warning: could not unmount the guest's drives (${errMsg(error)})`,
    )
  }
}

export interface QuickUnmount {
  mountTable(): {
    readonly done: Promise<readonly MountEntry[]>
    kill(): void
  }
  unmount(dir: string): {
    readonly done: Promise<unknown>
    kill(): void
  }
}

export const quickUnmount: QuickUnmount = {
  mountTable: () => {
    const proc = Bun.spawn(["/sbin/mount"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    return {
      done: new Response(proc.stdout).text().then(parseMountTable),
      kill: () => {
        proc.kill("SIGKILL")
      },
    }
  },
  unmount: (dir) => {
    const proc = Bun.spawn(["/sbin/umount", "-f", dir], {
      stdout: "ignore",
      stderr: "ignore",
    })
    return {
      done: proc.exited,
      kill: () => {
        proc.kill("SIGKILL")
      },
    }
  },
}

export async function unmountWithin(
  instance: string,
  budgetMs: number,
  sys: QuickUnmount = quickUnmount,
): Promise<{ readonly unmounted: number; readonly left: number }> {
  const s = readSmb(pathsFor(instance))
  if (s === null || s.hostPort === null) return { unmounted: 0, left: 0 }
  const port = s.hostPort
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => {
      done("late")
    }, budgetMs)
  })
  try {
    const listing = sys.mountTable()
    const table = await Promise.race([
      listing.done.catch(() => [] as readonly MountEntry[]),
      late,
    ])
    if (table === "late") {
      listing.kill()
      return { unmounted: 0, left: SHARE_KEYS.length }
    }
    const ours = SHARE_KEYS.map((key) => ({
      dir: mountDir(instance, key),
      port,
      share: SHARES[key].share,
    })).filter((want) => findOurMount(table, want) !== null)
    const runs = ours.map((want) => {
      const run = sys.unmount(want.dir)
      let finished = false
      void run.done.then(() => {
        finished = true
      })
      return { run, finished: (): boolean => finished }
    })
    await Promise.race([
      Promise.all(runs.map(async (r) => await r.run.done)),
      late,
    ])
    const left = runs.filter((r) => !r.finished())
    for (const r of left) r.run.kill()
    return { unmounted: runs.length - left.length, left: left.length }
  } finally {
    clearTimeout(timer)
  }
}

export type Remounted = "mounted" | "nothing pending" | "failed"

const pendingMounts = (instance: string, sys: Sys): readonly ShareKey[] => {
  const s = readSmb(pathsFor(instance))
  return s === null || !sys.running(instance) ? [] : s.mounted
}

async function mountAgain(
  instance: string,
  mounted: readonly ShareKey[],
  sys: Sys,
): Promise<boolean> {
  try {
    await mountShares(instance, mounted, { waitMs: 30_000, sys })
    return true
  } catch (error) {
    console.warn(
      `warning: the guest's drives were not mounted again (${errMsg(error)}) — \`winvm files mount -i ${instance}\``,
    )
    return false
  }
}

export async function remountPending(
  instance: string,
  sys: Sys = realSys,
): Promise<Remounted> {
  const mounted = pendingMounts(instance, sys)
  if (mounted.length === 0) return "nothing pending"
  return (await mountAgain(instance, mounted, sys)) ? "mounted" : "failed"
}

export async function afterUp(
  instance: string,
  sys: Sys = realSys,
): Promise<void> {
  const mounted = pendingMounts(instance, sys)
  if (mounted.length === 0) return
  const op = currentOp()
  if (op !== null) {
    op.remount()
    return
  }
  await mountAgain(instance, mounted, sys)
}

export function cleanStale(
  instance: string,
  sys: Sys = realSys,
): readonly string[] {
  try {
    const stale = staleMounts(instance, sys)
    if (stale.length === 0) return []
    console.error(
      `unmounting ${stale.join(" and ")}, left by a guest that is gone (this can take a minute)`,
    )
    const r = unmountAll(instance, SHARE_KEYS, sys, true)
    for (const d of r.failed)
      console.warn(
        `warning: could not unmount ${d}, left by a guest that is gone`,
      )
    return r.unmounted
  } catch {
    return []
  }
}

export function staleMounts(
  instance: string,
  sys: Sys = realSys,
): readonly string[] {
  const s = readSmb(pathsFor(instance))
  if (s === null || s.hostPort === null || sys.running(instance)) return []
  const port = s.hostPort
  const table = sys.mountTable()
  return SHARE_KEYS.map((key) => mountDir(instance, key)).filter((dir, i) => {
    const key = SHARE_KEYS[i] ?? "c"
    return findOurMount(table, { dir, port, share: SHARES[key].share }) !== null
  })
}

export function cleanStaleLater(instance: string, sys: Sys = realSys): void {
  try {
    if (staleMounts(instance, sys).length === 0) return
    spawn(process.execPath, [...cliArgv("files", "_clean", "-i", instance)], {
      detached: true,
      stdio: "ignore",
    }).unref()
  } catch {}
}

export interface ShareStatus {
  readonly key: ShareKey
  readonly share: string
  readonly guest: string
  readonly dir: string
  readonly mounted: boolean
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
        mounted:
          s?.hostPort != null &&
          findOurMount(table, {
            dir,
            port: s.hostPort,
            share: SHARES[key].share,
          }) !== null,
        remembered: s?.mounted.includes(key) ?? false,
      }
    }),
  }
}

export function drivesOwed(
  instance: string,
  sys: Sys = realSys,
): readonly ShareKey[] {
  const st = status(instance, sys)
  return st.running
    ? st.shares.filter((s) => s.remembered && !s.mounted).map((s) => s.key)
    : []
}

const USAGE =
  "usage: winvm files open    [-i name] [c|home] [--path GUEST_PATH]   mount if needed, then show it in Finder\n" +
  "       winvm files mount   [-i name] [c|home]    both when neither is named\n" +
  "       winvm files unmount [-i name] [c|home]\n" +
  "       winvm files remount [-i name]    mount again what a command took down; exits 1 if it mounted nothing that was waiting\n" +
  "       winvm files status  [-i name] [--json]"

function keysOf(
  arg: string | undefined,
  fallback: readonly ShareKey[],
): readonly ShareKey[] | string {
  if (arg === undefined) return fallback
  const k = arg.toLowerCase().replace(/[:\\]+$/, "")
  return isShareKey(k) ? [k] : `"${arg}" is not a share: c or home`
}

async function netfsHelper(): Promise<number> {
  const req = JSON.parse(await Bun.stdin.text()) as {
    url: string
    dir: string
    user: string
    password: string
  }
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
  const sys: Sys = json
    ? {
        ...realSys,
        log: (line) => {
          console.error(line)
        },
      }
    : realSys
  if (
    sub === undefined ||
    !["open", "mount", "unmount", "status"].includes(sub)
  ) {
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
    if (!st.setUp)
      console.log(
        `instance "${instance}" has not shared its drives yet — \`winvm files open -i ${instance}\``,
      )
    for (const s of st.shares) {
      console.log(
        `  ${s.share.padEnd(5)} ${s.guest.padEnd(24)} ${s.mounted ? `mounted on ${s.dir}` : "not mounted"}${s.remembered && !s.mounted ? " (mounted again when the guest is back)" : ""}`,
      )
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

  try {
    await refuseFrozen(instance)
  } catch (error) {
    return fail(errMsg(error))
  }
  const guestPath = args.flags.get("path")
  let keys: readonly ShareKey[] | string
  let rel: readonly string[] = []
  if (sub === "open" && guestPath !== undefined) {
    const mapped = shareFor(guestPath)
    if (mapped === null)
      return fail(
        `${guestPath} is not on C:\\, so there is no share to show it from`,
      )
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
    const target = resolve(
      dirs[0] ?? mountDir(instance, keys[0] ?? "home"),
      ...rel,
    )
    const r = runSync("/usr/bin/open", [target], 15_000)
    if (r.code !== 0)
      return fail(`could not show ${target} in Finder: ${r.out.trim()}`)
    if (!json) console.log(`opened ${target} in Finder`)
  }
  if (json) console.log(JSON.stringify(status(instance), null, 2))
  return 0
}

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}
