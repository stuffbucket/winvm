/**
 * Host probes that read QEMU's own answers.
 */
import { describe, expect, it } from "bun:test"

import { MIN_QEMU, parseHasPpi, qemuVersionCheck } from "../src/host"

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

describe("qemuVersionCheck", () => {
  it("rejects QEMU 11.0, whose HVF guests can lose their timer interrupt", () => {
    const c = qemuVersionCheck("QEMU emulator version 11.0.3\nCopyright (c) 2003-2026 Fabrice Bellard and the QEMU Project developers\n")
    expect(c.ok).toBe(false)
    expect(c.label).toBe(`QEMU 11.0.3 (needs ${MIN_QEMU} or later)`)
    expect(c.hint).toContain("a86024eb2d")
    expect(c.hint).toContain("brew upgrade")
  })

  it("accepts 11.1.0 and later", () => {
    expect(MIN_QEMU).toBe("11.1.0")
    expect(qemuVersionCheck("QEMU emulator version 11.1.0").ok).toBe(true)
    expect(qemuVersionCheck("QEMU emulator version 11.1.2").ok).toBe(true)
    expect(qemuVersionCheck("QEMU emulator version 11.10.0").ok).toBe(true)
    expect(qemuVersionCheck("QEMU emulator version 12.0.0").ok).toBe(true)
    expect(qemuVersionCheck("QEMU emulator version 11.1.2").label).toBe("QEMU 11.1.2")
  })

  it("rejects older majors and minors, and says so when QEMU is missing or unreadable", () => {
    expect(qemuVersionCheck("QEMU emulator version 10.2.9").ok).toBe(false)
    expect(qemuVersionCheck("QEMU emulator version 11.0.99").ok).toBe(false)
    expect(qemuVersionCheck(null)).toMatchObject({ ok: false, label: "QEMU (not found)", hint: "brew install qemu (11.1.0 or later)" })
    expect(qemuVersionCheck("something else")).toMatchObject({ ok: false, label: "QEMU (version unreadable)" })
  })
})
