import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Paths } from "./paths"
import { pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qmp from "./qmp"

export type Frozen = "paused" | "asleep"

const FROZEN_RUN_STATES: ReadonlySet<string> = new Set([
  "paused",
  "suspended",
  "postmigrate",
])

export const isFrozenRunState = (vmStatus: string | null): boolean =>
  vmStatus !== null && FROZEN_RUN_STATES.has(vmStatus)

export const asleepPath = (p: Paths): string => resolve(p.dir, "asleep.json")

export function markAsleep(p: Paths, pid: number, now = new Date()): void {
  writeFileSync(
    asleepPath(p),
    `${JSON.stringify({ pid, since: now.toISOString() })}\n`,
  )
}

export function clearAsleep(p: Paths): void {
  rmSync(asleepPath(p), { force: true })
}

export function markedAsleep(p: Paths, pid: number | null): boolean {
  if (pid === null) return false
  try {
    return (
      (JSON.parse(readFileSync(asleepPath(p), "utf8")) as { pid?: unknown })
        .pid === pid
    )
  } catch {
    return false
  }
}

export const frozenFrom = (
  vmStatus: string | null,
  asleep: boolean,
): Frozen | null =>
  isFrozenRunState(vmStatus) ? (asleep ? "asleep" : "paused") : null

export async function frozenState(
  p: Paths,
  timeoutMs = 3000,
): Promise<Frozen | null> {
  const pid = qemu.pidOf(p)
  if (pid === null) return null
  let vmStatus: string | null = null
  try {
    const r = (await qmp.execute(
      p.qmp,
      "query-status",
      undefined,
      timeoutMs,
    )) as { status?: unknown } | undefined
    vmStatus = typeof r?.status === "string" ? r.status : null
  } catch {
    return null
  }
  return frozenFrom(vmStatus, markedAsleep(p, pid))
}

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

export async function refuseFrozen(name: string): Promise<void> {
  const f = await frozenState(pathsFor(name))
  if (f !== null) throw new GuestFrozen(name, f)
}
