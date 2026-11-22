import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { buildIdentity } from "./identity"
import {
  KeeperMissing,
  type KeeperUse,
  keeperHello,
  keeperUse,
  openKeeper,
} from "./kept"
import {
  InstanceBusy,
  leaseable,
  leaseHolder,
  type VmOperation,
  withOperation,
} from "./operation"
import { cliEntry, type Paths, pathsFor } from "./paths"
import { pidOf as qemuPid } from "./qemu"
import { ensureService, readService } from "./servicectl"

export class ManagementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ManagementError"
  }
}

export type ReconcileResult = {
  readonly changed: boolean
  readonly servicePid: number | null
  readonly deferred?: "busy"
  readonly adopted?: true
}

export interface ReconcileOptions {
  readonly current?: string
  readonly startService?: () => void
  readonly serviceTimeoutMs?: number
  readonly wait?: boolean
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

type Standing = "current" | "rotate" | "foreign"

function standing(
  build: string | undefined,
  cli: string | undefined,
  current: string,
  mine: string,
): Standing {
  if (build === undefined || build === "") return "rotate"
  if (build === current) return "current"
  return cli !== undefined && cli !== "" && cli !== mine ? "foreign" : "rotate"
}

function serviceDue(p: Paths, current: string, orphan: number | null): boolean {
  if (!existsSync(p.qmpQemu)) return false
  const service = readService(p)
  return (
    service === null ||
    service.pid === orphan ||
    standing(service.build, service.cli, current, cliEntry()) === "rotate"
  )
}

export const needsRepair = (
  name: string,
  p: Paths = pathsFor(name),
  current: string = buildIdentity(),
): boolean => qemuPid(p) !== null && serviceDue(p, current, null)

export type Adoption = "adopted" | "kept" | "none" | "busy"

async function adoptHeld(
  name: string,
  p: Paths,
  use: Extract<KeeperUse, { readonly kind: "keeper" }>,
  pid: number,
): Promise<Adoption> {
  if (qemuPid(p) !== pid || (await keeperHello(p)) !== null) return "none"
  const hello = await openKeeper(name, p, use.keeper, {
    adopt: { name: "qemu", pidfile: p.pid, qmp: p.qmp },
  })
  if (hello.child?.pid !== pid) return "none"
  await ensureService(name, p)
  return "adopted"
}

const reconcileLease = (
  wait: boolean,
): { automatic: true; queue?: true; waitMs: number } =>
  wait
    ? { automatic: true, queue: true, waitMs: Number.POSITIVE_INFINITY }
    : { automatic: true, waitMs: 0 }

export async function adoptLegacy(
  name: string,
  p: Paths = pathsFor(name),
  use: KeeperUse = keeperUse(),
  wait = false,
): Promise<Adoption> {
  if (use.kind !== "keeper") return "none"
  const pid = qemuPid(p)
  if (pid === null) return "none"
  const hello = await keeperHello(p)
  if (hello !== null) return hello.child?.pid === pid ? "kept" : "none"
  try {
    return await withOperation(
      name,
      "reconcile",
      async () => await adoptHeld(name, p, use, pid),
      reconcileLease(wait),
    )
  } catch (error) {
    if (error instanceof InstanceBusy) return "busy"
    throw error
  }
}

async function adopted(
  name: string,
  p: Paths,
  wait: boolean,
): Promise<boolean> {
  try {
    return (await adoptLegacy(name, p, keeperUse(), wait)) === "adopted"
  } catch (error) {
    console.error(
      `note: winvm's keeper could not take over Windows on "${name}" (${errText(error)}); it keeps running as it was`,
    )
    return false
  }
}

export async function ensureCurrent(
  name: string,
  p: Paths = pathsFor(name),
  o: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (qemuPid(p) === null) return { changed: false, servicePid: null }
  if (await adopted(name, p, o.wait === true)) {
    const r = await ensureCurrent(name, p, o)
    return { ...r, adopted: true }
  }
  const current = o.current ?? buildIdentity()
  const now = (): number | null => readService(p)?.pid ?? null
  const kept = (await keeperHello(p))?.service ?? null
  if (!serviceDue(p, current, kept?.adopted === true ? kept.pid : null))
    return { changed: false, servicePid: now() }
  try {
    return await withOperation(
      name,
      "reconcile",
      async (): Promise<ReconcileResult> => {
        if (qemuPid(p) === null) return { changed: false, servicePid: now() }
        await ensureService(name, p, {
          current,
          ...(o.startService === undefined ? {} : { start: o.startService }),
          ...(o.serviceTimeoutMs === undefined
            ? {}
            : { timeoutMs: o.serviceTimeoutMs }),
        })
        return { changed: true, servicePid: now() }
      },
      reconcileLease(o.wait === true),
    )
  } catch (error) {
    if (error instanceof InstanceBusy)
      return { changed: false, servicePid: now(), deferred: "busy" }
    throw new ManagementError(
      `could not start a current control service for "${name}": ${errText(error)}. ` +
        `Windows is still running; run the command again to retry (see ${resolve(p.dir, "service.log")})`,
      { cause: error },
    )
  }
}

export async function serviceUp(
  name: string,
  op: VmOperation,
  wait: boolean,
  p: Paths = pathsFor(name),
): Promise<void> {
  if (qemuPid(p) !== null) {
    const r = await ensureCurrent(name, p, { wait })
    const holder = r.deferred === "busy" ? leaseHolder(name) : null
    if (holder !== null) throw new InstanceBusy(name, holder)
    return
  }
  const use = keeperUse()
  if (use.kind === "missing")
    throw new KeeperMissing(`winvm's service for "${name}" was not started`)
  await withOperation(
    name,
    leaseable(name, "reconcile") ? "reconcile" : op,
    async () => {
      await openKeeper(name, p, use.keeper)
      await ensureService(name, p)
    },
    wait ? { queue: true, waitMs: Number.POSITIVE_INFINITY } : {},
  )
}
