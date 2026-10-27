/**
 * The pure half of file saves: names, manifests, and the compatibility hash.
 * No VM needed.
 */
import { describe, expect, it } from "bun:test"

import { formatOffset, parseGuestTz } from "../src/clock"
import {
  baseIdentity,
  compatDiff,
  compatHash,
  defaultName,
  FILES,
  hardwareArgs,
  migrationPlan,
  nameError,
  parseManifest,
  ramFileFor,
  ramFormatOf,
  savesReport,
  shQuote,
} from "../src/saves"

describe("save names", () => {
  it("accepts ordinary names and the default timestamp", () => {
    for (const n of ["baseline", "stow", "before-install", "v1.2_rc", defaultName(new Date())]) {
      expect(nameError(n)).toBeNull()
    }
  })
  it("rejects what would be a path, hidden, or awkward on a command line", () => {
    for (const n of ["", ".", "..", ".lock", "a/b", "../x", "-x", "has space", "x".repeat(65), "naïve"]) {
      expect(nameError(n)).not.toBeNull()
    }
  })
  it("default names sort by time", () => {
    expect(defaultName(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02_03-04-05")
    expect(defaultName(new Date(2026, 9, 21, 16, 43, 5)) > defaultName(new Date(2026, 9, 3, 23, 0, 0))).toBe(true)
  })
})

describe("manifest", () => {
  const good = {
    name: "baseline",
    instance: "default",
    kind: "baseline",
    createdAt: "2026-10-21T23:50:00.000Z",
    bytes: 123,
    compat: "0123456789abcdef",
    image: "win11-arm64",
  }
  it("parses a valid manifest and keeps extra fields", () => {
    const m = parseManifest(JSON.stringify({ ...good, note: "hi", ramBytes: 7 }))
    expect(m.kind).toBe("baseline")
    expect(m.note).toBe("hi")
    expect(m.ramBytes).toBe(7)
  })
  it("rejects each kind of malformation with a reason", () => {
    expect(() => parseManifest("{")).toThrow(/not JSON/)
    expect(() => parseManifest("[]")).toThrow(/not an object/)
    expect(() => parseManifest(JSON.stringify({ ...good, kind: "weird" }))).toThrow(/kind/)
    expect(() => parseManifest(JSON.stringify({ ...good, name: "../x" }))).toThrow(/name/)
    expect(() => parseManifest(JSON.stringify({ ...good, createdAt: "yesterday" }))).toThrow(/createdAt/)
    expect(() => parseManifest(JSON.stringify({ ...good, bytes: -1 }))).toThrow(/bytes/)
    expect(() => parseManifest(JSON.stringify({ ...good, compat: "" }))).toThrow(/compat/)
    expect(() => parseManifest(JSON.stringify({ ...good, note: 3 }))).toThrow(/note/)
    expect(() => parseManifest(JSON.stringify({ ...good, format: "lz4" }))).toThrow(/format/)
  })
  it("accepts golden saves and a RAM format", () => {
    const m = parseManifest(JSON.stringify({ ...good, name: "golden", kind: "golden", format: "mapped" }))
    expect(m.kind).toBe("golden")
    expect(m.format).toBe("mapped")
  })
})

describe("RAM formats", () => {
  it("infers the format of a save written before manifests recorded it", () => {
    expect(ramFormatOf({})).toBe("zstd")
    expect(ramFormatOf({ ramFile: FILES.ram })).toBe("zstd")
    expect(ramFormatOf({ ramFile: FILES.ramRaw })).toBe("raw")
    expect(ramFormatOf({ ramFile: FILES.ramMapped })).toBe("mapped")
    expect(ramFormatOf({ format: "mapped", ramFile: FILES.ram })).toBe("mapped")
  })
  it("names one file per format", () => {
    expect(new Set([ramFileFor("zstd"), ramFileFor("raw"), ramFileFor("mapped")]).size).toBe(3)
  })
  it("mapped: file URI, deferred incoming, multifd channels, both capabilities on", () => {
    const m = migrationPlan("mapped", "/s/vmstate.mapped", "/rt/bin/zstd", 6)
    expect(m.uri).toBe("file:/s/vmstate.mapped")
    expect(m.incoming).toBe("defer")
    expect(m.parameters["multifd-channels"]).toBe(6)
    expect(m.capabilities).toEqual([
      { capability: "mapped-ram", state: true },
      { capability: "multifd", state: true },
    ])
  })
  it("stream formats switch both capabilities OFF, so a QEMU loaded from a mapped save can still zstd", () => {
    for (const f of ["zstd", "raw"] as const) {
      const m = migrationPlan(f, "/s/x", "/rt/bin/zstd")
      expect(m.capabilities.every((c) => !c.state)).toBe(true)
      expect(m.capabilities.map((c) => c.capability).sort()).toEqual(["mapped-ram", "multifd"])
      expect(m.parameters["multifd-channels"]).toBeUndefined()
      expect(m.incoming).not.toBe("defer")
    }
    expect(migrationPlan("zstd", "/a b/x", "/rt dir/bin/zstd").uri).toBe(`exec:'/rt dir/bin/zstd' -T0 -3 -q -f - -o '/a b/x'`)
    expect(migrationPlan("zstd", "/a b/x", "/rt dir/bin/zstd").incoming).toBe(`exec:'/rt dir/bin/zstd' -dc '/a b/x'`)
    expect(migrationPlan("raw", "/s/x", "/rt/bin/zstd").incoming).toBe("file:/s/x")
  })
  it("never caps bandwidth: the guest is stopped while it is saved", () => {
    expect(migrationPlan("zstd", "/x", "/rt/bin/zstd").parameters["max-bandwidth"]).toBeGreaterThan(2 ** 34)
  })
})

describe("compatibility", () => {
  const argv = (inst: string, vnc: number, extra: readonly string[] = []): string[] => [
    "-name", `winvm-${inst}`,
    "-machine", "virt,accel=hvf",
    "-cpu", "host", "-smp", "4", "-m", "4096",
    "-drive", "if=pflash,format=raw,readonly=on,file=/fw/code.fd",
    "-drive", `if=pflash,format=qcow2,file=/state/instances/${inst}/efi-vars.qcow2`,
    "-device", "virtio-blk-pci,drive=hd0,bootindex=0",
    "-chardev", `socket,path=/state/instances/${inst}/qga.sock,server=on,wait=off,id=qga0`,
    "-rtc", "base=utc,clock=host",
    "-vnc", `127.0.0.1:${String(vnc)}`,
    "-qmp", `unix:/state/instances/${inst}/qmp.sock,server=on,wait=off`,
    "-serial", "file:/x/serial.log",
    "-pidfile", "/x/qemu.pid",
    ...extra,
  ]

  it("ignores paths, ports, monitor, -snapshot, -loadvm, -incoming and -rtc", () => {
    const a = hardwareArgs(argv("a", 1))
    expect(hardwareArgs(argv("b", 7, ["-snapshot", "-incoming", "exec:zstd -dc x", "-loadvm", "fresh"]))).toEqual(a)
    expect(a.join(" ")).not.toContain("/state/")
    expect(a).not.toContain("-rtc")
    expect(a).toContain("virt,accel=hvf")
  })
  it("notices a hardware change", () => {
    const a = hardwareArgs(argv("a", 1))
    const more = argv("a", 1).map((x) => (x === "4096" ? "8192" : x))
    expect(hardwareArgs(more)).not.toEqual(a)
    const nvme = argv("a", 1).map((x) => x.replace("virtio-blk-pci", "nvme"))
    expect(hardwareArgs(nvme)).not.toEqual(a)
  })
  it("hashes deterministically, and every part matters", () => {
    const parts = { base: "b", hardware: "h", firmware: "f", qemu: "11.1.2" }
    expect(compatHash(parts)).toBe(compatHash({ ...parts }))
    expect(compatHash(parts)).toMatch(/^[0-9a-f]{16}$/)
    for (const k of ["base", "hardware", "firmware", "qemu"] as const) {
      expect(compatHash({ ...parts, [k]: "other" })).not.toBe(compatHash(parts))
    }
  })
  it("says which part differs", () => {
    const parts = { base: "b", hardware: "h", firmware: "f", qemu: "11.1.2" }
    expect(compatDiff(parts, parts)).toEqual([])
    expect(compatDiff(parts, { ...parts, qemu: "11.2.0" })).toEqual(["QEMU changed (11.1.2 -> 11.2.0)"])
    expect(compatDiff(parts, { ...parts, base: "x" })[0]).toMatch(/base image/)
  })
  it("identifies a base image by metadata, and a rebuild changes it", () => {
    const id = baseIdentity("win11-arm64", 14103740416, 1792626373000.4, "{\"created\":\"x\"}")
    expect(baseIdentity("win11-arm64", 14103740416, 1792626373000, "{\"created\":\"x\"}")).toBe(id)
    expect(baseIdentity("win11-arm64", 14103740416, 1792626999000, "{\"created\":\"x\"}")).not.toBe(id)
    expect(baseIdentity("win11-arm64", 14103740416, 1792626373000, "{\"created\":\"y\"}")).not.toBe(id)
  })
})

describe("helpers", () => {
  it("quotes a path for the migration exec: shell", () => {
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`)
  })
  it("formats clock offsets across their range", () => {
    expect(formatOffset(-12)).toBe("-12 ms")
    expect(formatOffset(1500)).toBe("+1.5 s")
    expect(formatOffset(-25_200_657)).toBe("-7h 0m 1s")
    expect(formatOffset(-180_000)).toBe("-3m 0s")
  })
  it("reads the guest's zone and RTC interpretation from one cmd.exe run", () => {
    const unset = "UTC \r\n\r\nERROR: The system was unable to find the specified registry key or value.\r\n"
    expect(parseGuestTz(unset)).toEqual({ zone: "UTC", rtcUtc: false })
    const set =
      "Pacific Standard Time\r\n\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation\r\n" +
      "    RealTimeIsUniversal    REG_DWORD    0x1\r\n"
    expect(parseGuestTz(set)).toEqual({ zone: "Pacific Standard Time", rtcUtc: true })
  })
})

describe("savesReport", () => {
  const m = {
    name: "before-update",
    instance: "default",
    kind: "manual" as const,
    createdAt: "2026-10-27T20:00:00.000Z",
    bytes: 2048,
    compat: "abc",
    image: "win11-arm64",
  }

  it("lists each save with whether it loads here", () => {
    expect(savesReport([{ name: m.name, manifest: m }, { name: "old", manifest: { ...m, name: "old", compat: "zzz" } }], "abc")).toEqual([
      { name: "before-update", kind: "manual", createdAt: m.createdAt, bytes: 2048, compatible: true },
      { name: "old", kind: "manual", createdAt: m.createdAt, bytes: 2048, compatible: false },
    ])
  })

  it("says compatibility is unknown when it cannot be worked out, and keeps the note", () => {
    expect(savesReport([{ name: m.name, manifest: { ...m, note: "clean install" } }], null)[0]).toEqual({
      name: "before-update",
      kind: "manual",
      createdAt: m.createdAt,
      bytes: 2048,
      compatible: null,
      note: "clean install",
    })
  })

  it("leaves out a save whose manifest cannot be read", () => {
    expect(savesReport([{ name: "broken", manifest: null, error: "bad json" }], "abc")).toEqual([])
  })
})
