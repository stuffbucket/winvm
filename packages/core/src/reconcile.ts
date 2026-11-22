import type { Args } from "./args"
import * as finder from "./finder"
import { ensureCurrent, needsRepair, type ReconcileResult } from "./lifecycle"
import { listInstances, NO_RECONCILE, type Paths, pathsFor } from "./paths"
import { pidOf as qemuPid } from "./qemu"

const RECONCILING_VERBS: ReadonlySet<string> = new Set([
  "info",
  "saves",
  "snapshots",
  "config",
  "diagnose",
  "screenshot",
  "toasts",
  "ocr",
  "exec",
  "agent",
  "put",
  "get",
  "dir",
  "mkdir",
  "mv",
  "cp",
  "rm",
  "files",
  "launch",
  "ui",
  "terminal",
  "smoke",
  "webview",
  "type",
  "key",
  "click",
  "move",
  "scroll",
  "display",
  "open",
  "web",
  "clock",
  "reboot",
  "save",
  "load",
  "snapshot",
  "rewind",
  "golden",
  "share",
  "pause",
  "resume",
  "wake",
  "sleep",
  "lock",
  "watch",
])

export function shouldReconcileVerb(
  verb: string,
  env: NodeJS.ProcessEnv = process.env,
  name: string | null = null,
): boolean {
  if (env[NO_RECONCILE] === "1") return false
  if (RECONCILING_VERBS.has(verb)) return true
  return verb === "start" && name !== null && qemuPid(pathsFor(name)) !== null
}

export function reconcileNote(
  name: string,
  r: ReconcileResult,
  p: Paths = pathsFor(name),
): string | null {
  if (r.adopted === true)
    return `note: winvm's keeper now watches Windows on "${name}", which an older winvm started; Windows kept running`
  if (!r.changed || r.deferred !== undefined || qemuPid(p) === null) return null
  return `note: "${name}"'s control service now runs this build; Windows kept running`
}

export type Management = "current" | "repair" | "unknown"

export interface ManagementSeams {
  readonly stale?: (name: string) => readonly string[]
  readonly current?: string
}

export function managementOf(
  name: string,
  seams: ManagementSeams = {},
): Management {
  try {
    if (needsRepair(name, pathsFor(name), seams.current)) return "repair"
    const stale = seams.stale ?? ((n: string) => finder.staleMounts(n))
    return stale(name).length > 0 ? "repair" : "current"
  } catch {
    return "unknown"
  }
}

export interface ReconcileSeams {
  readonly sweep?: (name: string) => readonly string[]
  readonly reconcile?: (name: string) => Promise<ReconcileResult>
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

export async function reconcileInstances(
  names: readonly string[],
  seams: ReconcileSeams = {},
): Promise<number> {
  const sweep = seams.sweep ?? ((n: string) => finder.cleanStale(n))
  const reconcile =
    seams.reconcile ?? (async (n: string) => await ensureCurrent(n))
  let failed = 0
  for (const name of names) {
    sweep(name)
    try {
      const r = await reconcile(name)
      const note = reconcileNote(name, r)
      if (note !== null) console.error(note)
      if (r.deferred !== undefined)
        console.error(
          `note: "${name}" is busy, so its control service was left as it is; ` +
            `run \`winvm reconcile -i ${name}\` again once it is done`,
        )
    } catch (error) {
      failed += 1
      console.error(`::error::${errText(error)}`)
    }
  }
  return failed === 0 ? 0 : 1
}

export async function reconcileCmd(args: Args): Promise<number> {
  if (process.env[NO_RECONCILE] === "1") {
    console.error(
      `note: not reconciling: this winvm was started by winvm's own management (${NO_RECONCILE}=1)`,
    )
    return 0
  }
  const named = args.flags.get("instance") ?? process.env.WINVM_INSTANCE
  return await reconcileInstances(
    named === undefined ? listInstances() : [named],
  )
}
