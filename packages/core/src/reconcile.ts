import type { Args } from "./args"
import * as finder from "./finder"
import {
  needsRepair,
  type ReconcileResult,
  reconcileManagement,
  reconcileNote,
} from "./lifecycle"
import { listInstances, NO_RECONCILE, pathsFor } from "./paths"

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
    seams.reconcile ??
    (async (n: string) =>
      await reconcileManagement(n, undefined, { waitForBusyWatcher: false }))
  let failed = 0
  for (const name of names) {
    sweep(name)
    try {
      const r = await reconcile(name)
      const note = reconcileNote(name, r)
      if (note !== null) console.error(note)
      if (r.deferred !== undefined)
        console.error(
          `note: "${name}" is ${r.deferred}, so its control service and watcher were left as they are; ` +
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
