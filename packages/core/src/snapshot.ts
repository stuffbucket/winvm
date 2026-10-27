/**
 * Snapshots: capture a running guest, and put it back.
 *
 * A snapshot here is QEMU's `savevm` — the whole machine, RAM included, stored
 * inside the instance's own qcow2 files. Restoring one is not a reboot: the
 * guest resumes mid-instruction from the moment it was taken. Measured on an
 * M-series Mac with Windows 11 26300: `loadvm` takes 5-15 s (it reads the saved
 * RAM back; faster when it's still in the page cache) and the guest agent
 * answers ~2 s later, so a rewind of a running guest is ~8-17 s. From stopped
 * it also has to start QEMU: ~35 s.
 *
 * THREE THINGS HAD TO CHANGE BEFORE THIS WORKED AT ALL, and each announced
 * itself as a flat refusal from `savevm` naming a device:
 *
 *   - the NVMe boot disk        -> "non-migratable"; the disk moved to virtio-blk
 *   - the raw pflash vars       -> "does not support snapshots"; now qcow2
 *   - the writable result image -> same; now read-only once installed
 *
 * All three are enforced in qemu.ts. If one regresses, every command here fails
 * with QEMU's own words rather than silently taking nothing.
 */
import { existsSync } from "node:fs"

import { capture } from "./host"
import { runtimeBin } from "./runtime"
import type { Paths } from "./paths"
import * as qmp from "./qmp"


/** The snapshot `rewind` uses when no tag is named. */
export const DEFAULT_TAG = "fresh"

export interface Snapshot {
  readonly tag: string
  /** Size of the saved machine state. "0 B" means disk-only — no RAM was captured. */
  readonly vmSize: string
  readonly date: string
}

/**
 * Rows are shared between the two listings because the formats are ALMOST the
 * same and the difference is a trap: `qemu-img` numbers the ID column, while the
 * monitor prints `--`. A parser written against one silently returns nothing for
 * the other, which reads as "no snapshots" rather than as a parse failure.
 */
function parseRows(out: string): readonly Snapshot[] {
  const rows: Snapshot[] = []
  for (const line of out.split("\n")) {
    // ID  TAG  VM_SIZE  DATE  VM_CLOCK  ICOUNT — a TAG contains no spaces.
    const m = /^\s*(?:\d+|--)\s+(\S+)\s+(\d+(?:\.\d+)?\s*\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      rows.push({ tag: m[1], vmSize: m[2].replace(/\s+/g, " "), date: m[3] })
    }
  }
  return rows
}

/**
 * Tags on a STOPPED instance's disk.
 *
 * `qemu-img` cannot open a disk a running QEMU holds, so calling this on a live
 * guest yields an empty list — which would read as "no snapshots" and quietly
 * overwrite one. Use `listLive` when the guest is up.
 *
 * VM_SIZE reads 0 B here while the monitor reports gigabytes for the same tags,
 * and both are right: QEMU stores the machine state in the FIRST qcow2 device it
 * finds, which is the firmware-variables image, not the overlay. This lists the
 * overlay, so it sees the disk half of each snapshot and none of the RAM.
 */
export function list(p: Paths): readonly Snapshot[] {
  if (!existsSync(p.overlay)) return []
  return parseRows(capture(runtimeBin("qemu-img"), ["snapshot", "-l", p.overlay]))
}

/** Tags on a RUNNING instance, via its monitor. */
export async function listLive(p: Paths): Promise<readonly Snapshot[]> {
  return parseRows(await qmp.hmp(p.qmp, "info snapshots"))
}

export const has = (p: Paths, tag: string): boolean => list(p).some((s) => s.tag === tag)

/**
 * Capture the running guest.
 *
 * Replaces an existing tag, which is what makes `winvm snapshot` idempotent:
 * re-taking "fresh" after installing something is the normal way to move the
 * point you rewind to.
 */
export async function save(p: Paths, tag: string): Promise<void> {
  await qmp.hmp(p.qmp, `savevm ${tag}`)
}

/**
 * Put the guest back. The caller is responsible for waiting until the guest is
 * answering again — `loadvm` returns as soon as QEMU has restored the state,
 * which is BEFORE the guest agent is able to serve a command. Acting on that
 * gap looks exactly like a rewind that did not revert anything.
 */
export async function load(p: Paths, tag: string): Promise<void> {
  await qmp.hmp(p.qmp, `loadvm ${tag}`)
}

export async function remove(p: Paths, tag: string): Promise<void> {
  await qmp.hmp(p.qmp, `delvm ${tag}`)
}
