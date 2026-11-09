import { describe, expect, test } from "bun:test"

import { parsePolicy, policyReadArgs, policyWriteArgs } from "../ui/src/features/settings/policy"
import { nativeMenuState } from "../ui/src/features/toolbar/nativeMenu"

const policy = {
  "autosave.enabled": true,
  "autosave.idleMinutes": 10,
  "autosave.keep": 3,
  "stow.enabled": true,
  "stow.idleMinutes": 60,
  "watch.enabled": true,
  "power.keepAwake": false,
}

describe("machine policy settings", () => {
  test("requires a complete typed answer; never writes fallback defaults after a failed read", () => {
    expect(parsePolicy(JSON.stringify({ ...policy, title: "Work", "watch.idleCpuPercent": 10 }))).toEqual(policy)
    for (const raw of ["", "not json", "{}", JSON.stringify({ ...policy, "autosave.keep": 0 }), JSON.stringify({ ...policy, "autosave.keep": 1.5 }), JSON.stringify({ ...policy, "autosave.enabled": "false" })]) expect(parsePolicy(raw)).toBeNull()
  })
  test("reads the selected instance and writes only changed keys, with JSON last", () => {
    expect(policyReadArgs("dev-settings")).toEqual(["config", "-i", "dev-settings", "--json"])
    expect(policyWriteArgs("dev-settings", policy, { ...policy, "autosave.keep": 6, "power.keepAwake": true })).toEqual(["config", "-i", "dev-settings", "autosave.keep=6", "power.keepAwake=true", "--json"])
    expect(() => policyWriteArgs("dev-settings", policy, { ...policy, "stow.idleMinutes": NaN })).toThrow()
  })
})

const base = { phase: "running" as const, busy: false, hostReady: true, instance: true, forwardInput: true, resizable: true, modal: false }
describe("native toolbar parity", () => {
  test("power and input commands follow phase and guest readiness", () => {
    const running = nativeMenuState(base)
    expect(running["vm-start"]).toBe(false)
    for (const id of ["vm-pause", "vm-sleep", "vm-lock", "vm-save", "vm-files", "capture-keyboard"]) expect(running[id]).toBe(true)
    expect(running["view-actual-size"]).toBe(false)
    for (const phase of ["paused", "asleep"] as const) {
      const held = nativeMenuState({ ...base, phase, forwardInput: false })
      expect(held["vm-resume"]).toBe(true)
      for (const id of ["vm-sleep", "vm-lock", "vm-files", "capture-keyboard", "send-ctrl-alt-delete"]) expect(held[id]).toBe(false)
    }
  })
  test("modal and busy states cannot act on a background machine", () => {
    const modal = nativeMenuState({ ...base, modal: true })
    expect(Object.entries(modal).filter(([, on]) => on)).toEqual([["release-keyboard", true]])
    const busy = nativeMenuState({ ...base, busy: true, forwardInput: false })
    for (const id of ["vm-start", "vm-stop", "vm-reboot", "vm-pause", "vm-resume", "vm-sleep", "vm-lock", "vm-kill", "vm-save", "vm-delete", "vm-choose"]) expect(busy[id]).toBe(false)
    expect(nativeMenuState({ ...base, phase: null })["vm-start"]).toBe(false)
  })
})
