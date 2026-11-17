import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { connect } from "node:net"
import { basename, dirname, resolve } from "node:path"

import pinned from "../keeper.json"
import { type HeldLease, holdsLease, LeaseNotHeld } from "./operation"
import { download } from "./shell"
import { dataDir } from "./xdg"

type Env = Readonly<Record<string, string | undefined>>

export interface KeeperPin {
  readonly version: string
  readonly url: string
  readonly sha256: string
}

export type KeeperSource = "override" | "app" | "cache"

export interface FoundKeeper {
  readonly path: string
  readonly source: KeeperSource
}

export const KEEPER_BINARY = "winvm-keeper"
export const KEEPER_PREFIX = "co.stuffbucket.winvm.keeper."
export const KEEPER_EXIT_TIMEOUT = 60
export const KEEPER_PROTOCOL = 2
const APP_BUNDLE_ID = "co.stuffbucket.winvm"
const HASH_DIR = /^[0-9a-f]{12}$/

export function keeperPin(
  raw: {
    readonly version: string | null
    readonly url: string | null
    readonly sha256: string | null
  } = pinned,
): KeeperPin | null {
  const { version, url, sha256 } = raw
  return version === null || url === null || sha256 === null
    ? null
    : { version, url, sha256 }
}

export const keeperCache = (env: Env = process.env): string =>
  resolve(dataDir(env), "keeper-pinned")

export const keeperRoot = (env: Env = process.env): string =>
  resolve(dataDir(env), "keeper")

const isFile = (path: string): boolean => existsSync(path)

function appKeeper(execPath: string): string | null {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  if (m === null) return null
  const path = resolve(m[1] ?? "", "Contents", "MacOS", KEEPER_BINARY)
  return isFile(path) ? path : null
}

export interface FindKeeperOptions {
  readonly env?: Env
  readonly execPath?: string
  readonly cache?: string
  readonly pin?: KeeperPin | null
}

export function findKeeper(o: FindKeeperOptions = {}): FoundKeeper | null {
  const env = o.env ?? process.env
  const override = env.WINVM_KEEPER
  if (override !== undefined && override !== "")
    return { path: resolve(override), source: "override" }
  const app = appKeeper(o.execPath ?? process.execPath)
  if (app !== null) return { path: app, source: "app" }
  const pin = o.pin === undefined ? keeperPin() : o.pin
  if (pin === null) return null
  const cached = resolve(
    o.cache ?? keeperCache(env),
    pin.version,
    KEEPER_BINARY,
  )
  return isFile(cached) && sha256File(cached) === pin.sha256
    ? { path: cached, source: "cache" }
    : null
}

export function ensureKeeper(
  o: { readonly pin?: KeeperPin | null; readonly cache?: string } = {},
): FoundKeeper | null {
  const pin = o.pin === undefined ? keeperPin() : o.pin
  if (pin === null) return null
  const path = resolve(o.cache ?? keeperCache(), pin.version, KEEPER_BINARY)
  if (isFile(path) && sha256File(path) === pin.sha256)
    return { path, source: "cache" }
  const partial = `${path}.${String(process.pid)}.partial`
  try {
    download(pin.url, partial, pin.sha256)
    chmodSync(partial, 0o755)
    renameSync(partial, path)
  } finally {
    rmSync(partial, { force: true })
  }
  return { path, source: "cache" }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function installKeeper(binary: string, root: string): string {
  const dir = resolve(root, sha256File(binary).slice(0, 12))
  const dest = resolve(dir, KEEPER_BINARY)
  if (isFile(dest)) return dest
  mkdirSync(dir, { recursive: true })
  const scratch = resolve(dir, `.${KEEPER_BINARY}.${String(process.pid)}`)
  copyFileSync(binary, scratch, constants.COPYFILE_FICLONE)
  chmodSync(scratch, 0o755)
  renameSync(scratch, dest)
  return dest
}

export interface JobInfo {
  readonly state: string
  readonly pid: number | null
  readonly lastExit: number | null
  readonly program: string | null
  readonly runs: number
}

export interface Launchd {
  bootstrap(plist: string): void
  bootout(label: string): boolean
  print(label: string): JobInfo | null
  labels(prefix: string): readonly string[] | null
}

export function collectKeepers(o: {
  readonly root: string
  readonly launchd: Launchd
  readonly current: string | null
}): readonly string[] {
  const keep = new Set<string>()
  if (o.current !== null) keep.add(dirname(o.current))
  const labels = o.launchd.labels(KEEPER_PREFIX)
  if (labels === null) return []
  for (const label of labels) {
    const program = o.launchd.print(label)?.program
    if (program === null || program === undefined) return []
    keep.add(dirname(program))
  }
  if (!existsSync(o.root)) return []
  const removed: string[] = []
  for (const name of readdirSync(o.root)) {
    const dir = resolve(o.root, name)
    if (!HASH_DIR.test(name) || keep.has(dir)) continue
    rmSync(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  return removed
}

export function keeperLabel(home: string, instance: string): string {
  const home8 = createHash("sha256").update(resolve(home)).digest("hex")
  return `${KEEPER_PREFIX}${home8.slice(0, 8)}.${instance}`
}

type PlistValue =
  | string
  | number
  | boolean
  | readonly string[]
  | { readonly [key: string]: PlistValue }

export interface KeeperJob {
  readonly [key: string]: PlistValue
  readonly Label: string
  readonly ProgramArguments: readonly string[]
  readonly LimitLoadToSessionType: "Background"
  readonly ProcessType: "Interactive"
  readonly ExitTimeOut: number
  readonly RunAtLoad: true
  readonly KeepAlive: { readonly SuccessfulExit: false }
  readonly ThrottleInterval: number
  readonly AbandonProcessGroup: true
  readonly AssociatedBundleIdentifiers: readonly string[]
  readonly WorkingDirectory: string
  readonly StandardOutPath: string
  readonly StandardErrorPath: string
  readonly Umask: number
}

export function keeperJob(o: {
  readonly label: string
  readonly program: string
  readonly dir: string
  readonly exitTimeout?: number
}): KeeperJob {
  const exitTimeout = o.exitTimeout ?? KEEPER_EXIT_TIMEOUT
  const log = resolve(o.dir, "keeper.log")
  return {
    Label: o.label,
    ProgramArguments: [
      o.program,
      "run",
      "--dir",
      o.dir,
      "--exit-timeout",
      String(exitTimeout),
    ],
    LimitLoadToSessionType: "Background",
    ProcessType: "Interactive",
    ExitTimeOut: exitTimeout,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 2,
    AbandonProcessGroup: true,
    AssociatedBundleIdentifiers: [APP_BUNDLE_ID],
    WorkingDirectory: o.dir,
    StandardOutPath: log,
    StandardErrorPath: log,
    Umask: 0o077,
  }
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function plistLines(value: PlistValue, depth: number): string[] {
  const pad = "\t".repeat(depth)
  if (typeof value === "string")
    return [`${pad}<string>${escapeXml(value)}</string>`]
  if (typeof value === "number")
    return [`${pad}<integer>${String(value)}</integer>`]
  if (typeof value === "boolean") return [`${pad}<${String(value)}/>`]
  if (Array.isArray(value))
    return [
      `${pad}<array>`,
      ...value.flatMap((item: string) => plistLines(item, depth + 1)),
      `${pad}</array>`,
    ]
  return [
    `${pad}<dict>`,
    ...Object.entries(value).flatMap(([key, item]) => [
      `${pad}\t<key>${escapeXml(key)}</key>`,
      ...plistLines(item, depth + 1),
    ]),
    `${pad}</dict>`,
  ]
}

export function plistXml(dict: { readonly [key: string]: PlistValue }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    ...plistLines(dict, 0),
    "</plist>",
    "",
  ].join("\n")
}

export interface KeeperCommand {
  readonly argv: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly log?: string
  readonly shield?: boolean
  readonly umask?: number
}

export interface KeeperChild extends KeeperCommand {
  readonly name?: string
  readonly pidfile?: string
  readonly qmp?: string
}

export interface KeeperSpec {
  readonly record?: string
  readonly lingerMs?: number
  readonly child?: KeeperChild
  readonly stop?: KeeperCommand
}

export type StartedKeeper =
  | { readonly state: "started"; readonly plist: string }
  | { readonly state: "running"; readonly hello: Record<string, unknown> }

export class KeeperBusy extends Error {}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export async function startKeeper(o: {
  readonly launchd: Launchd
  readonly job: KeeperJob
  readonly lease: HeldLease
  readonly spec?: KeeperSpec
}): Promise<StartedKeeper> {
  if (!holdsLease(o.lease))
    throw new LeaseNotHeld(o.lease.instance, `starting ${o.job.Label}`)
  const dir = o.job.WorkingDirectory
  const hello = await keeperRequest(
    resolve(dir, "keeper.sock"),
    { op: "hello" },
    1000,
  ).catch(() => null)
  if (hello !== null && hello.hostEnding === true)
    throw new KeeperBusy(
      `the keeper for ${o.job.Label} is shutting down; start again once it has exited`,
    )
  if (hello !== null) return { state: "running", hello }
  if (o.launchd.print(o.job.Label)?.state === "running")
    throw new KeeperBusy(
      `the keeper for ${o.job.Label} is running but does not answer; see ${resolve(dir, "keeper.log")}`,
    )
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  writePrivate(
    resolve(dir, "spec.json"),
    `${JSON.stringify({ ...o.spec, instance: o.lease.instance, session: randomUUID() })}\n`,
  )
  const plist = resolve(dir, "keeper.plist")
  writePrivate(plist, plistXml(o.job))
  o.launchd.bootout(o.job.Label)
  o.launchd.bootstrap(plist)
  return { state: "started", plist }
}

const numberOrNull = (text: string | undefined): number | null =>
  text !== undefined && /^-?\d+$/.test(text) ? Number(text) : null

export function parseJobPrint(text: string): JobInfo {
  const fields = new Map<string, string>()
  for (const line of text.split("\n")) {
    const m = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined && !fields.has(m[1]))
      fields.set(m[1], m[2].trim())
  }
  return {
    state: fields.get("state") ?? "unknown",
    pid: numberOrNull(fields.get("pid")),
    lastExit: numberOrNull(fields.get("last exit code")),
    program: fields.get("program") ?? null,
    runs: numberOrNull(fields.get("runs")) ?? 0,
  }
}

const userDomain = (uid: number): string => `user/${String(uid)}`

function launchctlRun(args: readonly string[]): {
  readonly ok: boolean
  readonly out: string
} {
  const r = spawnSync("launchctl", [...args], { encoding: "utf8" })
  return {
    ok: r.status === 0,
    out: r.error === undefined ? `${r.stdout}${r.stderr}` : r.error.message,
  }
}

export function launchctl(uid: number = process.getuid?.() ?? 0): Launchd {
  const domain = userDomain(uid)
  return {
    bootstrap: (plist) => {
      const r = launchctlRun(["bootstrap", domain, plist])
      if (!r.ok)
        throw new Error(
          `launchctl bootstrap ${domain} ${basename(plist)}: ${r.out.trim()}`,
        )
    },
    bootout: (label) => launchctlRun(["bootout", `${domain}/${label}`]).ok,
    print: (label) => {
      const r = launchctlRun(["print", `${domain}/${label}`])
      return r.ok ? parseJobPrint(r.out) : null
    },
    labels: (prefix) => {
      const r = launchctlRun(["print", domain])
      if (!r.ok) return null
      return r.out
        .split("\n")
        .map((line) => /^\t\t\s*\S+\s+\S+\s+(\S+)$/.exec(line)?.[1])
        .filter((label): label is string => label?.startsWith(prefix) === true)
    },
  }
}

export function keeperRequest(
  socket: string,
  message: Readonly<Record<string, unknown>>,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    let answer = ""
    const stream = connect(socket)
    const timer = setTimeout(() => {
      stream.destroy()
      fail(new Error(`${socket}: no answer within ${String(timeoutMs)} ms`))
    }, timeoutMs)
    stream.setEncoding("utf8")
    stream.on("connect", () =>
      stream.write(
        `${JSON.stringify({ ...message, protocol: KEEPER_PROTOCOL })}\n`,
      ),
    )
    stream.on("close", () => {
      clearTimeout(timer)
      fail(
        new Error(
          `${socket}: the keeper closed the connection without an answer`,
        ),
      )
    })
    stream.on("data", (chunk: string) => {
      answer += chunk
      const end = answer.indexOf("\n")
      if (end < 0) return
      clearTimeout(timer)
      stream.destroy()
      try {
        done(JSON.parse(answer.slice(0, end)) as Record<string, unknown>)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    stream.on("error", (error) => {
      clearTimeout(timer)
      fail(error)
    })
  })
}
