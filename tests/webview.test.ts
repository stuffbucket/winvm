/** The pure parts of webview.ts, cdp.ts, ocr.ts and toasts.ts. No VM needed. */
import { describe, expect, it } from "bun:test"

import { pickTarget } from "../cdp"
import type { Target } from "../cdp"
import { forwardsTo, guestScript, relayPort } from "../webview"

const t = (o: Partial<Target>): Target => ({ id: "x", type: "page", title: "", url: "", webSocketDebuggerUrl: "ws://h/p", ...o })

describe("webview", () => {
  it("relays DevTools port N on N+10000", () => {
    expect(relayPort(9222)).toBe(19222)
  })

  it("finds forwards to a guest port in `info usernet`", () => {
    const usernet = [
      "Hub -1 (net0):",
      "  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ",
      "  TCP[HOST_FORWARD]  14       127.0.0.1 58419       10.0.2.15 19222     0     0",
      "  TCP[HOST_FORWARD]  12       127.0.0.1 47801       10.0.2.15  7801     0     0",
    ].join("\n")
    expect(forwardsTo(usernet, 19222)).toEqual([58419])
    expect(forwardsTo(usernet, 7801)).toEqual([47801])
    expect(forwardsTo(usernet, 9222)).toEqual([])
  })

  it("sets the policy under the exe's name, relays and lets in slirp only; never exits", () => {
    const on = guestScript("maximal-shell.exe", 9222, true)
    expect(on).toContain("-Name 'maximal-shell.exe' -Value '--remote-debugging-port=9222'")
    expect(on).toContain("listenport=19222 connectaddress=127.0.0.1 connectport=9222")
    expect(on).toContain("remoteip=10.0.2.2")
    expect(on).not.toMatch(/\bexit\b/)
    const off = guestScript("it's.exe", 9222, false)
    expect(off).toContain("Remove-ItemProperty")
    expect(off).toContain("-Name 'it''s.exe'")
    expect(off).not.toContain("portproxy add")
  })

  it("picks the page whose URL or title matches, else the first page", () => {
    const list = [
      t({ type: "service_worker", url: "http://a/sw.js" }),
      t({ id: "1", title: "maximal — Dashboard", url: "http://localhost:4141/ui/dashboard/" }),
      t({ id: "2", title: "maximal — Settings", url: "http://localhost:4141/ui/settings/#account" }),
    ]
    expect(pickTarget(list, null)?.id).toBe("1")
    expect(pickTarget(list, "SETTINGS")?.id).toBe("2")
    expect(pickTarget(list, "/ui/dashboard")?.id).toBe("1")
    expect(pickTarget(list, "nope")).toBeNull()
    expect(pickTarget([t({ webSocketDebuggerUrl: undefined })], null)).toBeNull()
  })
})
