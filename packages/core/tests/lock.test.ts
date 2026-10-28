/**
 * Locking Windows (lock.ts) against a fake agent, and the user's settings in
 * the XDG config directory (xdg.ts, settings.ts).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import type { Proc, PwshResponse } from "../src/guestagent"
import { ENABLE_SIGN_IN, LOCK_ARGV, type LockAgent, lockWindows } from "../src/lock"
import { SETTING_DEFAULTS, parseSetting, readSettings, settingsPath, writeSettings } from "../src/settings"
import { configDir, dataDir } from "../src/xdg"

class FakeAgent implements LockAgent {
  readonly scripts: string[] = []
  readonly launched: (readonly string[])[] = []
  procList: Proc[] = [{ pid: 4, name: "System", session: 0 }]
  pwshOutput = ""
  pwshCode = 0
  /** LogonUI appears this many procs() calls after the lock is launched; null: never. */
  appearsAfter: number | null = 1
  private sinceLaunch = 0

  async pwsh(script: string): Promise<PwshResponse> {
    this.scripts.push(script)
    return { code: this.pwshCode, output: this.pwshOutput, ms: 1, timedOut: false }
  }

  async launch(argv: readonly string[]): Promise<{ readonly pid: number }> {
    this.launched.push(argv)
    this.sinceLaunch = 0
    return { pid: 100 }
  }

  async procs(): Promise<readonly Proc[]> {
    if (this.launched.length > 0) {
      this.sinceLaunch += 1
      if (this.appearsAfter !== null && this.sinceLaunch >= this.appearsAfter) return [...this.procList, { pid: 900, name: "LogonUI.exe", session: 1 }]
    }
    return this.procList
  }
}

const noSleep = async (): Promise<void> => {}

describe("locking Windows", () => {
  it("makes sure the account can sign back in, then locks in the user's session and waits for the lock screen", async () => {
    const a = new FakeAgent()
    a.pwshOutput = "enabled Administrator\r\n"
    a.appearsAfter = 3
    const r = await lockWindows(a, { sleep: noSleep })
    expect(a.scripts).toEqual([ENABLE_SIGN_IN])
    expect(a.launched).toEqual([LOCK_ARGV])
    expect(LOCK_ARGV.join(" ")).toContain("LockWorkStation")
    expect(r).toEqual({ enabled: "Administrator", confirmed: true })
  })

  it("enables nothing when the account already is", async () => {
    const r = await lockWindows(new FakeAgent(), { sleep: noSleep })
    expect(r.enabled).toBeNull()
  })

  it("says so when the lock screen never shows, rather than hanging", async () => {
    const a = new FakeAgent()
    a.appearsAfter = null
    const r = await lockWindows(a, { waitMs: 0, sleep: noSleep })
    expect(r.confirmed).toBe(false)
    expect(a.launched).toHaveLength(1)
  })

  it("does not lock when it cannot make sure Windows lets the user back in", async () => {
    const a = new FakeAgent()
    a.pwshCode = 1
    a.pwshOutput = "Access denied"
    expect(await lockWindows(a, { sleep: noSleep }).catch((e: unknown) => String(e))).toContain("Access denied")
    expect(a.launched).toHaveLength(0)
  })
})

describe("XDG directories", () => {
  it("honours XDG_CONFIG_HOME and XDG_DATA_HOME, else ~/.config and ~/.local/share", () => {
    expect(configDir({ HOME: "/h" })).toBe("/h/.config/winvm")
    expect(dataDir({ HOME: "/h" })).toBe("/h/.local/share/winvm")
    expect(configDir({ HOME: "/h", XDG_CONFIG_HOME: "/c" })).toBe("/c/winvm")
    expect(dataDir({ HOME: "/h", XDG_DATA_HOME: "/d" })).toBe("/d/winvm")
  })

  it("ignores empty and relative values, as the spec says", () => {
    expect(configDir({ HOME: "/h", XDG_CONFIG_HOME: "" })).toBe("/h/.config/winvm")
    expect(dataDir({ HOME: "/h", XDG_DATA_HOME: "rel/dir" })).toBe("/h/.local/share/winvm")
  })
})

describe("the user's settings", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "wvset-"))
  const env = { HOME: "/nonexistent", XDG_CONFIG_HOME: dir }
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("are the defaults with no file, the pause overlay on", () => {
    expect(readSettings(env)).toEqual(SETTING_DEFAULTS)
    expect(SETTING_DEFAULTS["viewer.pauseOverlay"]).toBe(true)
  })

  it("persist the overlay toggle in $XDG_CONFIG_HOME/winvm/settings.json", () => {
    writeSettings({ "viewer.pauseOverlay": false }, env)
    expect(settingsPath(env)).toBe(resolve(dir, "winvm", "settings.json"))
    expect(JSON.parse(readFileSync(settingsPath(env), "utf8"))).toEqual({ "viewer.pauseOverlay": false })
    expect(readSettings(env)["viewer.pauseOverlay"]).toBe(false)
    writeSettings({ "viewer.pauseOverlay": true }, env)
    expect(readSettings(env)["viewer.pauseOverlay"]).toBe(true)
  })

  it("keep only known keys of the right type; a broken file is the defaults", () => {
    writeFileSync(settingsPath(env), JSON.stringify({ "viewer.pauseOverlay": "no", other: 1 }))
    expect(readSettings(env)).toEqual(SETTING_DEFAULTS)
    writeFileSync(settingsPath(env), "{not json")
    expect(readSettings(env)).toEqual(SETTING_DEFAULTS)
  })

  it("parse key=value against the key's type", () => {
    expect(parseSetting("viewer.pauseOverlay=false")).toEqual({ key: "viewer.pauseOverlay", value: false })
    expect(parseSetting("viewer.pauseOverlay=maybe")).toContain("true or false")
    expect(parseSetting("nope=true")).toContain("unknown setting")
    expect(parseSetting("viewer.pauseOverlay")).toContain("key=value")
  })
})
