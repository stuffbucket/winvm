/**
 * Who has the pointer and keys over the screen (features/screen/input.ts): the
 * guest gets input only while it is live and answering. The rule, then the
 * keyboard router and the clipboard when it says no.
 */
import { describe, expect, it } from "bun:test"

import type { Phase } from "../ui/src/model"
import { ClipboardSync } from "../ui/src/features/screen/clipboard"
import { inputRule } from "../ui/src/features/screen/input"
import { GuestKeyboardRouter, type RoutedKeyEvent } from "../ui/src/features/screen/keyboard"

const dead: (Phase | null)[] = ["starting", "paused", "asleep", "stopped", "stowed", "missing", null]

describe("the input rule", () => {
  it("forwards input, with the guest's cursor and capture allowed, only to a running machine with nothing under way", () => {
    expect(inputRule("running", false)).toEqual({ forward: true, cursor: "guest", capture: "allowed", focusOnClick: true, why: null, released: null })
  })

  it("forwards nothing while a verb is under way (saving, loading, pausing, restarting, waking, locking)", () => {
    const rule = inputRule("running", true)
    expect(rule).toMatchObject({ forward: false, cursor: "arrow", capture: "released", why: "input.why.busy", released: "input.released.busy" })
  })

  it.each(dead)("forwards nothing in %p: the Mac's arrow, capture released, a reason given", (phase) => {
    for (const busy of [false, true]) {
      const rule = inputRule(phase, busy)
      expect(rule.forward).toBe(false)
      expect(rule.cursor).toBe("arrow")
      expect(rule.capture).toBe("released")
      expect(rule.why).toMatch(/^input\.why\./)
      expect(rule.released).toMatch(/^input\.released\./)
    }
  })

  it("names the phase in the reason", () => {
    expect(inputRule("paused", false).why).toBe("input.why.paused")
    expect(inputRule("asleep", false).why).toBe("input.why.asleep")
    expect(inputRule("starting", false).why).toBe("input.why.starting")
    expect(inputRule("stopped", false).why).toBe("input.why.off")
    expect(inputRule("stowed", false).why).toBe("input.why.off")
  })

  it("lets a click focus the frame only when live, or asleep (so a key can wake it)", () => {
    expect(inputRule("running", false).focusOnClick).toBe(true)
    expect(inputRule("asleep", false).focusOnClick).toBe(true)
    for (const phase of ["paused", "starting", "stopped", "stowed", "missing"] as const) expect(inputRule(phase, false).focusOnClick).toBe(false)
  })
})

interface FakeEvent extends RoutedKeyEvent {
  prevented: boolean
  stopped: boolean
}

const event = (code: string, modifiers: { ctrl?: boolean; alt?: boolean; meta?: boolean } = {}): FakeEvent => ({
  code,
  ctrlKey: modifiers.ctrl ?? false,
  altKey: modifiers.alt ?? false,
  metaKey: modifiers.meta ?? false,
  repeat: false,
  prevented: false,
  stopped: false,
  preventDefault() {
    this.prevented = true
  },
  stopImmediatePropagation() {
    this.stopped = true
  },
})

function setup() {
  const sent: string[] = []
  const captures: boolean[] = []
  let noVncReleases = 0
  const router = new GuestKeyboardRouter({
    send: (keysym, code, down) => sent.push(`${down ? "down" : "up"}:${code}:${keysym.toString(16)}`),
    translate: (e) => (e.code === "KeyR" ? { keysym: 0x72, code: "KeyR" } : null),
    releaseNoVnc: () => {
      noVncReleases += 1
    },
    onCaptured: (captured) => captures.push(captured),
  })
  return { router, sent, captures, noVncReleases: () => noVncReleases }
}

describe("a keyboard router turned off (the guest takes no input)", () => {
  it("releases held keys and capture first, and says so", () => {
    const { router, sent, captures, noVncReleases } = setup()
    router.setCaptured(true)
    router.keyDown(event("MetaLeft", { meta: true }))
    expect(sent).toEqual(["down:MetaLeft:ffeb"])
    router.setEnabled(false)
    // Ctrl first, so Windows never sees a lone Windows key; then the key; noVNC's own held keys too.
    expect(sent).toEqual(["down:MetaLeft:ffeb", "down:ControlLeft:ffe3", "up:ControlLeft:ffe3", "up:MetaLeft:ffeb"])
    expect(router.isCaptured()).toBe(false)
    expect(captures).toEqual([false])
    expect(noVncReleases()).toBeGreaterThan(0)
  })

  it("touches no key: nothing is sent, stopped or prevented, whatever the modifiers", () => {
    const { router, sent, captures } = setup()
    router.setEnabled(false)
    const events = [
      event("MetaLeft", { meta: true }),
      event("MetaRight", { meta: true }),
      event("KeyR", { meta: true }),
      event("ControlLeft", { ctrl: true, alt: true }),
      event("AltLeft", { ctrl: true, alt: true }),
    ]
    for (const e of events) {
      router.keyDown(e)
      router.keyUp(e)
    }
    expect(sent).toEqual([])
    expect(captures).toEqual([])
    for (const e of events) {
      expect(e.prevented).toBe(false)
      expect(e.stopped).toBe(false)
    }
  })

  it("cannot be captured while off, and capture stays released when it is on again", () => {
    const { router, captures } = setup()
    router.setCaptured(true)
    router.setEnabled(false)
    router.setCaptured(true)
    expect(router.isCaptured()).toBe(false)
    router.setEnabled(true)
    expect(router.isCaptured()).toBe(false)
    expect(captures).toEqual([false])
    // Asked for again, it captures as before.
    router.setCaptured(true)
    expect(router.isCaptured()).toBe(true)
  })

  it("lets right Command and the capture chord work again once on", () => {
    const { router, sent, captures } = setup()
    router.setEnabled(false)
    router.setEnabled(true)
    router.keyDown(event("MetaRight", { meta: true }))
    router.keyDown(event("KeyR", { meta: true }))
    expect(sent).toContain("down:KeyR:72")
    router.keyDown(event("ControlLeft", { ctrl: true, alt: true }))
    expect(captures).toEqual([true])
  })
})

describe("the clipboard while the guest takes no input", () => {
  it("keeps the Mac's text back, unmarked, and sends it once the guest takes input", async () => {
    const state = { mac: "copied while paused", can: false, toGuest: [] as string[] }
    const sync = new ClipboardSync({
      readMac: async () => state.mac,
      writeMac: async () => undefined,
      toGuest: (text) => state.toGuest.push(text),
      focused: () => true,
      canSend: () => state.can,
    })
    await sync.start()
    await sync.fromMac()
    expect(state.toGuest).toEqual([])
    state.can = true
    await sync.fromMac()
    expect(state.toGuest).toEqual(["copied while paused"])
    // And only once.
    await sync.fromMac()
    expect(state.toGuest).toEqual(["copied while paused"])
  })
})
