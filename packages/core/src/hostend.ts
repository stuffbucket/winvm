import { statfsSync } from "node:fs"

import { effectiveConfig, type HostEndAction } from "./config"
import { runningCommand } from "./display"
import { appendEntry } from "./eventlog"
import { keeperRequest } from "./keeper"
import { keeperSocket } from "./kept"
import { irreversibleSince, leaseHolder, withOperation } from "./operation"
import { pathsFor, readImageMeta, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as qmp from "./qmp"
import * as saves from "./saves"
import { spawnText } from "./shell"

const GIB = 1024 ** 3
const POLL_MS = 250
const SAVE_RESERVE_MS = 15_000
const RELEASE_MS = 10_000

export interface Busy {
  readonly operation: string
  readonly automatic: boolean
  readonly irreversible: boolean
}

export interface HostEndFacts {
  readonly action: HostEndAction
  readonly ephemeral: boolean
  readonly installMedia: boolean
  readonly unsaveable: string | null
  readonly freeBytes: number | null
  readonly needBytes: number | null
  readonly busy: Busy | null
}

export type HostEndThen = "stow" | "shutdown" | "quit"

export interface HostEndPlan {
  readonly first: "none" | "wait" | "cancel"
  readonly end: HostEndThen
  readonly reason: string | null
}

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`

function firstStep(b: Busy | null): HostEndPlan["first"] {
  if (b === null) return "none"
  return b.automatic && b.operation === "save" ? "cancel" : "wait"
}

function lastStep(f: HostEndFacts): Pick<HostEndPlan, "end" | "reason"> {
  if (f.ephemeral)
    return {
      end: "quit",
      reason: "the guest runs with -snapshot, so its disk changes are not kept",
    }
  if (f.installMedia)
    return { end: "quit", reason: "the guest is running an installer" }
  if (f.busy?.operation === "stop" && f.busy.irreversible)
    return {
      end: "shutdown",
      reason: "a stop already asked Windows to shut down",
    }
  if (f.action === "shutdown")
    return { end: "shutdown", reason: "hostEnd.action is shutdown" }
  if (f.unsaveable !== null) return { end: "shutdown", reason: f.unsaveable }
  if (f.freeBytes !== null && f.needBytes !== null && f.freeBytes < f.needBytes)
    return {
      end: "shutdown",
      reason: `a stow needs ${gib(f.needBytes)} free and the disk has ${gib(f.freeBytes)} free`,
    }
  return { end: "stow", reason: null }
}

export function hostEndPlan(f: HostEndFacts): HostEndPlan {
  return { first: firstStep(f.busy), ...lastStep(f) }
}

export type HostEndOutcome = "stowed" | "ended-by-op" | "handed-back"

export interface HostEndSeams {
  readonly facts: () => HostEndFacts
  readonly running: () => boolean
  readonly busy: () => Busy | null
  readonly cancel: () => Promise<void>
  readonly stow: () => Promise<void>
  readonly handBack: (end: "shutdown" | "quit", reason: string) => Promise<void>
  readonly note: (fields: Readonly<Record<string, unknown>>) => void
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

async function until(
  s: HostEndSeams,
  done: () => boolean,
  by: number,
): Promise<boolean> {
  while (!done()) {
    if (s.now() >= by) return false
    await s.sleep(POLL_MS)
  }
  return true
}

async function clear(
  s: HostEndSeams,
  plan: HostEndPlan,
  deadlineMs: number,
): Promise<void> {
  const free = (): boolean => s.busy() === null || !s.running()
  const cancelled = async (): Promise<void> => {
    await s.cancel().catch(() => undefined)
    await until(s, free, Math.min(deadlineMs, s.now() + RELEASE_MS))
  }
  if (plan.first === "cancel") {
    await cancelled()
    return
  }
  if (plan.first !== "wait") return
  const saving = s.busy()?.operation === "save"
  const by = saving ? deadlineMs - SAVE_RESERVE_MS : deadlineMs
  if (!(await until(s, free, by)) && saving) await cancelled()
}

export async function runHostEnd(
  deadlineMs: number,
  s: HostEndSeams,
): Promise<HostEndOutcome> {
  const started = s.now()
  const facts = s.facts()
  const plan = hostEndPlan(facts)
  s.note({ what: "host-end", step: "plan", ...plan, deadlineMs })
  const finish = (outcome: HostEndOutcome): HostEndOutcome => {
    s.note({ what: "host-end", step: outcome, ms: s.now() - started })
    return outcome
  }
  await clear(s, plan, deadlineMs)
  if (!s.running()) return finish("ended-by-op")
  const holder = s.busy()
  if (holder !== null) {
    await s.handBack("shutdown", `${holder.operation} still holds the guest`)
    return finish("handed-back")
  }
  if (plan.end !== "stow") {
    await s.handBack(plan.end, plan.reason ?? plan.end)
    return finish("handed-back")
  }
  try {
    await s.stow()
  } catch (error) {
    await s.handBack("shutdown", `stow failed: ${errText(error)}`)
    return finish("handed-back")
  }
  return finish("stowed")
}

function freeBytes(dir: string): number | null {
  try {
    const st = statfsSync(dir)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}

function residentBytes(pid: number): number | null {
  const kib = Number.parseInt(
    spawnText("ps", ["-o", "rss=", "-p", String(pid)]).stdout.trim(),
    10,
  )
  return Number.isFinite(kib) ? kib * 1024 : null
}

export function hostEndFacts(name: string): HostEndFacts {
  const p = pathsFor(name)
  const pid = qemu.pidOf(p)
  const command = pid === null ? null : runningCommand(pid)
  const meta = readMeta(name)
  const virtio = meta !== null && readImageMeta(meta.image)?.virtioBoot === true
  const resident = pid === null ? null : residentBytes(pid)
  const holder = leaseHolder(name)
  return {
    action: effectiveConfig(name)["hostEnd.action"],
    ephemeral: command !== null && / -snapshot( |$)/.test(command),
    installMedia: command?.includes("media=cdrom") === true,
    unsaveable: virtio
      ? null
      : "the image predates virtio boot, so its disk cannot be saved",
    freeBytes: freeBytes(saves.savesRoot()),
    needBytes: resident === null ? null : resident + GIB,
    busy:
      holder === null
        ? null
        : {
            operation: holder.operation,
            automatic: holder.automatic,
            irreversible: irreversibleSince(name) !== null,
          },
  }
}

export function hostEndSeams(name: string): HostEndSeams {
  const p = pathsFor(name)
  return {
    facts: () => hostEndFacts(name),
    running: () => qemu.isRunning(p),
    busy: () => {
      const h = leaseHolder(name)
      return h === null
        ? null
        : {
            operation: h.operation,
            automatic: h.automatic,
            irreversible: irreversibleSince(name) !== null,
          }
    },
    cancel: async () => {
      await qmp.execute(p.qmp, "migrate_cancel")
    },
    stow: async () => {
      await withOperation(
        name,
        "stow",
        async () =>
          await saves.createSave(name, {
            name: saves.STOW,
            kind: "stow",
            quitAfter: true,
          }),
        { automatic: true, waitMs: 0 },
      )
    },
    handBack: async (end, reason) => {
      await keeperRequest(keeperSocket(p), { op: "host-end", end, reason })
    },
    note: (fields) => {
      appendEntry(name, { ...fields, kind: "service", what: "host-end" })
    },
    now: Date.now,
    sleep: async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
    },
  }
}

export async function hostEnd(
  name: string,
  deadlineMs: number,
): Promise<HostEndOutcome> {
  return await runHostEnd(deadlineMs, hostEndSeams(name))
}
