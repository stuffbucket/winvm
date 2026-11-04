/**
 * A file save restores with the display QEMU was RUNNING when it was taken,
 * whatever display.json (the cold-boot preference) says now: captured at save,
 * validated and replayed at load, kept through clone, retained-save
 * recreation, stow, baseline and listing, and reported by status.
 *
 * QEMU, swtpm and the monitor are faked at their edges (scripts in a fake
 * runtime, a scripted qmp), so `launch` itself runs and its real command line
 * and virtiofsd decision are what the assertions see.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import * as clock from "../src/clock"
import * as display from "../src/display"
import { RAMFB, VIRTIO_GPU, displayFromCommandLine, displayPath, readDisplay, writeDisplay, type DisplayConfig } from "../src/display"
import * as host from "../src/host"
import * as media from "../src/media"
import { basePath, imageMetaPath, pathsFor, readMeta, type InstanceMeta } from "../src/paths"
import * as qemu from "../src/qemu"
import * as qga from "../src/qga"
import * as qmp from "../src/qmp"
import * as savecmds from "../src/savecmds"
import * as screen from "../src/screen"
import * as service from "../src/service"
import * as share from "../src/share"
import { gather } from "../src/status"
import * as vnc from "../src/vnc"
import {
  FILES,
  cloneSave,
  compatHash,
  createSave,
  currentCompat,
  isPristine,
  loadSave,
  markPristine,
  readSave,
  saveDir,
  savesDir,
  type Manifest,
} from "../src/saves"

const SIZED: DisplayConfig = { device: "virtio-gpu", legacySize: { width: 1920, height: 1080 } }
const FAKE_PID = 1_234_567
const meta: InstanceMeta = { image: "win11-arm64", vnc: 9, created: "2026-11-02T00:00:00Z" }

let state = ""
let previous: Record<string, string | undefined> = {}
let previousProbe: share.Probe
/** What the QEMU already running when a test starts was launched with. */
let initialRunning: DisplayConfig | null = VIRTIO_GPU
/** The shared folder devices that QEMU launched with; undefined: whatever winvm launches for its display. */
let initialDevices: share.DeviceSet | undefined
/** When set, the running command line spells the home with this (a path with a space) instead. */
let spacedHome: string | null = null
let runningPid: number | null = FAKE_PID
let commands: string[] = []
let virtiofsd = 0
let statusCalls = 0
let answered = 0
const realRunningCommand = display.runningCommand

const qemuLog = (): string => resolve(state, "qemu.log")
/** Each QEMU launch's command line, in order. */
const launches = (): readonly string[] => (existsSync(qemuLog()) ? readFileSync(qemuLog(), "utf8").split("\n").filter((l) => l !== "") : [])
const lastLaunch = (): string => launches().at(-1) ?? ""

function script(name: string, body: string): void {
  const path = resolve(state, "runtime", "bin", name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

function makeInstance(name: string): void {
  const p = pathsFor(name)
  mkdirSync(p.tpmDir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify(meta))
  writeFileSync(p.overlay, "live disk")
  writeFileSync(p.vars, "live vars")
  writeFileSync(p.qmp, "")
}

function publish(m: Manifest): void {
  const dir = saveDir(m.instance, m.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, FILES.manifest), JSON.stringify(m))
  writeFileSync(resolve(dir, m.ramFile ?? FILES.ram), "saved RAM")
  writeFileSync(resolve(dir, FILES.overlay), "saved disk")
  writeFileSync(resolve(dir, FILES.vars), "saved vars")
}

/** A save of "source" taken with `shown` running; legacy (no profile) when `profiled` is false, hashed under the preference then. */
function fixture(shown: DisplayConfig, profiled = true, name = "saved", kind: Manifest["kind"] = "manual"): Manifest {
  const compat = profiled ? currentCompat("source", meta, shown) : (writeDisplay(pathsFor("source"), shown), currentCompat("source", meta))
  const m: Manifest = {
    name,
    instance: "source",
    kind,
    createdAt: meta.created,
    bytes: 42,
    image: meta.image,
    compat: compat.hash,
    compatParts: compat.parts,
    format: "raw",
    ramFile: FILES.ramRaw,
    ...(profiled ? { display: shown } : {}),
  }
  publish(m)
  return m
}

beforeEach(() => {
  previous = { WINVM_HOME: process.env["WINVM_HOME"], WINVM_RUNTIME: process.env["WINVM_RUNTIME"], WINVM_TEST_QEMU_LOG: process.env["WINVM_TEST_QEMU_LOG"] }
  state = mkdtempSync(resolve(tmpdir(), "winvm-saved-display-"))
  process.env["WINVM_HOME"] = state
  process.env["WINVM_RUNTIME"] = resolve(state, "runtime")
  process.env["WINVM_TEST_QEMU_LOG"] = qemuLog()
  mkdirSync(resolve(state, "runtime", "bin"), { recursive: true })
  // `launch` runs for real against these: swtpm binds its socket, QEMU records its arguments and stays up.
  script("swtpm", 'while [ $# -gt 0 ]; do case "$1" in --ctrl) s="${2#*path=}"; s="${s%%,*}"; shift;; esac; shift; done; : > "$s"')
  script("qemu-system-aarch64", 'printf "%s\\n" "$*" >> "$WINVM_TEST_QEMU_LOG"; exec sleep 3')
  previousProbe = share.setProbe(() => ({ ok: true, reason: null }))
  initialRunning = VIRTIO_GPU
  initialDevices = undefined
  spacedHome = null
  runningPid = FAKE_PID
  commands = []
  virtiofsd = 0
  statusCalls = 0
  answered = 0

  mkdirSync(resolve(state, "images", meta.image), { recursive: true })
  writeFileSync(basePath(meta.image), "immutable base")
  writeFileSync(imageMetaPath(meta.image), JSON.stringify({ virtioBoot: true }))
  const code = resolve(state, "code.fd")
  const vars = resolve(state, "vars.fd")
  writeFileSync(code, "firmware")
  writeFileSync(vars, "variables")
  spyOn(host, "requireFirmware").mockReturnValue({ code, vars })
  spyOn(host, "tpmTisHasPpi").mockReturnValue(true)
  spyOn(host, "run").mockImplementation((_cmd, args) => {
    writeFileSync(args.at(-1) ?? "", "created disk")
    return 0
  })
  spyOn(media, "makeResultVolume").mockImplementation((path) => {
    writeFileSync(path, "result")
  })
  // The control service is what answers on p.qmp; a new instance has no socket until it starts.
  spyOn(service, "ensureService").mockImplementation(async (_name, p) => {
    writeFileSync(p.qmp, "")
    return {} as never
  })
  spyOn(vnc, "ensureFreeDisplay").mockImplementation(async (_name, _p, m) => m)
  spyOn(vnc, "applyPassword").mockResolvedValue(null)
  spyOn(share, "startVirtiofsd").mockImplementation(async () => {
    virtiofsd += 1
    return { dir: state, readonly: false, folder: null }
  })
  spyOn(qemu, "pidOf").mockImplementation(() => runningPid)
  spyOn(qemu, "isRunning").mockImplementation(() => runningPid !== null)
  spyOn(qmp, "status").mockImplementation(async () => {
    statusCalls += 1
    return "running"
  })
  spyOn(qmp, "execute").mockImplementation(async (_socket, cmd, args) => {
    commands.push(cmd)
    if (cmd === "quit") runningPid = null
    // The new QEMU's monitor answering means it is up: wait for the fake to have recorded its command line.
    if (cmd === "query-status") {
      answered += 1
      for (let i = 0; i < 300 && launches().length < answered; i += 1) await new Promise((r) => setTimeout(r, 10))
      runningPid = FAKE_PID
    }
    if (cmd === "query-migrate") return { status: "completed", ram: { transferred: 10 } }
    if (cmd === "migrate") {
      const uri = (args as { uri: string }).uri
      const path = uri.startsWith("file:") ? uri.slice("file:".length) : / -o '([^']+)'$/.exec(uri)?.[1]
      if (path === undefined) throw new Error(`unexpected migration URI: ${uri}`)
      writeFileSync(path, "captured RAM")
    }
    return {}
  })
  // What the running QEMU was launched with: a real command line for the fixture's profile until something launches one.
  spyOn(display, "runningCommand").mockImplementation((pid) => {
    if (pid !== FAKE_PID) return realRunningCommand(pid)
    if (launches().length > 0) return lastLaunch()
    if (initialRunning === null) return "qemu-system-aarch64 -display none"
    const options = { installMedia: false, ephemeral: false, virtioBoot: true, display: initialRunning } as const
    const args = qemu.qemuArgs("source", pathsFor("source"), meta, initialDevices === undefined ? options : { ...options, shareDevices: initialDevices })
    const command = ["qemu-system-aarch64", ...args].join(" ")
    return spacedHome === null ? command : command.replaceAll(state, spacedHome)
  })
  spyOn(console, "log").mockImplementation(() => undefined)
  makeInstance("source")
})

afterEach(() => {
  mock.restore()
  share.setProbe(previousProbe)
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(state, { recursive: true, force: true })
})

describe("capturing the running display", () => {
  it("records the display actually running, and hashes that, not the pending preference", async () => {
    writeDisplay(pathsFor("source"), RAMFB)
    initialRunning = VIRTIO_GPU
    const result = await createSave("source", { name: "now", kind: "manual", format: "raw" })
    expect(result.manifest.display).toEqual(VIRTIO_GPU)
    expect(result.manifest.compat).toBe(currentCompat("source", meta, VIRTIO_GPU).hash)
    expect(result.manifest.compat).not.toBe(currentCompat("source", meta, RAMFB).hash)
    expect(readSave("source", "now")?.display).toEqual(VIRTIO_GPU)
    expect(readDisplay(pathsFor("source"))).toEqual(RAMFB)
  })

  it("records an earlier winvm's sized virtio-gpu exactly", async () => {
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    initialRunning = SIZED
    const result = await createSave("source", { name: "sized", kind: "manual", format: "raw" })
    expect(result.manifest.display).toEqual(SIZED)
    expect(result.manifest.compat).toBe(currentCompat("source", meta, SIZED).hash)
  })

  it("refuses an unidentified running display before any monitor command or save directory", async () => {
    initialRunning = null
    await expect(createSave("source", { name: "unknown", kind: "manual", format: "raw" })).rejects.toThrow(/display/)
    expect(commands).toEqual([])
    expect(statusCalls).toBe(0)
    expect(existsSync(savesDir("source"))).toBe(false)
  })

  it("refuses the temporary ramfb-plus-share-devices boot of `share install`, before anything is stopped or written", async () => {
    // What installGuest launches: display.json is ramfb and the devices are forced on.
    writeDisplay(pathsFor("source"), RAMFB)
    initialRunning = RAMFB
    initialDevices = "all"
    const command = display.runningCommand(FAKE_PID) ?? ""
    expect(command).toContain("-device ramfb")
    expect(command).toContain("memory-backend-shm")
    expect(command).toContain("vhost-user-fs-pci")
    // It parses as plain ramfb, which is why the display alone cannot be trusted.
    expect(displayFromCommandLine(command)).toEqual(RAMFB)
    await expect(createSave("source", { name: "during-install", kind: "manual", format: "raw" })).rejects.toThrow(/share install.*Save after it finishes/)
    expect(commands).toEqual([])
    expect(statusCalls).toBe(0)
    expect(existsSync(savesDir("source"))).toBe(false)
  })

  it("refuses the opposite mismatch too: virtio-gpu running without the devices its restore would launch", async () => {
    initialRunning = VIRTIO_GPU
    initialDevices = "none"
    await expect(createSave("source", { name: "bare", kind: "manual", format: "raw" })).rejects.toThrow(/temporary setup configuration/)
    expect(commands).toEqual([])
    expect(statusCalls).toBe(0)
    expect(existsSync(savesDir("source"))).toBe(false)
  })

  it("is not fooled by a space in a path, and still saves each ordinary configuration", async () => {
    // WINVM_HOME is in the arguments; a space there must not change what the devices say.
    spacedHome = resolve(state, "with space")
    for (const shown of [RAMFB, VIRTIO_GPU, SIZED]) {
      initialRunning = shown
      const result = await createSave("source", { name: "ok", kind: "manual", format: "raw" })
      expect(result.manifest.display).toEqual(shown)
    }
  })

  it("names an out-of-range legacy size instead of claiming there is no display device", async () => {
    spyOn(display, "runningCommand").mockReturnValue("qemu-system-aarch64 -device virtio-gpu-pci,xres=8000,yres=600 -display none")
    const refusal = createSave("source", { name: "huge", kind: "manual", format: "raw" })
    await expect(refusal).rejects.toThrow(/virtio-gpu profile \(xres=8000,yres=600\) that a save cannot record.*640x480 to 7680x4320.*winvm display/)
    await refusal.catch((error: Error) => expect(error.message).not.toContain("no single"))
    expect(commands).toEqual([])
    expect(statusCalls).toBe(0)
    expect(existsSync(savesDir("source"))).toBe(false)
  })
})

describe("loading a profiled save", () => {
  it("launches ramfb under a virtio-gpu preference, without shared folder devices or virtiofsd", async () => {
    fixture(RAMFB)
    const p = pathsFor("source")
    writeDisplay(p, VIRTIO_GPU)
    const preference = readFileSync(displayPath(p), "utf8")
    await loadSave("source", "saved")
    expect(launches()).toHaveLength(1)
    expect(lastLaunch()).toContain("-device ramfb")
    expect(lastLaunch()).not.toContain("virtio-gpu-pci")
    expect(lastLaunch()).not.toContain("vhost-user-fs-pci")
    expect(lastLaunch()).not.toContain("memory-backend-shm")
    expect(virtiofsd).toBe(0)
    expect(readFileSync(p.overlay, "utf8")).toBe("saved disk")
    expect(readFileSync(p.vars, "utf8")).toBe("saved vars")
    expect(readFileSync(displayPath(p), "utf8")).toBe(preference)
  })

  it("launches virtio-gpu under a ramfb preference, with the memory backend and share devices, and starts virtiofsd", async () => {
    fixture(VIRTIO_GPU)
    const p = pathsFor("source")
    writeDisplay(p, RAMFB)
    const preference = readFileSync(displayPath(p), "utf8")
    await loadSave("source", "saved")
    expect(lastLaunch()).toContain("-device virtio-gpu-pci ")
    expect(lastLaunch()).not.toContain("-device ramfb")
    expect(lastLaunch()).toContain("memory-backend-shm")
    expect(lastLaunch()).toContain("vhost-user-fs-pci")
    expect(virtiofsd).toBe(1)
    expect(readFileSync(displayPath(p), "utf8")).toBe(preference)
  })

  it("replays a saved legacy size exactly", async () => {
    fixture(SIZED)
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    await loadSave("source", "saved")
    expect(lastLaunch()).toContain("-device virtio-gpu-pci,xres=1920,yres=1080 ")
    expect(virtiofsd).toBe(1)
  })

  it("replays the saved processors and memory together with the display", async () => {
    const hardware = { cpus: 6, memoryMiB: 8192 }
    const compat = currentCompat("source", meta, RAMFB, hardware)
    publish({ ...fixture(RAMFB), compat: compat.hash, compatParts: compat.parts, hardware })
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    await loadSave("source", "saved")
    expect(lastLaunch()).toContain("-smp 6 -m 8192")
    expect(lastLaunch()).toContain("-device ramfb")
  })

  it("a save made after a restore captures the restored display again, with the same hash", async () => {
    const saved = fixture(RAMFB)
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    await loadSave("source", "saved")
    const again = await createSave("source", { name: "again", kind: "manual", format: "raw" })
    expect(again.manifest.display).toEqual(RAMFB)
    expect(again.manifest.compat).toBe(saved.compat)
    expect(readSave("source", "again")?.display).toEqual(RAMFB)
    expect(readDisplay(pathsFor("source"))).toEqual(VIRTIO_GPU)
  })

  it("loads a retained save after its instance is gone, without writing a preference to match", async () => {
    fixture(RAMFB)
    rmSync(pathsFor("source").dir, { recursive: true })
    expect(readMeta("source")).toBeNull()
    await loadSave("source", "saved")
    expect(lastLaunch()).toContain("-device ramfb")
    expect(virtiofsd).toBe(0)
    // The new instance keeps the cold-boot preference a new instance gets, not the save's display.
    expect(readDisplay(pathsFor("source"))).toEqual(VIRTIO_GPU)
  })

  it("keeps legacy saves strict: the preference decides, and a mismatch says how to restore it", async () => {
    fixture(VIRTIO_GPU, false)
    writeDisplay(pathsFor("source"), RAMFB)
    await expect(loadSave("source", "saved")).rejects.toThrow(/no recorded display[^]*winvm display/)
    expect(commands).toEqual([])
    expect(launches()).toEqual([])
    expect(readFileSync(pathsFor("source").overlay, "utf8")).toBe("live disk")
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    await loadSave("source", "saved")
    expect(lastLaunch()).toContain("-device virtio-gpu-pci ")
  })

  it("rejects every unrelated mismatch before stopping the guest or replacing a disk", async () => {
    const saved = fixture(RAMFB)
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    for (const part of ["base", "hardware", "firmware", "qemu"] as const) {
      const parts = { ...saved.compatParts!, [part]: "different" }
      publish({ ...saved, compat: compatHash(parts), compatParts: parts })
      await expect(loadSave("source", "saved")).rejects.toThrow(/cannot be loaded/)
      expect(readFileSync(pathsFor("source").overlay, "utf8")).toBe("live disk")
    }
    expect(commands).toEqual([])
    expect(launches()).toEqual([])
    expect(readDisplay(pathsFor("source"))).toEqual(VIRTIO_GPU)
  })

  it("refuses an incomplete or malformed profiled save before stopping the guest", async () => {
    const saved = fixture(RAMFB)
    rmSync(resolve(saveDir("source", "saved"), FILES.vars))
    await expect(loadSave("source", "saved")).rejects.toThrow(/incomplete/)
    for (const bad of [null, { device: "other" }, { device: "virtio-gpu", legacySize: { width: 1920 } }]) {
      writeFileSync(resolve(saveDir("source", "saved"), FILES.manifest), JSON.stringify({ ...saved, display: bad }))
      await expect(loadSave("source", "saved")).rejects.toThrow(/no save/)
    }
    expect(commands).toEqual([])
    expect(launches()).toEqual([])
    expect(readFileSync(pathsFor("source").overlay, "utf8")).toBe("live disk")
  })
})

describe("cloning", () => {
  it("keeps the profile and the target's cold-boot preference, and the clone loads with the profile", async () => {
    fixture(RAMFB)
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    const clone = await cloneSave("source", "target", "saved")
    expect(clone.display).toEqual(RAMFB)
    expect(clone.clonedFrom?.instance).toBe("source")
    expect(readSave("target", "saved")?.display).toEqual(RAMFB)
    // A new instance is seeded with the source's preference, as before: the save's display is not written to it.
    expect(readDisplay(pathsFor("target"))).toEqual(VIRTIO_GPU)
    await loadSave("target", "saved")
    expect(lastLaunch()).toContain("-device ramfb")
    expect(readDisplay(pathsFor("target"))).toEqual(VIRTIO_GPU)
  })

  it("onto an existing instance with another preference, judges the save by its profile", async () => {
    fixture(VIRTIO_GPU)
    makeInstance("target")
    writeDisplay(pathsFor("target"), RAMFB)
    const clone = await cloneSave("source", "target", "saved")
    expect(clone.display).toEqual(VIRTIO_GPU)
    expect(readDisplay(pathsFor("target"))).toEqual(RAMFB)
  })
})

describe("recalling and reusing", () => {
  const recall = (): Promise<number | null> => savecmds.recallStow("source", parseArgs([]))

  it("recalls a stow with its saved display instead of cold booting", async () => {
    fixture(RAMFB, true, "stow", "stow")
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    spyOn(qga, "waitResponsive").mockResolvedValue(true)
    spyOn(clock, "syncGuestClock").mockResolvedValue({ beforeOffsetMs: 0, afterOffsetMs: 0 } as never)
    expect(await recall()).toBe(0)
    expect(lastLaunch()).toContain("-device ramfb")
    expect(readSave("source", "stow")).toBeNull()
    expect(readDisplay(pathsFor("source"))).toEqual(VIRTIO_GPU)
  })

  it("still boots instead of recalling a legacy stow whose display no longer matches", async () => {
    fixture(VIRTIO_GPU, false, "stow", "stow")
    writeDisplay(pathsFor("source"), RAMFB)
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    expect(await recall()).toBeNull()
    expect(launches()).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(readSave("source", "stow")).not.toBeNull()
  })

  it("keeps an existing baseline whose display differs from the preference", async () => {
    fixture(RAMFB, true, "baseline", "baseline")
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    markPristine("source")
    spyOn(clock, "alignGuestTimeZone").mockResolvedValue({ from: "UTC", to: "UTC", changed: false } as never)
    spyOn(clock, "syncGuestClock").mockResolvedValue({ beforeOffsetMs: 0, afterOffsetMs: 0 } as never)
    await savecmds.afterBoot("source", parseArgs([]))
    expect(isPristine("source")).toBe(false)
    expect(commands).toEqual([])
    expect(readSave("source", "baseline")?.display).toEqual(RAMFB)
  })
})

describe("the display a launch resolves", () => {
  const options = { installMedia: false, ephemeral: false, virtioBoot: true } as const

  it("is one value for the command line and the sidecars: an explicit display beats the preference, a build is always ramfb", () => {
    const p = pathsFor("source")
    writeDisplay(p, VIRTIO_GPU)
    const preference = readFileSync(displayPath(p), "utf8")
    expect(qemu.launchDevices(p, { ...options, display: RAMFB })).toEqual({ display: RAMFB, devices: "none" })
    expect(qemu.launchDevices(p, options)).toEqual({ display: VIRTIO_GPU, devices: "all" })
    writeDisplay(p, RAMFB)
    expect(qemu.launchDevices(p, { ...options, display: SIZED })).toEqual({ display: SIZED, devices: "all" })
    expect(qemu.launchDevices(p, { ...options, installMedia: true, display: SIZED })).toEqual({ display: RAMFB, devices: "fs" })
    // `share install` boots ramfb WITH the devices: an explicit set still wins.
    expect(qemu.launchDevices(p, { ...options, shareDevices: "fs" })).toEqual({ display: RAMFB, devices: "fs" })
    writeDisplay(p, VIRTIO_GPU)
    expect(readFileSync(displayPath(p), "utf8")).toBe(preference)
  })

  it("puts the same devices on the command line as the sidecar decision names", () => {
    const p = pathsFor("source")
    writeDisplay(p, VIRTIO_GPU)
    for (const display of [RAMFB, VIRTIO_GPU, SIZED]) {
      const args = qemu.qemuArgs("source", p, meta, { ...options, display }).join(" ")
      const { devices } = qemu.launchDevices(p, { ...options, display })
      expect(args.includes("vhost-user-fs-pci")).toBe(devices !== "none")
      expect(args.includes("memory-backend-shm")).toBe(devices !== "none")
      // And a save's capture reads the display straight back off a real command line, share devices and all.
      expect(displayFromCommandLine(args)).toEqual(display)
    }
  })
})

describe("launch resolves the display once", () => {
  it("passes one resolution to the sidecar decision and the command line, even if the preference changes between", async () => {
    const p = pathsFor("source")
    // display.json read twice would see virtio-gpu first, then (a concurrent `winvm display ramfb`) ramfb.
    const reads = [VIRTIO_GPU, RAMFB, RAMFB]
    spyOn(display, "readDisplay").mockImplementation(() => reads.shift() ?? RAMFB)
    await qemu.launch("source", p, meta, { installMedia: false, ephemeral: false, virtioBoot: true })
    expect(virtiofsd).toBe(1)
    expect(lastLaunch()).toContain("-device virtio-gpu-pci ")
    expect(lastLaunch()).not.toContain("-device ramfb")
    expect(lastLaunch()).toContain("vhost-user-fs-pci")
  })

  it("keeps a build on ramfb with the filesystem device, and an explicit share set as given", async () => {
    const p = pathsFor("source")
    writeDisplay(p, VIRTIO_GPU)
    await qemu.launch("source", p, meta, { installMedia: true, ephemeral: false, virtioBoot: true, display: SIZED })
    expect(lastLaunch()).toContain("-device ramfb")
    expect(lastLaunch()).toContain("vhost-user-fs-pci")
    expect(lastLaunch()).not.toContain("qemu-vdagent")
    await qemu.launch("source", p, meta, { installMedia: false, ephemeral: false, virtioBoot: true, display: RAMFB, shareDevices: "all" })
    expect(lastLaunch()).toContain("-device ramfb")
    expect(lastLaunch()).toContain("vhost-user-fs-pci")
    expect(lastLaunch()).toContain("qemu-vdagent")
    expect(virtiofsd).toBe(2)
  })
})

describe("listing and switching", () => {
  const listed = (): { name: string; compatible: boolean | null }[] => {
    const log = spyOn(console, "log")
    expect(savecmds.list(parseArgs(["-i", "source", "--json"]))).toBe(0)
    return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { name: string; compatible: boolean | null }[]
  }

  it("lists profiled saves compatible under a different preference, and a legacy one by the preference", () => {
    fixture(VIRTIO_GPU, true, "gpu")
    fixture(RAMFB, true, "ramfb")
    fixture(VIRTIO_GPU, false, "legacy")
    writeDisplay(pathsFor("source"), RAMFB)
    expect(listed().map((r) => [r.name, r.compatible])).toEqual([
      ["gpu", true],
      ["legacy", false],
      ["ramfb", true],
    ])
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    expect(listed().map((r) => [r.name, r.compatible])).toEqual([
      ["gpu", true],
      ["legacy", true],
      ["ramfb", true],
    ])
  })

  it("lists profiled saves of a retained instance, which has no instance to measure", () => {
    fixture(VIRTIO_GPU, true, "gpu")
    fixture(RAMFB, true, "ramfb")
    fixture(RAMFB, false, "legacy")
    rmSync(pathsFor("source").dir, { recursive: true })
    expect(listed().map((r) => [r.name, r.compatible])).toEqual([
      ["gpu", true],
      ["legacy", null],
      ["ramfb", true],
    ])
  })

  it("prints the same answer in the table", () => {
    fixture(RAMFB, true, "ramfb")
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    const log = spyOn(console, "log")
    expect(savecmds.list(parseArgs(["-i", "source"]))).toBe(0)
    const row = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("ramfb"))
    expect(row).toMatch(/\byes\b/)
  })

  it("switching the preference strands only legacy saves, never a profiled one", async () => {
    spyOn(qemu, "isRunning").mockReturnValue(false)
    fixture(VIRTIO_GPU, true, "profiled")
    fixture(VIRTIO_GPU, false, "legacy")
    const log = spyOn(console, "log")
    expect(await screen.display(parseArgs(["-i", "source", "ramfb"]))).toBe(0)
    const out = log.mock.calls.map((c) => String(c[0])).join("\n")
    expect(readDisplay(pathsFor("source"))).toEqual(RAMFB)
    expect(out).toContain("(legacy)")
    expect(out).toContain("will not load on ramfb")
    expect(out).not.toContain("profiled")
    expect(out).toContain("saves that recorded their display still load on it")
    expect(listed().map((r) => [r.name, r.compatible])).toEqual([
      ["legacy", false],
      ["profiled", true],
    ])
  })
})

describe("status", () => {
  it("reports the launch display of a running process and the preference of a stopped one", async () => {
    writeDisplay(pathsFor("source"), SIZED)
    for (const [device, expected] of [
      ["ramfb", display.describeDisplay(RAMFB)],
      ["virtio-gpu-pci", display.describeDisplay(VIRTIO_GPU)],
    ] as const) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "-smp", "4", "-m", "4096", "-device", device], { stdio: "ignore" })
      try {
        expect(child.pid).toBeDefined()
        runningPid = child.pid ?? null
        const report = await gather("source", false)
        expect(report.screen).toBe(expected)
        expect(report.cpus).toBe(4)
        expect(report.memoryMiB).toBe(4096)
      } finally {
        const exited = new Promise((done) => child.once("exit", done))
        child.kill()
        await exited
      }
    }
    runningPid = null
    expect((await gather("source", false)).screen).toBe(display.describeDisplay(SIZED))
  })

  it("does not pass off the preference as the display of a process it cannot read", async () => {
    writeDisplay(pathsFor("source"), SIZED)
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "-smp", "4", "-m", "4096", "-device", "ramfb", "-device", "virtio-gpu-pci"], { stdio: "ignore" })
    try {
      runningPid = child.pid ?? null
      expect((await gather("source", false)).screen).toBeNull()
    } finally {
      const exited = new Promise((done) => child.once("exit", done))
      child.kill()
      await exited
    }
  })
})
