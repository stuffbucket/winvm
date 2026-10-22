/** The pure parts of webview.ts, cdp.ts, ocr.ts and toasts.ts. No VM needed. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"

import { pickTarget } from "../cdp"
import type { Target } from "../cdp"
import { commands, splitWords } from "../hoststep"
import { JobError, parseJob } from "../job"
import { centre, parseBoxes, rank } from "../ocr"
import type { TextBox } from "../ocr"
import { fileTimeToIso, filterToasts, parseSince, readDb, toastTexts } from "../toasts"
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

describe("ocr", () => {
  const b = (text: string, x: number, y: number, match?: [number, number, number, number]): TextBox => ({
    text,
    confidence: 1,
    box: [x, y, 100, 20],
    ...(match === undefined ? {} : { match }),
  })

  it("parses the helper's JSON lines", () => {
    const out = '{"box":[1,2,3,4],"confidence":0.5,"text":"Quit"}\n\n{"box":[5,6,7,8],"confidence":1,"match":[5,6,2,8],"text":"Quit all"}\n'
    const boxes = parseBoxes(out)
    expect(boxes).toHaveLength(2)
    expect(boxes[1]?.match).toEqual([5, 6, 2, 8])
  })

  it("ranks a whole-line match first, then reading order; folds case and accents", () => {
    const boxes = [b("Quit Maximal", 10, 50), b("Settings", 10, 10), b("quit", 300, 80), b("Quit", 5, 80)]
    expect(rank(boxes, "QUIT").map((x) => `${x.text}@${String(x.box[0])}`)).toEqual(["Quit@5", "quit@300", "Quit Maximal@10"])
    expect(rank([b("Español", 0, 0)], "espanol")).toHaveLength(1)
    expect(rank(boxes, "nope")).toEqual([])
  })

  it("aims at the matched part of a line when Vision boxed it", () => {
    expect(centre(b("Quit Maximal", 10, 50))).toEqual({ x: 60, y: 60 })
    expect(centre(b("Quit Maximal", 10, 50, [10, 50, 30, 20]))).toEqual({ x: 25, y: 60 })
  })
})

describe("toasts", () => {
  const xml =
    '<toast duration="short"><visual><binding template="ToastGeneric"><text id="1">Maximal is working</text><text id="2"></text>' +
    '<text id="3">Requests &amp; replies &#8212; &lt;ok&gt;</text></binding></visual></toast>'

  it("converts FILETIME to ISO", () => {
    expect(fileTimeToIso(134371541463351150)).toBe("2026-10-22T14:49:06.335Z")
    expect(fileTimeToIso(0)).toBeNull()
    expect(fileTimeToIso(null)).toBeNull()
  })

  it("reads a toast's text lines, entities decoded, empties dropped", () => {
    expect(toastTexts(xml)).toEqual(["Maximal is working", "Requests & replies \u2014 <ok>"])
  })

  it("takes --since as an age or an ISO time", () => {
    const now = Date.parse("2026-10-22T15:00:00Z")
    expect(parseSince("90s", now)?.toISOString()).toBe("2026-10-22T14:58:30.000Z")
    expect(parseSince("2h", now)?.toISOString()).toBe("2026-10-22T13:00:00.000Z")
    expect(parseSince("2026-10-22T14:00:00Z")?.toISOString()).toBe("2026-10-22T14:00:00.000Z")
    expect(parseSince("soon")).toBeNull()
  })

  it("reads toasts from a WPN-shaped database and filters them", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "winvm-test-wpn-"))
    try {
      const file = resolve(dir, "wpndatabase.db")
      const db = new Database(file)
      db.run("CREATE TABLE NotificationHandler (RecordId INTEGER PRIMARY KEY, PrimaryId TEXT NOT NULL)")
      db.run(
        "CREATE TABLE Notification ([Order] INTEGER PRIMARY KEY, Id INTEGER NOT NULL, HandlerId INTEGER, Type TEXT NOT NULL, Payload BLOB, Tag TEXT, [Group] TEXT, ExpiryTime INT64, ArrivalTime INT64)",
      )
      db.run("INSERT INTO NotificationHandler VALUES (1, 'co.stuffbucket.maximal'), (2, 'Windows.SystemToast.Other')")
      const ins = db.prepare("INSERT INTO Notification VALUES (?, ?, ?, ?, ?, '', '', 0, ?)")
      ins.run(1, 10, 1, "toast", new TextEncoder().encode(xml), 134371541463351150)
      ins.run(2, 11, 2, "toast", "<toast><visual><binding><text>Other</text></binding></visual></toast>", 134371541000000000)
      ins.run(3, 12, 1, "tile", "<tile/>", 134371541463351150)
      db.close()
      const all = readDb(file)
      expect(all.map((t) => t.texts[0])).toEqual(["Other", "Maximal is working"])
      expect(all[1]?.app).toBe("co.stuffbucket.maximal")
      expect(filterToasts(all, { app: "MAXIMAL" })).toHaveLength(1)
      expect(filterToasts(all, { find: "is WORKING" })).toHaveLength(1)
      expect(filterToasts(all, { since: new Date("2026-10-22T14:49:06Z") }).map((t) => t.id)).toEqual([10])
      expect(filterToasts(all, { since: new Date("2026-10-22T14:50:00Z") })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("shell: winvm steps", () => {
  it("splits words like a shell: quotes group, no expansion, backslashes literal outside double quotes", () => {
    expect(splitWords(`webview click 'a[href="#apps"]'`)).toEqual(["webview", "click", 'a[href="#apps"]'])
    expect(splitWords(`click --text "Quit Maximal"  --double`)).toEqual(["click", "--text", "Quit Maximal", "--double"])
    expect(splitWords(String.raw`put C:\work\x "a \"b\" c" ''`)).toEqual(["put", String.raw`C:\work\x`, 'a "b" c', ""])
    expect(() => splitWords("ocr --find 'oops")).toThrow()
  })

  it("one command per line, comments skipped, an optional leading winvm, the instance after the verb", () => {
    const run = "# read it\nwebview wait '#account' --timeout 30\n\nwinvm ocr --find Settings\n"
    expect(commands(run, "ci")).toEqual([
      ["webview", "-i", "ci", "wait", "#account", "--timeout", "30"],
      ["ocr", "-i", "ci", "--find", "Settings"],
    ])
  })

  it("parses as a shell, and refuses background", () => {
    const job = parseJob("steps:\n  - shell: winvm\n    run: ocr\n")
    expect(job.steps[0]?.shell).toBe("winvm")
    expect(() => parseJob("steps:\n  - shell: winvm\n    background: true\n    run: ocr\n")).toThrow(JobError)
  })
})
