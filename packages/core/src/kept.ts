import { existsSync } from "node:fs"
import { resolve } from "node:path"

import {
  collectKeepers,
  type FoundKeeper,
  findKeeper,
  installKeeper,
  KEEPER_PROTOCOL,
  KeeperBusy,
  type KeeperChild,
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

export const keeperDir = (p: Paths): string => resolve(p.dir, "keeper")
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
}

export interface KeeperHello {
  readonly pid: number
  readonly protocol: number
  readonly version: string
  readonly child: KeptProcess | null
  readonly sidecars: readonly KeptProcess[]
  readonly hostEnding: boolean
}

function keptProcess(raw: unknown): KeptProcess | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  return typeof r.pid === "number" && typeof r.name === "string"
    ? { name: r.name, pid: r.pid, adopted: r.adopted === true }
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
    hostEnding: raw.hostEnding === true,
  }
}

export async function keeperHello(
  p: Paths,
  timeoutMs = 1000,
): Promise<KeeperHello | null> {
  if (!existsSync(keeperSocket(p))) return null
  try {
    return parseHello(
      await keeperRequest(keeperSocket(p), { op: "hello" }, timeoutMs),
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

export async function openKeeper(
  name: string,
  p: Paths,
  keeper: FoundKeeper,
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
  const deadline = Date.now() + OPEN_MS
  for (;;) {
    try {
      await startKeeper({ launchd, job, lease, spec: { record: p.events } })
      break
    } catch (error) {
      if (!(error instanceof KeeperBusy) || Date.now() > deadline) throw error
      await sleep(200)
    }
  }
  try {
    collectKeepers({ root: keeperRoot(), launchd, current: program })
  } catch {}
  for (;;) {
    const hello = await keeperHello(p)
    if (hello !== null && hello.protocol >= KEEPER_PROTOCOL) return hello
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

export async function untilChildGone(
  p: Paths,
  timeoutMs: number,
): Promise<KeptProcess | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const child = (await keeperHello(p))?.child ?? null
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

export function retireKeeper(name: string, p: Paths): void {
  if (!existsSync(keeperPlist(p))) return
  launchdOf().bootout(keeperLabel(home(), name))
}

export type Protection = "kept" | "legacy" | "broken" | "off" | "missing"

export interface KeeperStanding {
  readonly protection: Protection
  readonly version: string | null
  readonly pid: number | null
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
  if (child?.pid === qemuPid) return of("kept")
  if (child !== null) return of("broken")
  return of(use === "keeper" ? "legacy" : use)
}
