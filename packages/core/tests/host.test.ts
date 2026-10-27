/**
 * Host probes that read QEMU's own answers.
 */
import { describe, expect, it } from "bun:test"

import { parseHasPpi } from "../src/host"

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
