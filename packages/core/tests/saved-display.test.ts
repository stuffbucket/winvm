import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import * as clock from "../src/clock"
import * as qga from "../src/qga"
import { isPristine, markPristine } from "../src/saves"
import { destroy } from "../src/commands"
import { displayPath, readDisplay, writeDisplay, type DisplayConfig } from "../src/display"
import * as guestdisplay from "../src/guestdisplay"
import * as host from "../src/host"
import * as media from "../src/media"
import { basePath, imageMetaPath, pathsFor, readMeta, type InstanceMeta } from "../src/paths"
import * as qemu from "../src/qemu"
import * as qmp from "../src/qmp"
import * as runtime from "../src/runtime"
import * as savecmds from "../src/savecmds"
import * as screen from "../src/screen"
import { gather } from "../src/status"
import { cloneSave, createSave, currentCompat, FILES, listSaves, loadSave, readSave, saveDir, savesReport, type Manifest } from "../src/saves"

const A: DisplayConfig = { device: "virtio-gpu", width: 1920, height: 1080 }
const B: DisplayConfig = { device: "virtio-gpu", width: 2560, height: 1440 }
const meta: InstanceMeta = { image: "win11-arm64", vnc: 9, created: "2026-11-02T00:00:00Z" }
let state = ""
let previousHome: string | undefined
let launches: readonly string[][] = []
let commands: string[] = []
let runningPid: number | null = null

function makeInstance(name: string): void {
  const p = pathsFor(name)
  mkdirSync(p.tpmDir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify(meta))
  writeFileSync(p.overlay, "live disk")
  writeFileSync(p.vars, "live vars")
}

function fixture(display?: DisplayConfig): Manifest {
  writeDisplay(pathsFor("source"), display ?? A)
  const compat = currentCompat("source", meta)
  const m: Manifest = {
    name: "saved", instance: "source", kind: "manual", createdAt: meta.created, bytes: 42,
    image: meta.image, compat: compat.hash, compatParts: compat.parts, format: "raw", ramFile: FILES.ramRaw,
    ...(display === undefined ? {} : { display }),
  }
  publish(m)
  return m
}

function publish(m: Manifest): void {
  const dir = saveDir(m.instance, m.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, FILES.manifest), JSON.stringify(m))
  writeFileSync(resolve(dir, m.ramFile ?? FILES.ram), "saved RAM")
  writeFileSync(resolve(dir, FILES.overlay), "saved disk")
  writeFileSync(resolve(dir, FILES.vars), "saved vars")
}

describe("saved display restoration", () => {
  beforeEach(() => {
    previousHome = process.env["WINVM_HOME"]
    state = mkdtempSync(resolve(tmpdir(), "winvm-saved-display-"))
    process.env["WINVM_HOME"] = state
    launches = []
    commands = []
    runningPid = 1234567
    mkdirSync(resolve(state, "images", meta.image), { recursive: true })
    writeFileSync(basePath(meta.image), "immutable base")
    writeFileSync(imageMetaPath(meta.image), JSON.stringify({ virtioBoot: true }))
    const code = resolve(state, "code.fd")
    const vars = resolve(state, "vars.fd")
    writeFileSync(code, "firmware")
    writeFileSync(vars, "variables")
    spyOn(host, "requireFirmware").mockReturnValue({ code, vars })
    spyOn(host, "tpmTisHasPpi").mockReturnValue(true)
    spyOn(runtime, "currentQemuCompat").mockReturnValue("11.1.2+patches:none")
    spyOn(runtime, "runtimeBin").mockImplementation((name) => `/test/bin/${name}`)
    spyOn(host, "run").mockImplementation((_cmd, args) => {
      writeFileSync(args.at(-1)!, "created disk")
      return 0
    })
    spyOn(media, "makeResultVolume").mockImplementation((path) => { writeFileSync(path, "result") })
    spyOn(qemu, "pidOf").mockImplementation(() => runningPid)
    spyOn(qemu, "stopSwtpm").mockImplementation(() => undefined)
    spyOn(qemu, "isRunning").mockReturnValue(true)
    spyOn(qemu, "launch").mockImplementation(async (name, p, m, options) => {
      launches = [...launches, [...qemu.qemuArgs(name, p, m, options)]]
    })
    spyOn(qmp, "status").mockResolvedValue("running")
    spyOn(qmp, "execute").mockImplementation(async (_socket, cmd, args) => {
      commands.push(cmd)
      if (cmd === "quit") runningPid = null
      if (cmd === "query-migrate") return { status: "completed", ram: { transferred: 10 } }
      if (cmd === "migrate") {
        const uri = (args as { uri: string }).uri
        const path = uri.startsWith("file:") ? uri.slice("file:".length) : / -o '([^']+)'$/.exec(uri)?.[1]
        if (path === undefined) throw new Error(`unexpected migration URI: ${uri}`)
        writeFileSync(path, "captured RAM")
      }
      return {}
    })
    spyOn(guestdisplay, "liveDisplay").mockReturnValue(A)
    spyOn(console, "log").mockImplementation(() => undefined)
    makeInstance("source")
  })

  afterEach(() => {
    mock.restore()
    if (previousHome === undefined) delete process.env["WINVM_HOME"]
    else process.env["WINVM_HOME"] = previousHome
    rmSync(state, { recursive: true, force: true })
  })

  it("uses an explicit launch profile instead of the pending preference, except during installation", () => {
    const p = pathsFor("source")
    writeDisplay(p, B)
    const options = { installMedia: false, ephemeral: false, virtioBoot: true, display: A }
    expect(qemu.qemuArgs("source", p, meta, options)).toContain("virtio-gpu-pci,xres=1920,yres=1080")
    expect(qemu.qemuArgs("source", p, meta, { ...options, installMedia: true })).toContain("ramfb")
    expect(qemu.qemuArgs("source", p, meta, { ...options, display: undefined })).toContain("virtio-gpu-pci,xres=2560,yres=1440")
    expect(readDisplay(p)).toEqual(B)
  })

  it("loads the saved GPU without changing today's preference", async () => {
    fixture(A)
    const p = pathsFor("source")
    writeDisplay(p, B)
    const preference = readFileSync(displayPath(p), "utf8")
    await loadSave("source", "saved")
    expect(launches[0]).toContain("virtio-gpu-pci,xres=1920,yres=1080")
    expect(launches[0]).not.toContain("virtio-gpu-pci,xres=2560,yres=1440")
    expect(readFileSync(p.overlay, "utf8")).toBe("saved disk")
    expect(readFileSync(p.vars, "utf8")).toBe("saved vars")
    expect(readFileSync(displayPath(p), "utf8")).toBe(preference)
  })

  it("restores ramfb even when a GPU is configured", async () => {
    fixture({ device: "ramfb" })
    writeDisplay(pathsFor("source"), B)
    await loadSave("source", "saved")
    expect(launches[0]).toContain("ramfb")
    expect(launches[0]?.join(" ")).not.toContain("virtio-gpu-pci")
  })

  it("captures the actual running display and its hash, including after a restore", async () => {
    const saved = fixture(A)
    writeDisplay(pathsFor("source"), B)
    await loadSave("source", "saved")
    const result = await createSave("source", { name: "again", kind: "manual", format: "raw" })
    expect(result.manifest.display).toEqual(A)
    expect(result.manifest.compat).toBe(saved.compat)
    expect(readSave("source", "again")?.display).toEqual(A)
    expect(readDisplay(pathsFor("source"))).toEqual(B)
  })

  it("refuses an unidentified running display before stopping or migrating", async () => {
    spyOn(guestdisplay, "liveDisplay").mockReturnValue(null)
    await expect(createSave("source", { name: "unknown", kind: "manual", format: "raw" })).rejects.toThrow(/display/)
    expect(commands).toEqual([])
    expect(existsSync(saveDir("source", "unknown"))).toBe(false)
  })

  it("preserves the profile when cloning to a missing instance and loads it there", async () => {
    fixture(A)
    const clone = await cloneSave("source", "target", "saved")
    expect(clone.display).toEqual(A)
    expect(clone.clonedFrom?.instance).toBe("source")
    expect(readDisplay(pathsFor("target"))).toEqual({ device: "ramfb" })
    await loadSave("target", "saved")
    expect(launches[0]).toContain("virtio-gpu-pci,xres=1920,yres=1080")
  })

  it("loads a retained save after destroy removes the display preferences", async () => {
    fixture(A)
    spyOn(qemu, "isRunning").mockReturnValue(false)
    expect(destroy(parseArgs(["-i", "source", "--keep-saves"]))).toBe(0)
    expect(readMeta("source")).toBeNull()
    spyOn(qemu, "isRunning").mockReturnValue(true)
    await loadSave("source", "saved")
    expect(launches[0]).toContain("virtio-gpu-pci,xres=1920,yres=1080")
    expect(existsSync(displayPath(pathsFor("source")))).toBe(false)
  })

  it("keeps legacy saves strict and explains how to restore their display", async () => {
    fixture()
    writeDisplay(pathsFor("source"), B)
    await expect(loadSave("source", "saved")).rejects.toThrow(/original display/)
    expect(launches).toEqual([])
    writeDisplay(pathsFor("source"), A)
    await loadSave("source", "saved")
    expect(launches[0]).toContain("virtio-gpu-pci,xres=1920,yres=1080")
  })

  it("still rejects every other compatibility mismatch without replacing disks or stopping the guest", async () => {
    const saved = fixture(A)
    writeDisplay(pathsFor("source"), B)
    for (const part of ["base", "hardware", "firmware", "qemu"] as const) {
      const parts = { ...saved.compatParts!, [part]: "different" }
      const { compatHash } = await import("../src/saves")
      publish({ ...saved, compat: compatHash(parts), compatParts: parts })
      await expect(loadSave("source", "saved")).rejects.toThrow(/cannot be loaded/)
      expect(readFileSync(pathsFor("source").overlay, "utf8")).toBe("live disk")
    }
    expect(commands).toEqual([])
    expect(launches).toEqual([])
    expect(readDisplay(pathsFor("source"))).toEqual(B)
  })

  it("refuses an incomplete or malformed profiled save before stopping the guest", async () => {
    fixture(A)
    rmSync(resolve(saveDir("source", "saved"), FILES.vars))
    await expect(loadSave("source", "saved")).rejects.toThrow(/incomplete/)
    writeFileSync(resolve(saveDir("source", "saved"), FILES.manifest), JSON.stringify({ ...fixture(A), display: null }))
    await expect(loadSave("source", "saved")).rejects.toThrow()
    expect(commands).toEqual([])
    expect(launches).toEqual([])
    expect(readFileSync(pathsFor("source").overlay, "utf8")).toBe("live disk")
  })

  it("reports the running display to status and the viewer instead of the pending preference", async () => {
    writeDisplay(pathsFor("source"), B)
    for (const [device, expected] of [
      ["virtio-gpu-pci,xres=1920,yres=1080", "virtio-gpu 1920x1080"],
      ["ramfb", "ramfb (firmware framebuffer, 800x600)"],
    ]) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "-smp", "4", "-m", "4096", "-device", device!], { stdio: "ignore" })
      try {
        expect(child.pid).toBeDefined()
        spyOn(qemu, "pidOf").mockReturnValue(child.pid!)
        const report = await gather("source", false)
        expect(report.screen).toBe(expected!)
        expect(report.cpus).toBe(4)
        expect(report.memoryMiB).toBe(4096)
      } finally {
        const exited = new Promise((resolve) => child.once("exit", resolve))
        child.kill()
        await exited
      }
    }
    spyOn(qemu, "pidOf").mockReturnValue(null)
    expect((await gather("source", false)).screen).toBe("virtio-gpu 2560x1440")
  })

  it("explains that new file saves replay their display while internal snapshots still need a matching device", async () => {
    writeDisplay(pathsFor("source"), A)
    spyOn(guestdisplay, "liveSize").mockResolvedValue({ width: 1920, height: 1080 })
    const log = spyOn(console, "log")
    expect(await screen.display(parseArgs(["-i", "source", "2560x1440"]))).toBe(0)
    const output = log.mock.calls.map((call) => String(call[0])).join("\n")
    expect(output).toContain("file saves restore their captured display")
    expect(output).toContain("internal snapshots")
    expect(output).not.toContain("snapshots and saves taken with the previous display can't be restored")
  })

  it("recalls a stow with the saved display instead of silently cold booting", async () => {
    const saved = fixture(A)
    publish({ ...saved, name: "stow", kind: "stow" })
    writeDisplay(pathsFor("source"), B)
    spyOn(qga, "waitResponsive").mockResolvedValue(true)
    spyOn(clock, "syncGuestClock").mockResolvedValue({ beforeOffsetMs: 0, afterOffsetMs: 0 })
    expect(await savecmds.recallStow("source", parseArgs([]))).toBe(0)
    expect(launches[0]).toContain("virtio-gpu-pci,xres=1920,yres=1080")
    expect(readSave("source", "stow")).toBeNull()
  })

  it("keeps an existing baseline restorable under its captured display", async () => {
    const saved = fixture(A)
    publish({ ...saved, name: "baseline", kind: "baseline", note: "original baseline" })
    writeDisplay(pathsFor("source"), B)
    markPristine("source")
    spyOn(clock, "alignGuestTimeZone").mockResolvedValue({ from: "UTC", to: "UTC", changed: false })
    spyOn(clock, "syncGuestClock").mockResolvedValue({ beforeOffsetMs: 0, afterOffsetMs: 0 })
    spyOn(qga, "waitResponsive").mockResolvedValue(true)
    await savecmds.afterBoot("source", parseArgs([]))
    expect(readSave("source", "baseline")?.note).toBe("original baseline")
    expect(isPristine("source")).toBe(false)
    expect(commands).toEqual([])
  })

  it("lists saves with different captured displays as compatible, including retained saves", () => {
    const gpu = fixture(A)
    publish({ ...gpu, name: "gpu" })
    const ramfb = fixture({ device: "ramfb" })
    publish({ ...ramfb, name: "ramfb" })
    writeDisplay(pathsFor("source"), B)
    const log = spyOn(console, "log")
    expect(savecmds.list(parseArgs(["-i", "source", "--json"])) ).toBe(0)
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { compatible: boolean | null }[]
    expect(report.map((r) => r.compatible)).toEqual([true, true, true])
    rmSync(pathsFor("source").dir, { recursive: true })
    savecmds.list(parseArgs(["-i", "source", "--json"]))
    const retained = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { compatible: boolean | null }[]
    expect(retained.map((r) => r.compatible)).toEqual([true, true, true])
    expect(savesReport(listSaves("source"), null)).toHaveLength(3)
  })
})
