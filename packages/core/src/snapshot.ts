import { existsSync } from "node:fs"
import type { Paths } from "./paths"
import * as qmp from "./qmp"
import { runtimeBin } from "./runtime"
import { capture } from "./shell"

export const DEFAULT_TAG = "fresh"

export interface Snapshot {
  readonly tag: string
  readonly vmSize: string
  readonly date: string
}

function parseRows(out: string): readonly Snapshot[] {
  const rows: Snapshot[] = []
  for (const line of out.split("\n")) {
    const m =
      /^\s*(?:\d+|--)\s+(\S+)\s+(\d+(?:\.\d+)?\s*\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(
        line,
      )
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      rows.push({ tag: m[1], vmSize: m[2].replace(/\s+/g, " "), date: m[3] })
    }
  }
  return rows
}

export function list(p: Paths): readonly Snapshot[] {
  if (!existsSync(p.overlay)) return []
  return parseRows(
    capture(runtimeBin("qemu-img"), ["snapshot", "-l", p.overlay]),
  )
}

export async function listLive(p: Paths): Promise<readonly Snapshot[]> {
  return parseRows(await qmp.hmp(p.qmp, "info snapshots"))
}

export const has = (p: Paths, tag: string): boolean =>
  list(p).some((s) => s.tag === tag)

export async function save(p: Paths, tag: string): Promise<void> {
  await qmp.hmp(p.qmp, `savevm ${tag}`)
}

export async function load(p: Paths, tag: string): Promise<void> {
  await qmp.hmp(p.qmp, `loadvm ${tag}`)
}

export async function remove(p: Paths, tag: string): Promise<void> {
  await qmp.hmp(p.qmp, `delvm ${tag}`)
}
