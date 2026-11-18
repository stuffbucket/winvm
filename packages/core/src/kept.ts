import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { readSince, START } from "./eventlog"
import {
  collectKeepers,
  type FoundKeeper,
  findKeeper,
  installKeeper,
  KEEPER_DIR,
  KEEPER_PROTOCOL,
  KeeperBusy,
  type KeeperChild,
  type KeeperSpec,
  keeperJob,
  keeperLabel,
  keeperRequest,
  keeperRoot,
  type Launchd,
  launchctl,
  startKeeper,
} from "./keeper"
import { heldLease, LeaseNotHeld } from "./operation"
import { home, type Paths } from "./paths"

type Env = Readonly<Record<string, string | undefined>>

export const KEEPER_OFF = "off"

export type KeeperUse =
  | { readonly kind: "keeper"; readonly keeper: FoundKeeper }
  | { readonly kind: "off" }
  | { readonly kind: "missing" }

export function keeperUse(
  env: Env = process.env,
  find: (o: { readonly env: Env }) => FoundKeeper | null = findKeeper,
): KeeperUse {
  if (env.WINVM_KEEPER === KEEPER_OFF) return { kind: "off" }
  const keeper = find({ env })
  return keeper === null ? { kind: "missing" } : { kind: "keeper", keeper }
}

export function callerUmask(): number {
  const mask = process.umask(0o077)
  process.umask(mask)
  return mask
}

export const keeperDir = (p: Paths): string => resolve(p.dir, KEEPER_DIR)
export const keeperSocket = (p: Paths): string =>
  resolve(keeperDir(p), "keeper.sock")
export const keeperMonitor = (p: Paths): string =>
  resolve(keeperDir(p), "qmp.sock")
export const keeperPlist = (p: Paths): string =>
  resolve(keeperDir(p), "keeper.plist")

let launchdOf: () => Launchd = () => launchctl()

export function setLaunchd(
  next: () => Launchd = () => launchctl(),
): () => Launchd {
  const previous = launchdOf
  launchdOf = next
  return previous
}

export interface KeptProcess {
  readonly name: string
  readonly pid: number
  readonly adopted: boolean
  readonly legacy: boolean
  readonly runtime: string | null
}

export interface KeptService {
  readonly pid: number
  readonly build: string
  readonly adopted: boolean
}

export interface KeeperHello {
  readonly pid: number
  readonly protocol: number
  readonly version: string
  readonly child: KeptProcess | null
  readonly sidecars: readonly KeptProcess[]
  readonly service: KeptService | null
  readonly hostEnding: boolean
}

function keptProcess(raw: unknown): KeptProcess | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  return typeof r.pid === "number" && typeof r.name === "string"
    ? {
        name: r.name,
        pid: r.pid,
        adopted: r.adopted === true,
        legacy: r.legacy === true,
        runtime: typeof r.runtime === "string" ? r.runtime : null,
      }
    : null
}

function keptService(raw: unknown): KeptService | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  return typeof r.pid === "number"
    ? {
        pid: r.pid,
        build: typeof r.build === "string" ? r.build : "",
        adopted: r.adopted === true,
      }
    : null
}

export function parseHello(raw: Record<string, unknown>): KeeperHello | null {
  if (raw.ok !== true || typeof raw.pid !== "number") return null
  return {
    pid: raw.pid,
    protocol: typeof raw.protocol === "number" ? raw.protocol : 0,
    version: typeof raw.version === "string" ? raw.version : "?",
    child: keptProcess(raw.child),
    sidecars: Array.isArray(raw.sidecars)
      ? raw.sidecars
          .map(keptProcess)
          .filter((k): k is KeptProcess => k !== null)
      : [],
    service: keptService(raw.service),
    hostEnding: raw.hostEnding === true,
  }
}

export async function launchedRuntime(
  p: Paths,
  pid: number,
): Promise<string | null> {
  const child = (await keeperHello(p))?.child ?? null
  return child?.pid === pid ? child.runtime : null
}

const PASSED_ENV: ReadonlySet<string> = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "LANG",
])

export const keptEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined &&
        (PASSED_ENV.has(e[0]) ||
          e[0].startsWith("LC_") ||
          e[0].startsWith("XDG_") ||
          e[0].startsWith("WINVM_")),
    ),
  )

export async function keeperHello(
  p: Paths,
  o: { readonly timeoutMs?: number; readonly launching?: true } = {},
): Promise<KeeperHello | null> {
  if (!existsSync(keeperSocket(p))) return null
  try {
    return parseHello(
      await keeperRequest(
        keeperSocket(p),
        o.launching === true
          ? { op: "hello", launching: true }
          : { op: "hello" },
        o.timeoutMs ?? 1000,
      ),
    )
  } catch {
    return null
  }
}

export class KeeperRefused extends Error {
  constructor(op: string, reason: string) {
    super(`winvm's keeper refused ${op}: ${reason}`)
    this.name = "KeeperRefused"
  }
}

async function ask(
  p: Paths,
  message: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const answer = await keeperRequest(keeperSocket(p), message)
  if (answer.ok !== true)
    throw new KeeperRefused(
      String(message.op),
      typeof answer.error === "string" ? answer.error : "no reason given",
    )
  return answer
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

const OPEN_MS = 5000

async function untilGone(p: Paths, deadline: number): Promise<boolean> {
  while (Date.now() <= deadline) {
    if ((await keeperHello(p, { timeoutMs: 300 })) === null) return true
    await sleep(100)
  }
  return false
}

export async function openKeeper(
  name: string,
  p: Paths,
  keeper: FoundKeeper,
  extra: Pick<KeeperSpec, "adopt"> = {},
): Promise<KeeperHello> {
  const lease = heldLease(name)
  if (lease === null)
    throw new LeaseNotHeld(name, "launching QEMU through winvm's keeper")
  const program = installKeeper(keeper.path, keeperRoot())
  const launchd = launchdOf()
  const job = keeperJob({
    label: keeperLabel(home(), name),
    program,
    dir: keeperDir(p),
  })
  let deadline = Date.now() + OPEN_MS
  let retired = false
  for (;;) {
    for (;;) {
      try {
        await startKeeper({
          launchd,
          job,
          lease,
          spec: { record: p.events, ...extra },
        })
        break
      } catch (error) {
        if (!(error instanceof KeeperBusy) || Date.now() > deadline) throw error
        await sleep(200)
      }
    }
    try {
      collectKeepers({ root: keeperRoot(), launchd, current: program })
    } catch (error) {
      console.warn(
        `warning: could not clean up old keeper versions: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    for (;;) {
      const hello = await keeperHello(p, { launching: true })
      if (hello !== null && hello.protocol >= KEEPER_PROTOCOL) return hello
      if (hello !== null && hello.child === null && !retired) {
        retired = true
        deadline = Date.now() + OPEN_MS
        await keeperRequest(keeperSocket(p), { op: "exit-when-idle" }).catch(
          () => null,
        )
        if (await untilGone(p, deadline)) break
      }
      if (hello !== null)
        throw new Error(
          `the keeper running for "${name}" speaks protocol ${String(hello.protocol)}, older than this winvm's ${String(KEEPER_PROTOCOL)}; it exits once its VM is stopped`,
        )
      if (Date.now() > deadline)
        throw new Error(
          `the keeper for "${name}" did not answer on ${keeperSocket(p)} — see ${resolve(keeperDir(p), "keeper.log")}`,
        )
      await sleep(100)
    }
  }
}

export async function untilChildGone(
  p: Paths,
  timeoutMs: number,
): Promise<KeptProcess | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const child = (await keeperHello(p, { launching: true }))?.child ?? null
    if (child === null || Date.now() > deadline) return child
    await sleep(50)
  }
}

export async function launchSidecar(
  p: Paths,
  child: KeeperChild & { readonly name: string },
): Promise<number> {
  return Number((await ask(p, { op: "launch-sidecar", child })).pid)
}

export async function launchChild(
  p: Paths,
  child: KeeperChild & { readonly name: string },
): Promise<number> {
  return Number((await ask(p, { op: "launch", child })).pid)
}

export async function killKept(p: Paths, pid: number | null): Promise<boolean> {
  const hello = await keeperHello(p)
  if (hello === null) return false
  if (pid !== null && hello.child?.pid !== pid) return false
  const answer = await keeperRequest(keeperSocket(p), { op: "kill" }).catch(
    () => null,
  )
  return answer?.ok === true
}

export const UNAVAILABLE = "keeper-unavailable"

export function keeperFallback(
  name: string,
): { readonly at: string; readonly error: string } | null {
  let found = null as { readonly at: string; readonly error: string } | null
  for (const e of readSince(name, START).entries) {
    if (e.kind === "warning" && e.what === UNAVAILABLE)
      found = {
        at: e.t,
        error: typeof e.error === "string" ? e.error : "no reason given",
      }
    else if (e.kind === "keeper" && e.what === "launched" && e.child === "qemu")
      found = null
  }
  return found
}

export function retireKeeper(name: string, p: Paths): void {
  if (!existsSync(keeperPlist(p))) return
  launchdOf().bootout(keeperLabel(home(), name))
}

export type Protection =
  | "kept"
  | "adopted"
  | "legacy"
  | "broken"
  | "off"
  | "missing"

export interface KeeperStanding {
  readonly protection: Protection
  readonly version: string | null
  readonly pid: number | null
  readonly fallback?: string
  readonly recallable?: boolean
  readonly runningQemu?: string
  readonly installedQemu?: string
}

export function keeperStanding(
  qemuPid: number | null,
  hello: KeeperHello | null,
  use: KeeperUse["kind"],
): KeeperStanding | null {
  const child = hello?.child ?? null
  const of = (protection: Protection): KeeperStanding => ({
    protection,
    version: hello?.version ?? null,
    pid: hello?.pid ?? null,
  })
  if (qemuPid === null) return child === null ? null : of("broken")
  if (child?.pid === qemuPid) return of(child.legacy ? "adopted" : "kept")
  if (child !== null) return of("broken")
  return of(use === "keeper" ? "legacy" : use)
}
