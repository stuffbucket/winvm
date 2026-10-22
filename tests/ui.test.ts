/**
 * The pure parts of `status`, `open`, `web` and the input verbs: formatting,
 * the web server's access checks, URL building, and the keyboard/pointer maths.
 * No VM needed. State-reading helpers run against a temporary WINVM_HOME.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { displayArgs, parseDisplay } from "../display"
import { deviceFromCommandLine, resolutionValues, virtioMonitorKeys } from "../guestdisplay"
import { ABS_MAX, charToStroke, parseCombo, pngSize, ppmSize, scaleAxis, textToStrokes } from "../input"
import type { InstanceStatus } from "../status"
import {
  deriveState,
  formatAge,
  formatBytes,
  formatDuration,
  formatMemory,
  formatOffset,
  formatStatus,
  formatTable,
  formatWatcher,
  osLabel,
  parseEtime,
  parseHardware,
  parseWatch,
  readSaves,
} from "../status"
import { generatePassword, screenSharingUrl, vncArg, websocketPort } from "../vnc"
import { actionArgv, hostAllowed, makeHandler, pageUrl, tokenMatches } from "../web"

const NOW = Date.parse("2026-10-21T12:00:00Z")

describe("status formatting", () => {
  it("formats durations, sizes, ages and memory", () => {
    expect(formatDuration(42)).toBe("42s")
    expect(formatDuration(125)).toBe("2m 5s")
    expect(formatDuration(3 * 3600 + 7 * 60)).toBe("3h 7m")
    expect(formatDuration(2 * 86400 + 3600)).toBe("2d 1h")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2_100_000_000)).toBe("2.1 GB")
    expect(formatBytes(15_000_000)).toBe("15 MB")
    expect(formatAge("2026-10-21T11:00:00Z", NOW)).toBe("1h 0m ago")
    expect(formatAge("not a date", NOW)).toBe("unknown time")
    expect(formatMemory(4096)).toBe("4 GiB")
    expect(formatMemory(512)).toBe("512 MiB")
  })

  it("describes the clock offset in words", () => {
    expect(formatOffset(300)).toBe("in sync with the host (within 1 s)")
    expect(formatOffset(-4200)).toBe("guest is 4.2 s behind the host")
    expect(formatOffset(7 * 3600 * 1000)).toBe("guest is 7h 0m ahead of the host")
  })

  it("names Windows 11 by its build, not the registry's 'Windows 10'", () => {
    expect(osLabel({ "pretty-name": "Windows 10 Pro", "kernel-release": "26300" })).toBe("Windows 11 Pro (build 26300)")
    expect(osLabel({ "pretty-name": "Windows 10 Pro", "kernel-release": "19045" })).toBe("Windows 10 Pro (build 19045)")
    expect(osLabel({})).toBeNull()
  })

  it("parses ps etime and the QEMU command line", () => {
    expect(parseEtime("05:03")).toBe(303)
    expect(parseEtime("01:02:03")).toBe(3723)
    expect(parseEtime("2-01:00:00")).toBe(2 * 86400 + 3600)
    expect(parseEtime("garbage")).toBeNull()
    expect(parseHardware(["qemu", "-smp", "4", "-m", "4096"])).toEqual({ cpus: 4, memoryMiB: 4096 })
    expect(parseHardware(["-m", "8G"])).toEqual({ cpus: null, memoryMiB: 8192 })
  })

  it("derives paused and stowed", () => {
    const stow = { name: "s", kind: "stow", createdAt: "2026-10-21T11:00:00Z", bytes: 1 }
    expect(deriveState(true, "running", null)).toBe("running")
    expect(deriveState(true, "paused", null)).toBe("paused")
    expect(deriveState(false, null, stow)).toBe("stowed")
    expect(deriveState(false, null, { ...stow, kind: "manual" })).toBe("stopped")
  })

  it("reads a watcher file defensively, and says when its process is gone", () => {
    expect(parseWatch(null, () => true)).toBeNull()
    const raw = {
      pid: 1,
      state: "watching",
      idleSeconds: 90,
      autosave: { enabled: true, idleMinutes: 15, keep: 3, lastAt: "2026-10-21T11:30:00Z" },
      stow: { enabled: false, idleMinutes: 60 },
    }
    const w = parseWatch(raw, () => true)
    expect(formatWatcher(w, NOW)).toBe(
      "watching, guest idle 1m 30s · autosave after 15 min idle (keep 3, last 30m 0s ago) · stow off",
    )
    expect(formatWatcher(parseWatch(raw, () => false), NOW)).toBe("not running (left a stale watch.json)")
    expect(parseWatch({ autosave: "nonsense" }, () => false)?.autosave).toBeNull()
  })

  const sample: InstanceStatus = {
    name: "ui",
    state: "running",
    vmStatus: "running",
    image: "win11-arm64",
    snapshotsCapable: true,
    pid: 123,
    uptimeSeconds: 600,
    cpus: 4,
    memoryMiB: 4096,
    display: 4,
    screen: "virtio-gpu 1920x1080",
    vncPort: 5904,
    websocketPort: 5704,
    overlayBytes: 2_100_000_000,
    guest: { agent: "ok", agentVersion: "109.1.0", os: "Windows 11 Pro (build 26300)", clockOffsetMs: 200 },
    saves: {
      count: 2,
      bytes: 3_000_000_000,
      latest: { name: "auto-1", kind: "auto", createdAt: "2026-10-21T11:50:00Z", bytes: 1_500_000_000 },
      latestBaseline: { name: "clean", kind: "baseline", createdAt: "2026-10-20T12:00:00Z", bytes: 1_500_000_000 },
    },
    watcher: null,
    notes: [],
  }

  it("renders a single instance", () => {
    const text = formatStatus(sample, "ok    Time Machine: VM files excluded from backups", NOW)
    expect(text.split("\n")[0]).toBe('instance "ui" — running')
    expect(text).toContain("uptime        10m 0s (qemu pid 123)")
    expect(text).toContain("Windows 11 Pro (build 26300) · agent responding (qemu-ga 109.1.0)")
    expect(text).toContain("clock         in sync with the host (within 1 s)")
    expect(text).toContain("4 vCPU, 4 GiB RAM, image win11-arm64")
    expect(text).toContain("virtio-gpu 1920x1080, VNC :4 · `winvm open -i ui`")
    expect(text).toContain('latest "auto-1" (auto, 10m 0s ago, 1.5 GB)')
    expect(text).toContain('baseline "clean" (baseline, 1d 0h ago, 1.5 GB)')
    expect(text).toContain("time machine  VM files excluded from backups")
  })

  it("tells a stopped instance how to start", () => {
    const text = formatStatus({ ...sample, name: "default", state: "stopped", pid: null, guest: null }, "", NOW)
    expect(text).not.toContain("uptime")
    expect(text).toContain("note: start it: winvm start")
    expect(text).not.toContain("-i default")
  })

  it("renders the several-instances table", () => {
    const text = formatTable([sample, { ...sample, name: "b", state: "stopped", uptimeSeconds: null }], "tm", NOW)
    const [head, first, second] = text.split("\n")
    expect(head).toMatch(/^NAME\s+STATE\s+UPTIME\s+VNC\s+DISK\s+SAVES\s+WATCHER$/)
    expect(first).toMatch(/^ui\s+running\s+10m 0s\s+:4\s+2\.1 GB\s+2, 10m 0s ago\s+-$/)
    expect(second).toMatch(/^b\s+stopped\s+-\s+:4/)
  })
})

describe("reading other commands' files", () => {
  let dir = ""
  const prev = process.env["WINVM_HOME"]
  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), "winvm-ui-test-"))
    process.env["WINVM_HOME"] = dir
    const save = (name: string, kind: string, createdAt: string): void => {
      mkdirSync(resolve(dir, "saves", "x", name), { recursive: true })
      writeFileSync(
        resolve(dir, "saves", "x", name, "manifest.json"),
        JSON.stringify({ name, instance: "x", kind, createdAt, bytes: 10, compat: "c", image: "i" }),
      )
    }
    save("old", "baseline", "2026-10-20T00:00:00Z")
    save("new", "auto", "2026-10-21T00:00:00Z")
    mkdirSync(resolve(dir, "saves", "x", "broken"), { recursive: true })
    writeFileSync(resolve(dir, "saves", "x", "broken", "manifest.json"), "{not json")
  })
  afterAll(() => {
    if (prev === undefined) delete process.env["WINVM_HOME"]
    else process.env["WINVM_HOME"] = prev
    rmSync(dir, { recursive: true, force: true })
  })

  it("lists saves newest first and skips unreadable manifests", () => {
    expect(readSaves("x").map((s) => s.name)).toEqual(["new", "old"])
    expect(readSaves("nobody")).toEqual([])
  })
})

describe("screen access", () => {
  it("builds Screen Sharing and websocket endpoints", () => {
    expect(screenSharingUrl(4, "abc23456")).toBe("vnc://:abc23456@127.0.0.1:5904")
    expect(screenSharingUrl(1, null)).toBe("vnc://127.0.0.1:5901")
    expect(websocketPort(4)).toBe(5704)
    expect(vncArg(4)).toBe("127.0.0.1:4,websocket=127.0.0.1:5704,password=on")
  })

  it("generates 8-character URL-safe passwords", () => {
    for (let i = 0; i < 50; i += 1) expect(generatePassword()).toMatch(/^[A-Za-z0-9]{8}$/)
  })
})

describe("web server access", () => {
  it("checks the token in constant time, rejecting anything else", () => {
    expect(tokenMatches("secret-token", "secret-token")).toBe(true)
    expect(tokenMatches("secret-token", "secret-tokeN")).toBe(false)
    expect(tokenMatches("secret-token", "secret")).toBe(false)
    expect(tokenMatches("secret-token", null)).toBe(false)
    expect(tokenMatches("", "")).toBe(false)
  })

  it("accepts only its own loopback Host", () => {
    expect(hostAllowed("127.0.0.1:5690", 5690)).toBe(true)
    expect(hostAllowed("localhost:5690", 5690)).toBe(true)
    expect(hostAllowed("evil.example:5690", 5690)).toBe(false)
    expect(hostAllowed("127.0.0.1:5691", 5690)).toBe(false)
    expect(hostAllowed(null, 5690)).toBe(false)
  })

  it("puts the token in the fragment, not the query", () => {
    const url = new URL(pageUrl(5690, "my vm", "t/k+n"))
    expect(url.origin).toBe("http://127.0.0.1:5690")
    expect(url.searchParams.get("i")).toBe("my vm")
    expect(url.search).not.toContain("t%2Fk")
    expect(decodeURIComponent(url.hash)).toBe("#token=t/k+n")
  })

  it("runs only known verbs with plain arguments", () => {
    expect(actionArgv("start", "ui")).toEqual(["start", "-i", "ui"])
    expect(actionArgv("load", "ui", "clean-1")).toEqual(["load", "-i", "ui", "clean-1"])
    expect(actionArgv("key", "ui", "ctrl-alt-delete")).toEqual(["key", "-i", "ui", "ctrl-alt-delete"])
    expect(actionArgv("save", "ui")).toEqual(["save", "-i", "ui"])
    expect(typeof actionArgv("destroy", "ui")).toBe("string")
    expect(typeof actionArgv("load", "ui")).toBe("string")
    expect(typeof actionArgv("load", "ui", "--force")).toBe("string")
    expect(typeof actionArgv("start", "ui", "x")).toBe("string")
    expect(typeof actionArgv("start", "../etc")).toBe("string")
  })

  const handler = makeHandler(() => 5690, "tok")
  const get = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    await handler(new Request(`http://127.0.0.1:5690${path}`, { headers: { host: "127.0.0.1:5690", ...headers } }))

  it("guards the API and the static files", async () => {
    expect((await get("/api/ping")).status).toBe(401)
    expect((await get("/api/ping", { "x-winvm-token": "nope" })).status).toBe(401)
    expect((await get("/api/ping", { "x-winvm-token": "tok" })).status).toBe(200)
    expect((await get("/api/ping", { "x-winvm-token": "tok", host: "rebound.example:5690" })).status).toBe(403)
    expect((await get("/")).status).toBe(200)
    expect((await get("/novnc/core/rfb.js")).headers.get("content-type")).toContain("javascript")
    expect((await get("/novnc/%2e%2e/%2e%2e/web.ts")).status).toBe(404)
    expect((await get("/novnc/LICENSE.txt")).status).toBe(404)
    const post = await handler(
      new Request("http://127.0.0.1:5690/api/action", {
        method: "POST",
        headers: { host: "127.0.0.1:5690", "x-winvm-token": "tok", "content-type": "application/json" },
        body: JSON.stringify({ instance: "ui", verb: "destroy" }),
      }),
    )
    expect(post.status).toBe(400)
  })
})

describe("input", () => {
  it("scales pixels to the tablet's range the way QEMU does", () => {
    expect(scaleAxis(0, 1920)).toBe(0)
    expect(scaleAxis(1919, 1920)).toBe(ABS_MAX)
    expect(scaleAxis(5000, 1920)).toBe(ABS_MAX)
    expect(scaleAxis(-3, 1920)).toBe(0)
    expect(scaleAxis(400, 801)).toBe(Math.round((400 * ABS_MAX) / 800))
  })

  it("reads image sizes from PPM and PNG headers", () => {
    expect(ppmSize("P6\n800 600\n255\n")).toEqual({ width: 800, height: 600 })
    expect(ppmSize("P6\n# comment\n1920 1080\n255\n")).toEqual({ width: 1920, height: 1080 })
    expect(ppmSize("P3\n1 1\n")).toBeNull()
    const png = Buffer.alloc(24)
    png.write("IHDR", 12, "latin1")
    png.writeUInt32BE(1600, 16)
    png.writeUInt32BE(900, 20)
    expect(pngSize(png)).toEqual({ width: 1600, height: 900 })
  })

  it("types US-layout text and refuses what it can't", () => {
    expect(charToStroke("a")).toEqual({ qcode: "a", shift: false })
    expect(charToStroke("Q")).toEqual({ qcode: "q", shift: true })
    expect(charToStroke("?")).toEqual({ qcode: "slash", shift: true })
    expect(charToStroke("\n")).toEqual({ qcode: "ret", shift: false })
    const { strokes, bad } = textToStrokes("Hi!\r\né")
    expect(strokes.map((s) => s.qcode)).toEqual(["h", "i", "1", "ret"])
    expect(bad).toEqual(["é"])
  })

  it("parses key combos", () => {
    expect(parseCombo("ctrl-alt-delete")).toEqual({ qcodes: ["ctrl", "alt", "delete"], unknown: null })
    expect(parseCombo("Win+R")).toEqual({ qcodes: ["meta_l", "r"], unknown: null })
    expect(parseCombo("F5")).toEqual({ qcodes: ["f5"], unknown: null })
    expect(parseCombo("ctrl--")).toEqual({ qcodes: ["ctrl", "minus"], unknown: null })
    expect(parseCombo("ctrl-banana").unknown).toBe("banana")
  })
})

describe("display", () => {
  it("parses sizes and maps them to devices", () => {
    expect(parseDisplay("1920x1080")).toEqual({ device: "virtio-gpu", width: 1920, height: 1080 })
    expect(parseDisplay("ramfb")).toEqual({ device: "ramfb" })
    expect(parseDisplay("10x10")).toBeNull()
    expect(parseDisplay("big")).toBeNull()
    expect(displayArgs({ device: "ramfb" })).toEqual(["-device", "ramfb"])
    expect(displayArgs({ device: "virtio-gpu", width: 1600, height: 900 })).toEqual([
      "-device",
      "virtio-gpu-pci,xres=1600,yres=900",
    ])
  })

  it("reads the running device back off a command line", () => {
    expect(deviceFromCommandLine("qemu -device virtio-gpu-pci,xres=1920,yres=1080 -display none")).toBe(
      "virtio-gpu 1920x1080",
    )
    expect(deviceFromCommandLine("qemu -device ramfb -display none")).toBe("ramfb")
  })

  it("finds the virtio GPU's monitor entries in `reg query` output", () => {
    const base = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers\\Configuration"
    const out = [
      "",
      `${base}\\MSNILNOEDID_1414_008D_FFFFFFFF_FFFFFFFF_0^030B4FCE`,
      `${base}\\NOEDID_1AF4_1050_00000000_00050000_0^2405D464`,
      `${base}\\NOEDID_1AF4_1050_00000000_00050000_0^2405D464\\00`,
      "",
    ].join("\r\n")
    expect(virtioMonitorKeys(out)).toEqual([`${base}\\NOEDID_1AF4_1050_00000000_00050000_0^2405D464`])
    expect(virtioMonitorKeys(out.replaceAll("HKEY_LOCAL_MACHINE", "HKLM"))).toHaveLength(1)
    expect(resolutionValues(1600, 900)).toContainEqual(["00\\00", "ActiveSize.cx", 1600])
  })
})
