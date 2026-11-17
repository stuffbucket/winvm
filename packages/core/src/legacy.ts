import { type KeeperUse, keeperHello, keeperUse, openKeeper } from "./kept"
import { InstanceBusy, withOperation } from "./operation"
import { type Paths, pathsFor } from "./paths"
import * as qemu from "./qemu"
import { ensureService } from "./servicectl"

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
