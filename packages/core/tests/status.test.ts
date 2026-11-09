import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { LEGACY, writeHardware } from "../src/hardware"
import { pathsFor } from "../src/paths"
import { gather } from "../src/status"
import { FakeQmp } from "./fakes/qmp"

let home: string
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ["WINVM_HOME", "WINVM_RUNTIME", "WINVM_QEMU_DATA", "XDG_CONFIG_HOME", "PATH"]) saved[k] = process.env[k]
  home = mkdtempSync("/tmp/wvst-")
  process.env["WINVM_HOME"] = home
  // Status must not require installed QEMU binaries or discoverable firmware.
  process.env["WINVM_RUNTIME"] = resolve(home, "no-runtime")
  process.env["WINVM_QEMU_DATA"] = resolve(home, "no-firmware")
  process.env["XDG_CONFIG_HOME"] = resolve(home, "config")
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

function instance(name: string): ReturnType<typeof pathsFor> {
  const p = pathsFor(name)
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify({ image: "win11-arm64", vnc: 9, created: "" }))
  return p
}

describe("status host probes", () => {
  it("reads stopped hardware directly, without QEMU or firmware capability probes", async () => {
    const p = instance("stopped-sized")
    writeHardware(p, { cpus: 6, memoryMiB: 8192 })
    expect(await gather("stopped-sized", false)).toMatchObject({ state: "stopped", cpus: 6, memoryMiB: 8192, uptimeSeconds: null })
  })

  it("keeps the legacy size for a stopped machine without hardware.json", async () => {
    instance("stopped-legacy")
    expect(await gather("stopped-legacy", false)).toMatchObject({ state: "stopped", cpus: LEGACY.cpus, memoryMiB: LEGACY.memoryMiB })
  })

  it("reads running uptime and actual hardware in one ps invocation, not the next-boot setting", async () => {
    const p = instance("running-sized")
    writeHardware(p, { cpus: 2, memoryMiB: 4096 })
    writeFileSync(p.pid, `${String(process.pid)}\n`)
    const bin = resolve(home, "bin")
    const calls = resolve(home, "ps-calls")
    mkdirSync(bin)
    writeFileSync(resolve(bin, "ps"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf '%s\\n' '  2-01:02:03 /a path/qemu-system-aarch64 -name winvm-test -smp cpus=6 -m size=8G'\n`, { mode: 0o755 })
    const oldPath = process.env["PATH"]
    process.env["PATH"] = `${bin}:${oldPath ?? ""}`
    const qmp = new FakeQmp(p.qmp)
    qmp.handler = () => ({ return: { status: "running" } })
    try {
      await qmp.listen()
      expect(await gather("running-sized", false)).toMatchObject({ state: "running", cpus: 6, memoryMiB: 8192, uptimeSeconds: 176523 })
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([`-ww -o etime=,command= -p ${String(process.pid)}`])
    } finally {
      if (oldPath === undefined) delete process.env["PATH"]
      else process.env["PATH"] = oldPath
      await qmp.close()
    }
  })
})
