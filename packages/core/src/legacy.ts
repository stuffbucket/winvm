import { readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"

import { commandInstance, winvmCommandAfter } from "./args"
import { type KeeperUse, keeperHello, keeperUse, openKeeper } from "./kept"
import { InstanceBusy, withOperation } from "./operation"
import { instanceDir, type Paths, pathsFor } from "./paths"
import * as qemu from "./qemu"
import { ensureService } from "./servicectl"
import { spawnText } from "./shell"

export type Adoption = "adopted" | "kept" | "none" | "busy"

async function adoptHeld(
  name: string,
  p: Paths,
  use: Extract<KeeperUse, { readonly kind: "keeper" }>,
  pid: number,
): Promise<Adoption> {
  if (qemu.pidOf(p) !== pid || (await keeperHello(p)) !== null) return "none"
  const hello = await openKeeper(name, p, use.keeper, {
    adopt: { name: "qemu", pidfile: p.pid, qmp: p.qmp },
  })
  if (hello.child?.pid !== pid) return "none"
  await ensureService(name, p)
  return "adopted"
}

export async function adoptLegacy(
  name: string,
  p: Paths = pathsFor(name),
  use: KeeperUse = keeperUse(),
): Promise<Adoption> {
  if (use.kind !== "keeper") return "none"
  const pid = qemu.pidOf(p)
  if (pid === null) return "none"
  const hello = await keeperHello(p)
  if (hello !== null) return hello.child?.pid === pid ? "kept" : "none"
  try {
    return await withOperation(
      name,
      "reconcile",
      async () => await adoptHeld(name, p, use, pid),
      { automatic: true, waitMs: 0 },
    )
  } catch (error) {
    if (error instanceof InstanceBusy) return "busy"
    throw error
  }
}

const watchPid = (name: string): string =>
  resolve(instanceDir(name), "watch.pid")

const owedPath = (p: Paths): string => resolve(p.dir, "watch.owed")

function isWatcherProcess(pid: number, name: string): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const r = spawnText("ps", ["-o", "command=", "-p", String(pid)])
  const rest = winvmCommandAfter(r.stdout, "watch")
  if (rest === null) return false
  if (/(?:^|\s)--(?:stop|status)(?:\s|$)/.test(rest)) return false
  return (commandInstance(rest) ?? "default") === name
}

export function legacyWatcherPid(
  name: string,
  isWatcher: (pid: number) => boolean = (pid) => isWatcherProcess(pid, name),
): number | null {
  const f = watchPid(name)
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(f, "utf8").trim(), 10)
  } catch {
    return null
  }
  if (Number.isInteger(pid) && pid > 1 && isWatcher(pid)) return pid
  rmSync(f, { force: true })
  return null
}

function savingIn(name: string, pid: number): boolean {
  try {
    const st = JSON.parse(
      readFileSync(resolve(instanceDir(name), "watch.json"), "utf8"),
    ) as { pid?: unknown; state?: unknown }
    return (
      st.pid === pid && (st.state === "autosaving" || st.state === "stowing")
    )
  } catch {
    return false
  }
}

export interface StopSeams {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly isWatcher?: (pid: number) => boolean
}

export async function stopLegacyWatcher(
  name: string,
  seams: StopSeams = {},
): Promise<boolean> {
  const kill =
    seams.kill ??
    ((pid: number, signal: NodeJS.Signals): void =>
      void process.kill(pid, signal))
  const now = seams.now ?? Date.now
  const wait =
    seams.sleep ??
    (async (ms: number): Promise<void> => {
      await new Promise((r) => setTimeout(r, ms))
    })
  const isWatcher =
    seams.isWatcher ?? ((p: number): boolean => isWatcherProcess(p, name))
  const pid = legacyWatcherPid(name, isWatcher)
  if (pid === null || pid === process.ppid || pid === process.pid) return false
  try {
    kill(pid, "SIGTERM")
  } catch {
    return false
  }
  const deadline = now() + (savingIn(name, pid) ? 10 * 60_000 : 10_000)
  while (now() < deadline) {
    if (!isWatcher(pid)) return true
    await wait(200)
  }
  if (isWatcher(pid)) {
    try {
      kill(pid, "SIGKILL")
    } catch {}
  }
  const f = watchPid(name)
  try {
    if (readFileSync(f, "utf8").trim() === String(pid))
      rmSync(f, { force: true })
  } catch {}
  return true
}

export function legacyWatcherOwed(p: Paths): number | null {
  try {
    const q = (
      JSON.parse(readFileSync(owedPath(p), "utf8")) as { qemu?: unknown }
    ).qemu
    return typeof q === "number" ? q : null
  } catch {
    return null
  }
}

export const forgiveLegacyWatcher = (p: Paths): void => {
  rmSync(owedPath(p), { force: true })
}
