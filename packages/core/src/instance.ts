import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { DisplayConfig } from "./display"
import { VIRTIO_GPU, writeDisplay } from "./display"
import type { Hardware } from "./hardware"
import { NEW_DEFAULT, writeHardware } from "./hardware"
import { requireFirmware } from "./host"
import { runtimeBin } from "./runtime"
import { run } from "./shell"
import { makeResultVolume } from "./media"
import type { InstanceMeta, Paths } from "./paths"
import { allocateVnc, basePath, pathsFor, readMeta } from "./paths"

export function makeVars(dest: string): void {
  rmSync(dest, { force: true })
  run(runtimeBin("qemu-img"), ["convert", "-f", "raw", "-O", "qcow2", requireFirmware().vars, dest])
}

export function sealBase(image: string): void {
  chmodSync(basePath(image), 0o444)
}

function createOverlay(p: Paths, image: string): void {
  run(runtimeBin("qemu-img"), ["create", "-f", "qcow2", "-b", basePath(image), "-F", "qcow2", p.overlay])
}

export function ensureInstance(name: string, image: string, display: DisplayConfig = VIRTIO_GPU, hardware: Hardware = NEW_DEFAULT): Paths {
  const p = pathsFor(name)
  if (readMeta(name) !== null) {
    if (!existsSync(p.vars)) {
      const legacy = resolve(p.dir, "efi-vars.fd")
      if (existsSync(legacy)) {
        run(runtimeBin("qemu-img"), ["convert", "-f", "raw", "-O", "qcow2", legacy, p.vars])
        rmSync(legacy, { force: true })
      } else {
        makeVars(p.vars)
      }
    }
    return p
  }

  if (!existsSync(basePath(image))) {
    console.error(
      `::error::no base image "${image}". Build one with \`winvm build --iso <win11.iso>\`, ` +
        "or adopt an installed disk with `winvm adopt <disk.qcow2>`.",
    )
    process.exit(1)
  }
  mkdirSync(p.tpmDir, { recursive: true })
  createOverlay(p, image)
  makeVars(p.vars)
  makeResultVolume(p.result)
  writeDisplay(p, display)
  writeHardware(p, hardware)
  const meta: InstanceMeta = { image, vnc: allocateVnc(), created: new Date().toISOString() }
  writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`)
  console.log(`created instance "${name}" from image "${image}" (vnc :${String(meta.vnc)})`)
  return p
}

export function resetInstance(name: string, meta: InstanceMeta): void {
  const p = pathsFor(name)
  rmSync(p.overlay, { force: true })
  createOverlay(p, meta.image)
  makeVars(p.vars)
  rmSync(p.tpmDir, { recursive: true, force: true })
  mkdirSync(p.tpmDir, { recursive: true })
  rmSync(p.result, { force: true })
  makeResultVolume(p.result)
}
