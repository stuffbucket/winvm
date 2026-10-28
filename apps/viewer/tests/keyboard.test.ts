import { describe, expect, it } from "bun:test"

import { GuestKeyboardRouter, sendCtrlAltDelete, sendWindowsKey, type RoutedKeyEvent } from "../ui/src/features/screen/keyboard"

interface FakeEvent extends RoutedKeyEvent {
  prevented: boolean
  stopped: boolean
}

const event = (
  code: string,
  modifiers: { ctrl?: boolean; alt?: boolean; meta?: boolean; repeat?: boolean } = {},
): FakeEvent => ({
  code,
  ctrlKey: modifiers.ctrl ?? false,
  altKey: modifiers.alt ?? false,
  metaKey: modifiers.meta ?? false,
  repeat: modifiers.repeat ?? false,
  prevented: false,
  stopped: false,
  preventDefault() {
    this.prevented = true
  },
  stopImmediatePropagation() {
    this.stopped = true
  },
})

const label = (keysym: number, code: string, down: boolean): string => `${down ? "down" : "up"}:${code}:${keysym.toString(16)}`

function setup() {
  const sent: string[] = []
  const captures: boolean[] = []
  let noVncReleases = 0
  const router = new GuestKeyboardRouter({
    send: (keysym, code, down) => sent.push(label(keysym, code, down)),
    translate: (e) => (e.code === "KeyR" ? { keysym: 0x72, code: "KeyR" } : null),
    releaseNoVnc: () => {
      noVncReleases += 1
    },
    onCaptured: (captured) => captures.push(captured),
  })
  return {
    router,
    sent,
    captures,
    noVncReleases: () => noVncReleases,
  }
}

describe("guest keyboard routing", () => {
  it("keeps left Command and its Mac shortcut out of Windows when uncaptured", () => {
    const { router, sent } = setup()
    const command = event("MetaLeft", { meta: true })
    const tab = event("Tab", { meta: true })
    router.keyDown(command)
    router.keyDown(tab)
    router.keyUp(tab)
    router.keyUp(command)
    expect(sent).toEqual([])
    expect(command.prevented).toBe(false)
    expect(tab.prevented).toBe(false)
    expect(command.stopped).toBe(true)
    expect(tab.stopped).toBe(true)
  })

  it("uses right Command as the deliberate Windows modifier while uncaptured", () => {
    const { router, sent } = setup()
    router.keyDown(event("MetaRight", { meta: true }))
    router.keyDown(event("KeyR", { meta: true }))
    router.keyUp(event("KeyR", { meta: true }))
    router.keyUp(event("MetaRight"))
    expect(sent).toEqual([
      "down:MetaLeft:ffeb",
      "down:KeyR:72",
      "up:KeyR:72",
      "up:MetaLeft:ffeb",
    ])
  })

  it("does not send a lone right Command", () => {
    const { router, sent } = setup()
    router.keyDown(event("MetaRight", { meta: true }))
    router.keyUp(event("MetaRight"))
    expect(sent).toEqual([])
  })

  it("routes keys through noVNC while captured", () => {
    const { router, sent } = setup()
    router.setCaptured(true)
    const command = event("MetaLeft", { meta: true })
    const r = event("KeyR", { meta: true })
    router.keyDown(command)
    router.keyDown(r)
    expect(sent).toEqual(["down:MetaLeft:ffeb"])
    expect(command.stopped).toBe(true)
    expect(r.stopped).toBe(false)
  })

  it("toggles capture with Control-Option without forwarding the chord", () => {
    const { router, captures, noVncReleases } = setup()
    router.keyDown(event("ControlLeft", { ctrl: true }))
    const option = event("AltLeft", { ctrl: true, alt: true })
    router.keyDown(option)
    router.keyDown(event("AltLeft", { ctrl: true, alt: true, repeat: true }))
    expect(captures).toEqual([true])
    expect(noVncReleases()).toBe(1)
    expect(option.prevented).toBe(true)
    expect(option.stopped).toBe(true)
  })

  it("neutralizes a held Windows key before noVNC releases it on blur", () => {
    const { router, sent, captures } = setup()
    router.setCaptured(true)
    router.keyDown(event("MetaLeft", { meta: true }))
    router.lostFocus()
    expect(sent).toEqual([
      "down:MetaLeft:ffeb",
      "down:ControlLeft:ffe3",
      "up:ControlLeft:ffe3",
      "up:MetaLeft:ffeb",
    ])
    expect(captures).toEqual([false])
  })

  it("releases an active uncaptured Windows chord safely when focus disappears", () => {
    const { router, sent } = setup()
    router.keyDown(event("MetaRight", { meta: true }))
    router.keyDown(event("KeyR", { meta: true }))
    router.lostFocus()
    expect(sent).toEqual([
      "down:MetaLeft:ffeb",
      "down:KeyR:72",
      "up:KeyR:72",
      "down:ControlLeft:ffe3",
      "up:ControlLeft:ffe3",
      "up:MetaLeft:ffeb",
    ])
  })

  it("sends special keys only through explicit actions", () => {
    const sent: string[] = []
    const send = (keysym: number, code: string, down: boolean): void => {
      sent.push(label(keysym, code, down))
    }
    sendWindowsKey(send)
    sendCtrlAltDelete(send)
    expect(sent).toEqual([
      "down:MetaLeft:ffeb",
      "up:MetaLeft:ffeb",
      "down:ControlLeft:ffe3",
      "down:AltLeft:ffe9",
      "down:Delete:ffff",
      "up:Delete:ffff",
      "up:AltLeft:ffe9",
      "up:ControlLeft:ffe3",
    ])
  })
})
