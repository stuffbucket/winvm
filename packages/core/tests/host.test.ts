/**
 * Host probes that read QEMU's own answers.
 */
import { describe, expect, it } from "bun:test"

import { checksReport, macosCheck, parseHasPpi, runtimeCheck } from "../src/host"

describe("parseHasPpi", () => {
  it("is false for QEMU 11.0, whose tpm-tis-device has no ppi property", () => {
    // `qemu-system-aarch64 -M virt -device tpm-tis-device,help`, QEMU 11.0.3
    const help = [
      "tpm-tis-device options:",
      "  irq=<uint32>           -  (default: 5)",
      "  sysbus-irq[0]=<link<irq>>",
      "  tpm-tis-mmio[0]=<child<memory-region>>",
      "  tpmdev=<str>           - ID of a tpm to use as a backend",
    ].join("\n")
    expect(parseHasPpi(help)).toBe(false)
  })

  it("is true when the device lists ppi", () => {
    const help = [
      "tpm-tis-device options:",
      "  irq=<uint32>           -  (default: 5)",
      "  ppi=<bool>             - on/off (default: true)",
      "  tpmdev=<str>           - ID of a tpm to use as a backend",
    ].join("\n")
    expect(parseHasPpi(help)).toBe(true)
  })

  it("does not mistake a ppi inside another property's text for the property", () => {
    expect(parseHasPpi("  tpmdev=<str>           - see ppi=off in the docs")).toBe(false)
  })
})

describe("runtimeCheck", () => {
  const manifest = {
    name: "winvm-runtime",
    version: "11.1.2-1",
    qemu: "11.1.2",
    qemuPatches: "none",
    components: {},
    macho: [],
    files: {},
  }

  it("says how to get the runtime when there is none", () => {
    expect(runtimeCheck(null, [])).toMatchObject({ ok: false, label: "runtime (not installed)", hint: "winvm setup" })
  })

  it("names the runtime, its QEMU and where it came from when it verifies", () => {
    expect(runtimeCheck({ dir: "/c/11.1.2-1", source: "cache", manifest }, [])).toEqual({
      ok: true,
      label: "runtime 11.1.2-1 (QEMU 11.1.2, cache)",
      hint: "",
    })
  })

  it("refuses a runtime that does not verify, naming the first problem", () => {
    expect(runtimeCheck({ dir: "/c/11.1.2-1", source: "cache", manifest }, ["bin/zstd does not match manifest.json", "x"])).toEqual({
      ok: false,
      label: "runtime 11.1.2-1 does not verify: bin/zstd does not match manifest.json (and 1 more)",
      hint: "winvm setup",
    })
  })

  it("accepts an override without a manifest, saying it is unverified", () => {
    expect(runtimeCheck({ dir: "/x", source: "override", manifest: null }, ["no manifest.json"])).toEqual({
      ok: true,
      label: "runtime override /x (unverified: no manifest.json)",
      hint: "",
    })
  })
})

describe("macosCheck", () => {
  it("accepts macOS 15 and later on Apple Silicon", () => {
    expect(macosCheck("26.7.2", "arm64")).toEqual({ ok: true, label: "macOS 26.7.2 on Apple Silicon", hint: "" })
    expect(macosCheck("15.0", "arm64").ok).toBe(true)
  })

  it("refuses older macOS and Intel Macs", () => {
    expect(macosCheck("14.6.1", "arm64")).toMatchObject({ ok: false, hint: "winvm needs macOS 15 or later" })
    expect(macosCheck("26.1", "x86_64")).toMatchObject({ ok: false, hint: "winvm needs an Apple Silicon Mac" })
  })
})

describe("checksReport", () => {
  it("is ready when every check passes", () => {
    const r = checksReport([{ label: "macOS 15.1", ok: true, hint: "" }], "ok    Time Machine: off")
    expect(r).toEqual({ ready: true, checks: [{ label: "macOS 15.1", ok: true, hint: "" }], timeMachine: "ok    Time Machine: off" })
  })

  it("is not ready when one is missing", () => {
    const r = checksReport(
      [
        { label: "macOS 15.1", ok: true, hint: "" },
        { label: "runtime (not installed)", ok: false, hint: "winvm setup" },
      ],
      "",
    )
    expect(r.ready).toBe(false)
  })
})
