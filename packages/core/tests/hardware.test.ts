/**
 * The machine's processors and memory (hardware.ts), how saves keep loading
 * when they change (saves.ts), and `winvm info` / `config cpus= memory=`
 * (machineinfo.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { VIRTIO_GPU, writeDisplay } from "../src/display"
import {
  LEGACY,
  NEW_DEFAULT,
  hardwareError,
  hardwareFromArgv,
  limitsFor,
  parseMemory,
  readHardware,
  writeHardware,
} from "../src/hardware"
import { applyAssignments, forwardKind, isHardwareKey, parseUsernet, pendingNote, windowsAdapter } from "../src/machineinfo"
import { pathsFor, type InstanceMeta, type Paths } from "../src/paths"
import { qemuArgs } from "../src/qemu"
import { hardwareArgs, parseManifest, saveHardware, savesReport } from "../src/saves"
import * as share from "../src/share"

const GIB = 1024 ** 3
const META: InstanceMeta = { image: "win11-arm64", vnc: 9, created: "" }
const LAUNCH = { installMedia: false, ephemeral: false, virtioBoot: true } as const

let home = ""
const saved: Record<string, string | undefined> = {}
let prevProbe: share.Probe

beforeAll(() => {
  for (const k of ["WINVM_HOME", "WINVM_RUNTIME"]) saved[k] = process.env[k]
  home = mkdtempSync(resolve(tmpdir(), "winvm-hw-"))
  process.env["WINVM_HOME"] = home
  process.env["WINVM_RUNTIME"] = resolve(home, "runtime")
  mkdirSync(resolve(home, "runtime", "bin"), { recursive: true })
  prevProbe = share.setProbe(() => ({ ok: true, reason: null }))
})

afterAll(() => {
  share.setProbe(prevProbe)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

const instance = (name: string): Paths => {
  const p = pathsFor(name)
  mkdirSync(p.dir, { recursive: true })
  writeDisplay(p, VIRTIO_GPU)
  return p
}

describe("limits", () => {
  it("are 2 to the performance cores, and 4 GB to half the Mac's memory in whole GB", () => {
    const l = limitsFor(16, 64 * GIB)
    expect(l).toEqual({ cpus: { min: 2, max: 16 }, memoryMiB: { min: 4096, max: 32768, step: 1024 } })
    expect(limitsFor(4, 15 * GIB).memoryMiB.max).toBe(7168)
    // A small Mac still allows the minimum.
    expect(limitsFor(1, 6 * GIB)).toEqual({ cpus: { min: 2, max: 2 }, memoryMiB: { min: 4096, max: 4096, step: 1024 } })
  })

  it("refuse what is out of range or not in whole GB", () => {
    const l = limitsFor(16, 64 * GIB)
    expect(hardwareError({ cpus: 6, memoryMiB: 8192 }, l)).toBeNull()
    expect(hardwareError({ cpus: 1, memoryMiB: 8192 }, l)).toContain("2 to 16")
    expect(hardwareError({ cpus: 17, memoryMiB: 8192 }, l)).toContain("2 to 16")
    expect(hardwareError({ cpus: 4, memoryMiB: 3072 }, l)).toContain("4 GB to 32 GB")
    expect(hardwareError({ cpus: 4, memoryMiB: 33792 }, l)).not.toBeNull()
    expect(hardwareError({ cpus: 4, memoryMiB: 8000 }, l)).not.toBeNull()
  })

  it("parse memory as GB or MB", () => {
    expect(parseMemory("8G")).toBe(8192)
    expect(parseMemory("8 GB")).toBe(8192)
    expect(parseMemory("8192")).toBe(8192)
    expect(parseMemory("6144M")).toBe(6144)
    expect(parseMemory("lots")).toBeNull()
  })
})

describe("the setting", () => {
  it("is LEGACY for a machine that never had one, so existing machines keep 4 GB", () => {
    const p = instance("old")
    expect(readHardware(p)).toEqual(LEGACY)
    expect(LEGACY).toEqual({ cpus: 4, memoryMiB: 4096 })
    expect(NEW_DEFAULT).toEqual({ cpus: 4, memoryMiB: 8192 })
  })

  it("is what the command line uses, with the shared memory backend the same size as -m", () => {
    const p = instance("sized")
    writeHardware(p, { cpus: 6, memoryMiB: 8192 })
    const a = qemuArgs("sized", p, META, LAUNCH)
    expect(a[a.indexOf("-smp") + 1]).toBe("6")
    expect(a[a.indexOf("-m") + 1]).toBe("8192")
    expect(a).toContain("memory-backend-shm,id=mem,size=8192M,share=on")
    expect(hardwareFromArgv(a)).toEqual({ cpus: 6, memoryMiB: 8192 })
  })

  it("gives a machine without it exactly the command line every machine had before (so its saves' hash holds)", () => {
    const a = hardwareArgs(qemuArgs("old", instance("old"), META, LAUNCH))
    // What qemu.ts hard-coded before the setting: `-smp 4`, `-m 4096`, a 4096M backend.
    expect(a.slice(a.indexOf("-smp"), a.indexOf("-smp") + 4)).toEqual(["-smp", "4", "-m", "4096"])
    expect(a).toContain("memory-backend-shm,id=mem,size=4096M,share=on")
  })
})

describe("saves and the size", () => {
  const m = {
    name: "s",
    instance: "x",
    kind: "manual",
    createdAt: "2026-11-01T10:00:00.000Z",
    bytes: 1,
    compat: "abc",
    image: "win11-arm64",
  }

  it("a save without a record was taken at LEGACY; one with a record at its own size", () => {
    expect(saveHardware(parseManifest(JSON.stringify(m)))).toEqual(LEGACY)
    expect(saveHardware(parseManifest(JSON.stringify({ ...m, hardware: { cpus: 6, memoryMiB: 8192 } })))).toEqual({ cpus: 6, memoryMiB: 8192 })
    expect(() => parseManifest(JSON.stringify({ ...m, hardware: { cpus: "six" } }))).toThrow("manifest.hardware")
  })

  it("loads at the save's size: the command line at the save's size hashes as it did when it was taken", () => {
    // Taken at 4 / 4096 (no record), then the machine was set to 6 / 8 GB.
    const p = instance("moved")
    const taken = hardwareArgs(qemuArgs("moved", p, META, LAUNCH))
    writeHardware(p, { cpus: 6, memoryMiB: 8192 })
    const now = hardwareArgs(qemuArgs("moved", p, META, LAUNCH))
    expect(now).not.toEqual(taken)
    const atSave = hardwareArgs(qemuArgs("moved", p, META, { ...LAUNCH, hardware: saveHardware(parseManifest(JSON.stringify(m))) }))
    expect(atSave).toEqual(taken)
    // And a save taken at 6 / 8 GB, after the machine went back to 4 / 6 GB.
    const at6 = hardwareArgs(qemuArgs("moved", p, META, LAUNCH))
    writeHardware(p, { cpus: 4, memoryMiB: 6144 })
    const rec = saveHardware(parseManifest(JSON.stringify({ ...m, hardware: { cpus: 6, memoryMiB: 8192 } })))
    expect(hardwareArgs(qemuArgs("moved", p, META, { ...LAUNCH, hardware: rec }))).toEqual(at6)
  })

  it("`saves` judges each save at its own size", () => {
    const parts = { base: "b", hardware: "h", firmware: "f", qemu: "q" }
    const rows = [
      { name: "old", manifest: parseManifest(JSON.stringify({ ...m, name: "old", compat: "legacy-hash" })) },
      { name: "big", manifest: parseManifest(JSON.stringify({ ...m, name: "big", compat: "big-hash", hardware: { cpus: 6, memoryMiB: 8192 } })) },
      { name: "gone", manifest: parseManifest(JSON.stringify({ ...m, name: "gone", compat: "stale", hardware: { cpus: 6, memoryMiB: 8192 } })) },
    ]
    const at = (hw: { cpus: number; memoryMiB: number }): { compat: { hash: string; parts: typeof parts } } => ({
      compat: { hash: hw.cpus === 6 ? "big-hash" : hw.memoryMiB === 4096 ? "legacy-hash" : "setting-hash", parts },
    })
    const got = savesReport(rows, { compat: { hash: "setting-hash", parts }, at })
    expect(got.map((e) => [e.name, e.compatible])).toEqual([
      ["old", true],
      ["big", true],
      ["gone", false],
    ])
  })
})

describe("winvm config cpus= memory=", () => {
  const l = limitsFor(16, 64 * GIB)

  it("sets either or both, checked against the Mac", () => {
    expect(applyAssignments(LEGACY, ["cpus=6", "memory=8G"], l)).toEqual({ cpus: 6, memoryMiB: 8192 })
    expect(applyAssignments(LEGACY, ["memory=6144"], l)).toEqual({ cpus: 4, memoryMiB: 6144 })
    expect(() => applyAssignments(LEGACY, ["cpus=24"], l)).toThrow("2 to 16")
    expect(() => applyAssignments(LEGACY, ["memory=2G"], l)).toThrow("4 GB")
    expect(() => applyAssignments(LEGACY, ["cpus=two"], l)).toThrow("whole number")
    expect(isHardwareKey("cpus=6")).toBe(true)
    expect(isHardwareKey("autosave.keep=3")).toBe(false)
  })

  it("says when the change waits for the next start", () => {
    expect(pendingNote(null, NEW_DEFAULT)).toBeNull()
    expect(pendingNote(NEW_DEFAULT, NEW_DEFAULT)).toBeNull()
    expect(pendingNote(LEGACY, NEW_DEFAULT)).toContain("applies the next time Windows starts")
  })
})

describe("winvm info's network", () => {
  it("reads QEMU's forwards and names them", () => {
    const usernet = [
      "Hub -1 (net0):",
      "  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ",
      "  TCP[HOST_FORWARD]  14       127.0.0.1 52011       10.0.2.15   445     0     0",
      "  TCP[HOST_FORWARD]  12       127.0.0.1 47801       10.0.2.15  7801     0     0",
      "  TCP[ESTABLISHED]   30        10.0.2.15 50112  20.42.65.92   443     0     0",
    ].join("\n")
    expect(parseUsernet(usernet)).toEqual([
      { kind: "finder", host: "127.0.0.1", hostPort: 52011, guestPort: 445 },
      { kind: "agent", host: "127.0.0.1", hostPort: 47801, guestPort: 7801 },
    ])
    expect(forwardKind(8080)).toBe("other")
  })

  it("takes Windows' address from the adapter that has one", () => {
    const reply = [
      { name: "Loopback Pseudo-Interface 1", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "127.0.0.1", prefix: 8 }] },
      {
        name: "Ethernet",
        "ip-addresses": [
          { "ip-address-type": "ipv6", "ip-address": "fec0::1", prefix: 64 },
          { "ip-address-type": "ipv4", "ip-address": "10.0.2.15", prefix: 24 },
        ],
      },
    ]
    expect(windowsAdapter(reply)).toEqual({ adapter: "Ethernet", ipv4: "10.0.2.15" })
    expect(windowsAdapter(null)).toBeNull()
  })
})
