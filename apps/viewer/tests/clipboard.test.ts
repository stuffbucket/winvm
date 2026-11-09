/**
 * The clipboard between the Mac and Windows (features/screen/clipboard.ts):
 * text only, while the window is in front, and nothing sent back to the side
 * it came from.
 */
import { describe, expect, it, spyOn } from "bun:test"

import { ClipboardSync } from "../ui/src/features/screen/clipboard"

function setup(mac = "") {
  const state = { mac, focused: true, toGuest: [] as string[], toMac: [] as string[], reads: 0 }
  let release: (() => void) | null = null
  let hold = false
  const sync = new ClipboardSync({
    readMac: async () => {
      state.reads++
      const text = state.mac
      if (hold) await new Promise<void>((r) => (release = r))
      return text
    },
    writeMac: async (text) => {
      state.toMac.push(text)
      state.mac = text
    },
    toGuest: (text) => state.toGuest.push(text),
    focused: () => state.focused,
  })
  return {
    sync,
    state,
    holdReads: () => (hold = true),
    releaseRead: () => {
      hold = false
      release?.()
    },
  }
}

describe("the clipboard", () => {
  it("sends the Mac's text to Windows on connecting, while in front", async () => {
    const { sync, state } = setup("hello")
    await sync.start()
    expect(state.toGuest).toEqual(["hello"])
  })

  it("sends nothing on connecting from behind, or when the Mac holds no text", async () => {
    const a = setup("hello")
    a.state.focused = false
    await a.sync.start()
    expect(a.state.toGuest).toEqual([])
    const b = setup("")
    await b.sync.start()
    expect(b.state.toGuest).toEqual([])
  })

  it("puts what Windows copies on the Mac, only while in front", async () => {
    const { sync, state } = setup()
    await sync.start()
    sync.fromGuest("from windows")
    expect(state.toMac).toEqual(["from windows"])
    state.focused = false
    sync.fromGuest("while behind")
    expect(state.toMac).toEqual(["from windows"])
  })

  it("ignores Windows until the first sync, so a reconnect doesn't replace the Mac's clipboard", () => {
    const { sync, state } = setup("mac")
    sync.fromGuest("old windows text")
    expect(state.toMac).toEqual([])
  })

  it("doesn't echo: Windows' copy isn't sent back when the window comes forward again", async () => {
    const { sync, state } = setup()
    await sync.start()
    sync.fromGuest("abc")
    await sync.fromMac()
    expect(state.toGuest).toEqual([])
  })

  it("doesn't echo: what it sent to Windows isn't put back on the Mac", async () => {
    const { sync, state } = setup("xyz")
    await sync.start()
    sync.fromGuest("xyz")
    expect(state.toMac).toEqual([])
  })

  it("sends the Mac's text again only when it changed", async () => {
    const { sync, state } = setup("one")
    await sync.start()
    await sync.fromMac()
    state.mac = "two"
    await sync.fromMac()
    expect(state.toGuest).toEqual(["one", "two"])
  })

  it("lets a copy in Windows win over a Mac read begun before it", async () => {
    const t = setup("one")
    await t.sync.start()
    t.state.mac = "stale"
    t.holdReads()
    const reading = t.sync.fromMac()
    t.sync.fromGuest("newer in windows")
    t.releaseRead()
    await reading
    expect(t.state.toGuest).toEqual(["one"])
    expect(t.state.toMac).toEqual(["newer in windows"])
  })

  it("reads once at a time, and once more for focus that came meanwhile", async () => {
    const t = setup("a")
    await t.sync.start()
    t.state.mac = "b"
    t.holdReads()
    const first = t.sync.fromMac()
    void t.sync.fromMac()
    void t.sync.fromMac()
    expect(t.state.reads).toBe(2)
    t.releaseRead()
    await first
    await new Promise((r) => setTimeout(r, 0))
    expect(t.state.reads).toBe(3)
    expect(t.state.toGuest).toEqual(["a", "b"])
  })

  it("invalidates an in-flight Mac read when the screen closes", async () => {
    const t = setup("one")
    await t.sync.start()
    t.state.mac = "for the old machine"
    t.holdReads()
    const reading = t.sync.fromMac()
    t.sync.stop()
    t.releaseRead()
    await reading
    t.sync.fromGuest("old connection")
    await t.sync.fromMac()
    expect(t.state.toGuest).toEqual(["one"])
    expect(t.state.toMac).toEqual([])
  })

  it("serializes native writes, coalesces queued copies, and never reads the old Mac value back", async () => {
    let release!: () => void
    const writes: string[] = []
    const sent: string[] = []
    let mac = ""
    const sync = new ClipboardSync({
      readMac: async () => mac,
      writeMac: async (text) => {
        writes.push(text)
        if (text === "first") await new Promise<void>((resolve) => (release = resolve))
        mac = text
      },
      toGuest: (text) => sent.push(text),
      focused: () => true,
    })
    await sync.start()
    sync.fromGuest("first")
    sync.fromGuest("middle")
    sync.fromGuest("last")
    const reading = sync.fromMac()
    expect(writes).toEqual(["first"])
    release()
    await reading
    expect(writes).toEqual(["first", "last"])
    expect(mac).toBe("last")
    expect(sent).toEqual([])
  })

  it("retries the same Windows text after a native write fails", async () => {
    let attempts = 0
    const warning = spyOn(console, "warn").mockImplementation(() => undefined)
    const sync = new ClipboardSync({
      readMac: async () => "",
      writeMac: async () => {
        attempts++
        if (attempts === 1) throw new Error("pasteboard busy")
      },
      toGuest: () => undefined,
      focused: () => true,
    })
    try {
      await sync.start()
      sync.fromGuest("same")
      await sync.fromMac()
      sync.fromGuest("same")
      await sync.fromMac()
      expect(attempts).toBe(2)
    } finally {
      warning.mockRestore()
    }
  })

  it("does not remember a failed transport send as shared", async () => {
    let attempts = 0
    const warning = spyOn(console, "warn").mockImplementation(() => undefined)
    const sync = new ClipboardSync({
      readMac: async () => "retry me",
      writeMac: async () => undefined,
      toGuest: () => {
        attempts++
        if (attempts === 1) throw new Error("disconnected")
      },
      focused: () => true,
    })
    try {
      await sync.start()
      await sync.fromMac()
      expect(attempts).toBe(2)
    } finally {
      warning.mockRestore()
    }
  })
})
