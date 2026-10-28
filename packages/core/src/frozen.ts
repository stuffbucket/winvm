/**
 * A guest whose vCPUs are stopped, and why: PAUSED (`winvm pause`, or a save
 * taken while paused) or ASLEEP (`winvm sleep`). Both need an explicit resume or
 * wake; nothing else in winvm may `cont` such a guest, call into it, or count
 * the time it is frozen as idle.
 *
 * WHY "ASLEEP" IS A MARK, NOT A QEMU STATE. This guest has no ACPI sleep: on
 * QEMU's aarch64 `virt` machine `query-current-machine` says
 * `wakeup-suspend-support: false`, and Windows' `powercfg /a` lists no S1-S3 or
 * S0 low power idle. So sleep is Windows locked, then the vCPUs stopped, with a
 * mark beside the instance (`asleep.json`, naming the QEMU process it applies
 * to) that tells status, the app and the watcher it is asleep rather than paused.
 *
 * WHICH RUN STATES ARE FROZEN. "paused" (stop), "suspended" (an ACPI sleep, were
 * there one), and "postmigrate": a save of a paused guest leaves QEMU there, its
 * vCPUs still stopped — before this it was reported as running.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Paths } from "./paths"
import { pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qmp from "./qmp"

export type Frozen = "paused" | "asleep"

const FROZEN_RUN_STATES: ReadonlySet<string> = new Set(["paused", "suspended", "postmigrate"])

/** Whether QEMU's run state has the vCPUs stopped where only a resume starts them again. */
export const isFrozenRunState = (vmStatus: string | null): boolean => vmStatus !== null && FROZEN_RUN_STATES.has(vmStatus)

export const asleepPath = (p: Paths): string => resolve(p.dir, "asleep.json")

/** Mark the guest of QEMU process `pid` asleep. */
export function markAsleep(p: Paths, pid: number, now = new Date()): void {
  writeFileSync(asleepPath(p), `${JSON.stringify({ pid, since: now.toISOString() })}\n`)
}

export function clearAsleep(p: Paths): void {
  rmSync(asleepPath(p), { force: true })
}

/** Whether the mark is there for QEMU process `pid` (one left by an earlier QEMU means nothing). */
export function markedAsleep(p: Paths, pid: number | null): boolean {
  if (pid === null) return false
  try {
    return (JSON.parse(readFileSync(asleepPath(p), "utf8")) as { pid?: unknown }).pid === pid
  } catch {
    return false
  }
}

/** Paused or asleep from QEMU's run state and the mark; null when it runs (or the state is unknown). */
export const frozenFrom = (vmStatus: string | null, asleep: boolean): Frozen | null =>
  isFrozenRunState(vmStatus) ? (asleep ? "asleep" : "paused") : null

/** Asks QEMU. Null when it runs, is not running at all, or its monitor did not answer in time. */
export async function frozenState(p: Paths, timeoutMs = 3000): Promise<Frozen | null> {
  const pid = qemu.pidOf(p)
  if (pid === null) return null
  let vmStatus: string | null = null
  try {
    const r = (await qmp.execute(p.qmp, "query-status", undefined, timeoutMs)) as { status?: unknown } | undefined
    vmStatus = typeof r?.status === "string" ? r.status : null
  } catch {
    return null
  }
  return frozenFrom(vmStatus, markedAsleep(p, pid))
}

/** Refused because the guest is paused or asleep: it cannot answer, and only the user may wake it. */
export class GuestFrozen extends Error {
  readonly state: Frozen
  constructor(name: string, state: Frozen) {
    super(
      state === "asleep"
        ? `instance "${name}" is asleep — wake it first (\`winvm wake -i ${name}\`)`
        : `instance "${name}" is paused — resume it first (\`winvm resume -i ${name}\`)`,
    )
    this.state = state
  }
}

/** Throws GuestFrozen when `name`'s guest is paused or asleep. */
export async function refuseFrozen(name: string): Promise<void> {
  const f = await frozenState(pathsFor(name))
  if (f !== null) throw new GuestFrozen(name, f)
}
