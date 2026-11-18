import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import { ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"

import { parseArgs } from "../src/args"
import * as clock from "../src/clock"
import * as display from "../src/display"
import {
  type DisplayConfig,
  displayFromCommandLine,
  displayPath,
  RAMFB,
  readDisplay,
  VIRTIO_GPU,
  writeDisplay,
} from "../src/display"
import { appendEntry, readSince, START } from "../src/eventlog"
import * as finder from "../src/finder"
import { resetToGolden } from "../src/golden"
import * as host from "../src/host"
import { hostEndFacts, hostEndSeams } from "../src/hostend"
import { hostPoweredOff } from "../src/hostoff"
import * as kept from "../src/kept"
import * as media from "../src/media"
import * as monitor from "../src/monitor"
import { withOperation } from "../src/operation"
import {
  basePath,
  type InstanceMeta,
  imageMetaPath,
  pathsFor,
  readMeta,
} from "../src/paths"
import * as proc from "../src/proc"
import * as qemu from "../src/qemu"
import * as qga from "../src/qga"
import * as qmp from "../src/qmp"
import { currentQemuCompat } from "../src/runtime"
import * as savecmds from "../src/savecmds"
import * as saves from "../src/saves"
import {
  cloneSave,
  compatFor,
  compatHash,
  createSave,
  currentCompat,
  FILES,
  isPristine,
  loadSave,
  type Manifest,
  markPristine,
  readSave,
  recallable,
  STOW_REFUSED,
  StowNotRecallable,
  saveDir,
  savesDir,
} from "../src/saves"
import * as screen from "../src/screen"
import * as servicectl from "../src/servicectl"
import * as share from "../src/share"
import * as shell from "../src/shell"
import {
  type MountEntry,
  mountDir,
  SHARE_KEYS,
  SHARES,
  writeSmb,
} from "../src/smbstate"
import { gather } from "../src/status"
import * as vnc from "../src/vnc"
import * as watcher from "../src/watch"

const SIZED: DisplayConfig = {
  device: "virtio-gpu",
  legacySize: { width: 1920, height: 1080 },
}
const FAKE_PID = 1_234_567
const meta: InstanceMeta = {
  image: "win11-arm64",
  vnc: 9,
  created: "2026-11-02T00:00:00Z",
}

let state = ""
let previous: Record<string, string | undefined> = {}
let previousProbe: share.Probe
let previousSettle: qemu.Settle
let previousSpawner: qemu.Spawner
let qemuOutput: string | null = null
let initialRunning: DisplayConfig | null = VIRTIO_GPU
let initialDevices: share.DeviceSet | undefined
let spacedHome: string | null = null
let runningPid: number | null = FAKE_PID
let commands: string[] = []
let virtiofsd = 0
let statusCalls = 0
let answered = 0
let settled = 0
let quitSawStow: boolean | null = null
let reported = { major: 11, minor: 1, micro: 2 }
let program = "qemu-system-aarch64"
const realRunningCommand = display.runningCommand

const qemuLog = (): string => resolve(state, "qemu.log")
const launches = (): readonly string[] =>
  existsSync(qemuLog())
    ? readFileSync(qemuLog(), "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : []
const lastLaunch = (): string => launches().at(-1) ?? ""

function fakeSpawner(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = new ChildProcess()
  const binary = basename(command)
  if (binary === "swtpm") {
    const sock = /path=([^,]+)/.exec(args.join(" "))?.[1]
    if (sock === undefined)
      throw new Error(`swtpm without a socket: ${args.join(" ")}`)
    writeFileSync(sock, "")
  } else if (binary === "qemu-system-aarch64") {
    appendFileSync(qemuLog(), `${args.join(" ")}\n`)
    runningPid = FAKE_PID
    const output = qemuOutput
    if (output !== null) {
      const fd = Array.isArray(options.stdio) ? options.stdio[1] : undefined
      if (typeof fd === "number") writeSync(fd, output)
      setImmediate(() => child.emit("exit", 1, null))
    }
  } else {
    throw new Error(`unexpected spawn: ${command}`)
  }
  return child
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

function fixture(
  shown: DisplayConfig,
  profiled = true,
  name = "saved",
  kind: Manifest["kind"] = "manual",
): Manifest {
  if (!profiled) writeDisplay(pathsFor("source"), shown)
  const compat = profiled
    ? currentCompat("source", meta, shown)
    : currentCompat("source", meta)
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
  previous = {
    WINVM_HOME: process.env.WINVM_HOME,
    WINVM_RUNTIME: process.env.WINVM_RUNTIME,
  }
  state = mkdtempSync(resolve(tmpdir(), "winvm-saved-display-"))
  process.env.WINVM_HOME = state
  process.env.WINVM_RUNTIME = resolve(state, "runtime")
  mkdirSync(resolve(state, "runtime", "bin"), { recursive: true })
  qemuOutput = null
  previousSpawner = qemu.setSpawner(fakeSpawner)
  previousProbe = share.setProbe(() => ({ ok: true, reason: null }))
  settled = 0
  previousSettle = qemu.setSettle((survived) => {
    let cancelled = false
    settled += 1
    const target = settled
    const poll = (): void => {
      if (cancelled) return
      if (launches().length >= target && runningPid !== null) survived()
      else setTimeout(poll, 5)
    }
    poll()
    return () => {
      cancelled = true
    }
  })
  initialRunning = VIRTIO_GPU
  initialDevices = undefined
  spacedHome = null
  runningPid = FAKE_PID
  commands = []
  virtiofsd = 0
  statusCalls = 0
  answered = 0
  quitSawStow = null
  reported = { major: 11, minor: 1, micro: 2 }
  program = "qemu-system-aarch64"

  mkdirSync(resolve(state, "images", meta.image), { recursive: true })
  writeFileSync(basePath(meta.image), "immutable base")
  writeFileSync(imageMetaPath(meta.image), JSON.stringify({ virtioBoot: true }))
  const code = resolve(state, "code.fd")
  const vars = resolve(state, "vars.fd")
  writeFileSync(code, "firmware")
  writeFileSync(vars, "variables")
  spyOn(host, "requireFirmware").mockReturnValue({ code, vars })
  spyOn(host, "tpmTisHasPpi").mockReturnValue(true)
  spyOn(shell, "run").mockImplementation((_cmd, args) => {
    writeFileSync(args.at(-1) ?? "", "created disk")
    return 0
  })
  spyOn(media, "makeResultVolume").mockImplementation((path) => {
    writeFileSync(path, "result")
  })
  spyOn(servicectl, "ensureService").mockImplementation((_name, p) => {
    writeFileSync(p.qmp, "")
    return Promise.resolve({} as never)
  })
  spyOn(vnc, "ensureFreeDisplay").mockImplementation((_name, _p, m) =>
    Promise.resolve(m),
  )
  spyOn(vnc, "applyPassword").mockResolvedValue(null)
  spyOn(share, "startVirtiofsd").mockImplementation(() => {
    virtiofsd += 1
    return Promise.resolve({ dir: state, readonly: false, folder: null })
  })
  spyOn(qemu, "pidOf").mockImplementation(() => runningPid)
  spyOn(qemu, "isRunning").mockImplementation(() => runningPid !== null)
  spyOn(qmp, "status").mockImplementation(() => {
    statusCalls += 1
    return Promise.resolve("running")
  })
  spyOn(qmp, "execute").mockImplementation(async (_socket, cmd, args) => {
    commands.push(cmd)
    if (cmd === "quit") {
      quitSawStow = existsSync(
        resolve(saveDir("source", "stow"), FILES.manifest),
      )
      runningPid = null
    }
    if (cmd === "query-status") {
      answered += 1
      for (let i = 0; i < 300 && launches().length < answered; i += 1)
        await new Promise((r) => setTimeout(r, 10))
      runningPid = FAKE_PID
    }
    if (cmd === "query-migrate")
      return { status: "completed", ram: { transferred: 10 } }
    if (cmd === "migrate") {
      const uri = (args as { uri: string }).uri
      const path = uri.startsWith("file:")
        ? uri.slice("file:".length)
        : / -o '([^']+)'$/.exec(uri)?.[1]
      if (path === undefined)
        throw new Error(`unexpected migration URI: ${uri}`)
      writeFileSync(path, "captured RAM")
    }
    return {}
  })
  spyOn(display, "runningCommand").mockImplementation((pid) => {
    if (pid !== FAKE_PID) return realRunningCommand(pid)
    if (launches().length > 0) return lastLaunch()
    if (initialRunning === null) return "qemu-system-aarch64 -display none"
    const options = {
      installMedia: false,
      ephemeral: false,
      virtioBoot: true,
      display: initialRunning,
    } as const
    const args = qemu.qemuArgs(
      "source",
      pathsFor("source"),
      meta,
      initialDevices === undefined
        ? options
        : { ...options, shareDevices: initialDevices },
    )
    const command = [program, ...args].join(" ")
    return spacedHome === null ? command : command.replaceAll(state, spacedHome)
  })
  spyOn(console, "log").mockImplementation(() => undefined)
  spyOn(kept, "launchedRuntime").mockImplementation(
    async () => await Promise.resolve(currentQemuCompat()),
  )
  spyOn(monitor, "qmpCommand").mockImplementation(async (_socket, cmd) =>
    cmd === "query-version"
      ? await Promise.resolve({ qemu: reported, package: "" })
      : await Promise.reject(new Error(`unexpected ${cmd}`)),
  )
  makeInstance("source")
})

afterEach(() => {
  mock.restore()
  share.setProbe(previousProbe)
  qemu.setSettle(previousSettle)
  qemu.setSpawner(previousSpawner)
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
    const result = await createSave("source", {
      name: "now",
      kind: "manual",
      format: "raw",
    })
    expect(result.manifest.display).toEqual(VIRTIO_GPU)
    expect(result.manifest.compat).toBe(
      currentCompat("source", meta, VIRTIO_GPU).hash,
    )
    expect(result.manifest.compat).not.toBe(
      currentCompat("source", meta, RAMFB).hash,
    )
    expect(readSave("source", "now")?.display).toEqual(VIRTIO_GPU)
    expect(readDisplay(pathsFor("source"))).toEqual(RAMFB)
  })

  it("stamps a save with the runtime its QEMU was launched from, not the one installed since", async () => {
    initialRunning = VIRTIO_GPU
    const launched = spyOn(kept, "launchedRuntime").mockResolvedValue(
      "10.0.0+patches:old",
    )
    const result = await createSave("source", {
      name: "launched",
      kind: "manual",
      format: "raw",
    })
    expect(launched).toHaveBeenCalledWith(pathsFor("source"), FAKE_PID)
    expect(result.manifest.compatParts?.qemu).toBe("10.0.0+patches:old")
    expect(result.manifest.compat).toBe(
      currentCompat("source", meta, VIRTIO_GPU, undefined, "10.0.0+patches:old")
        .hash,
    )
    expect(result.manifest.compat).not.toBe(
      currentCompat("source", meta, VIRTIO_GPU).hash,
    )
  })

  it("records an earlier winvm's sized virtio-gpu exactly", async () => {
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    initialRunning = SIZED
    const result = await createSave("source", {
      name: "sized",
      kind: "manual",
      format: "raw",
    })
    expect(result.manifest.display).toEqual(SIZED)
    expect(result.manifest.compat).toBe(
      currentCompat("source", meta, SIZED).hash,
    )
  })

  it("refuses an unidentified running display before any monitor command or save directory", async () => {
    initialRunning = null
    await expect(
      createSave("source", { name: "unknown", kind: "manual", format: "raw" }),
    ).rejects.toThrow(/display/)
    expect(commands).toEqual([])
    expect(statusCalls).toBe(0)
    expect(existsSync(savesDir("source"))).toBe(false)
  })

  it("refuses the temporary ramfb-plus-share-devices boot of `share install`, before anything is stopped or written", async () => {
    writeDisplay(pathsFor("source"), RAMFB)
    initialRunning = RAMFB
    initialDevices = "all"
    const command = display.runningCommand(FAKE_PID) ?? ""
    expect(command).toContain("-device ramfb")
    expect(command).toContain("memory-backend-shm")
    expect(command).toContain("vhost-user-fs-pci")
    expect(displayFromCommandLine(command)).toEqual(RAMFB)
    await expect(
      createSave("source", {
        name: "during-install",
        kind: "manual",
        format: "raw",
      }),
    ).rejects.toThrow(/share install.*Save after it finishes/)
    expect(commands).toEqual([])
    expect(statusCalls).toBe(0)
    expect(existsSync(savesDir("source"))).toBe(false)
  })

  it("refuses the opposite mismatch too: virtio-gpu running without the devices its restore would launch", async () => {
    initialRunning = VIRTIO_GPU
    initialDevices = "none"
    await expect(
      createSave("source", { name: "bare", kind: "manual", format: "raw" }),
    ).rejects.toThrow(/temporary setup configuration/)
    expect(commands).toEqual([])
    expect(statusCalls).toBe(0)
    expect(existsSync(savesDir("source"))).toBe(false)
  })

  it("is not fooled by a space in a path, and still saves each ordinary configuration", async () => {
    spacedHome = resolve(state, "with space")
    for (const shown of [RAMFB, VIRTIO_GPU, SIZED]) {
      initialRunning = shown
      const result = await createSave("source", {
        name: "ok",
        kind: "manual",
        format: "raw",
      })
      expect(result.manifest.display).toEqual(shown)
    }
  })

  it("names an out-of-range legacy size instead of claiming there is no display device", async () => {
    spyOn(display, "runningCommand").mockReturnValue(
      "qemu-system-aarch64 -device virtio-gpu-pci,xres=8000,yres=600 -display none",
    )
    const refusal = createSave("source", {
      name: "huge",
      kind: "manual",
      format: "raw",
    })
    await expect(refusal).rejects.toThrow(
      /virtio-gpu profile \(xres=8000,yres=600\) that a save cannot record.*640x480 to 7680x4320.*winvm display/,
    )
    await refusal.catch((error: unknown) => {
      expect(error instanceof Error ? error.message : "").not.toContain(
        "no single",
      )
    })
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
    expect(lastLaunch()).toContain(
      "-device virtio-gpu-pci,xres=1920,yres=1080 ",
    )
    expect(virtiofsd).toBe(1)
  })

  it("replays the saved processors and memory together with the display", async () => {
    const hardware = { cpus: 6, memoryMiB: 8192 }
    const compat = currentCompat("source", meta, RAMFB, hardware)
    publish({
      ...fixture(RAMFB),
      compat: compat.hash,
      compatParts: compat.parts,
      hardware,
    })
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    await loadSave("source", "saved")
    expect(lastLaunch()).toContain("-smp 6 -m 8192")
    expect(lastLaunch()).toContain("-device ramfb")
  })

  it("a save made after a restore captures the restored display again, with the same hash", async () => {
    const saved = fixture(RAMFB)
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    await loadSave("source", "saved")
    const again = await createSave("source", {
      name: "again",
      kind: "manual",
      format: "raw",
    })
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
    expect(readDisplay(pathsFor("source"))).toEqual(VIRTIO_GPU)
  })

  it("keeps legacy saves strict: the preference decides, and a mismatch says how to restore it", async () => {
    fixture(VIRTIO_GPU, false)
    writeDisplay(pathsFor("source"), RAMFB)
    await expect(loadSave("source", "saved")).rejects.toThrow(
      /no recorded display[\s\S]*winvm display/,
    )
    expect(commands).toEqual([])
    expect(launches()).toEqual([])
    expect(readFileSync(pathsFor("source").overlay, "utf8")).toBe("live disk")
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    await loadSave("source", "saved")
    expect(lastLaunch()).toContain("-device virtio-gpu-pci ")
  })

  it("rejects every unrelated mismatch before stopping the guest or replacing a disk", async () => {
    const saved = fixture(RAMFB)
    const { compatParts } = saved
    if (compatParts === undefined)
      throw new Error("the fixture save records no compatParts")
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    for (const part of ["base", "hardware", "firmware", "qemu"] as const) {
      const parts = { ...compatParts, [part]: "different" }
      publish({ ...saved, compat: compatHash(parts), compatParts: parts })
      await expect(loadSave("source", "saved")).rejects.toThrow(
        /cannot be loaded/,
      )
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
    for (const bad of [
      null,
      { device: "other" },
      { device: "virtio-gpu", legacySize: { width: 1920 } },
    ]) {
      writeFileSync(
        resolve(saveDir("source", "saved"), FILES.manifest),
        JSON.stringify({ ...saved, display: bad }),
      )
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
  const recall = (): Promise<number | null> =>
    savecmds.recallStow("source", parseArgs([]))

  it("recalls a stow with its saved display instead of cold booting", async () => {
    fixture(RAMFB, true, "stow", "stow")
    writeDisplay(pathsFor("source"), VIRTIO_GPU)
    spyOn(qga, "waitResponsive").mockResolvedValue(true)
    spyOn(clock, "syncGuestClock").mockResolvedValue({
      beforeOffsetMs: 0,
      afterOffsetMs: 0,
    })
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
    spyOn(clock, "alignGuestTimeZone").mockResolvedValue({
      from: "UTC",
      to: "UTC",
      changed: false,
    })
    spyOn(clock, "syncGuestClock").mockResolvedValue({
      beforeOffsetMs: 0,
      afterOffsetMs: 0,
    })
    await savecmds.afterBoot("source", parseArgs([]))
    expect(isPristine("source")).toBe(false)
    expect(commands).toEqual([])
    expect(readSave("source", "baseline")?.display).toEqual(RAMFB)
  })
})

describe("the display a launch resolves", () => {
  const options = {
    installMedia: false,
    ephemeral: false,
    virtioBoot: true,
  } as const

  it("is one value for the command line and the sidecars: an explicit display beats the preference, a build is always ramfb", () => {
    const p = pathsFor("source")
    writeDisplay(p, VIRTIO_GPU)
    const preference = readFileSync(displayPath(p), "utf8")
    expect(qemu.launchDevices(p, { ...options, display: RAMFB })).toEqual({
      display: RAMFB,
      devices: "none",
    })
    expect(qemu.launchDevices(p, options)).toEqual({
      display: VIRTIO_GPU,
      devices: "all",
    })
    writeDisplay(p, RAMFB)
    expect(qemu.launchDevices(p, { ...options, display: SIZED })).toEqual({
      display: SIZED,
      devices: "all",
    })
    expect(
      qemu.launchDevices(p, { ...options, installMedia: true, display: SIZED }),
    ).toEqual({ display: RAMFB, devices: "fs" })
    expect(qemu.launchDevices(p, { ...options, shareDevices: "fs" })).toEqual({
      display: RAMFB,
      devices: "fs",
    })
    writeDisplay(p, VIRTIO_GPU)
    expect(readFileSync(displayPath(p), "utf8")).toBe(preference)
  })

  it("puts the same devices on the command line as the sidecar decision names", () => {
    const p = pathsFor("source")
    writeDisplay(p, VIRTIO_GPU)
    for (const display of [RAMFB, VIRTIO_GPU, SIZED]) {
      const args = qemu
        .qemuArgs("source", p, meta, { ...options, display })
        .join(" ")
      const { devices } = qemu.launchDevices(p, { ...options, display })
      expect(args.includes("vhost-user-fs-pci")).toBe(devices !== "none")
      expect(args.includes("memory-backend-shm")).toBe(devices !== "none")
      expect(displayFromCommandLine(args)).toEqual(display)
    }
  })
})

describe("launch resolves the display once", () => {
  it("passes one resolution to the sidecar decision and the command line, even if the preference changes between", async () => {
    const p = pathsFor("source")
    const reads = [VIRTIO_GPU, RAMFB, RAMFB]
    spyOn(display, "readDisplay").mockImplementation(
      () => reads.shift() ?? RAMFB,
    )
    runningPid = null
    await qemu.launch("source", p, meta, {
      installMedia: false,
      ephemeral: false,
      virtioBoot: true,
    })
    expect(virtiofsd).toBe(1)
    expect(lastLaunch()).toContain("-device virtio-gpu-pci ")
    expect(lastLaunch()).not.toContain("-device ramfb")
    expect(lastLaunch()).toContain("vhost-user-fs-pci")
  })

  it("keeps a build on ramfb with the filesystem device, and an explicit share set as given", async () => {
    const p = pathsFor("source")
    writeDisplay(p, VIRTIO_GPU)
    runningPid = null
    await qemu.launch("source", p, meta, {
      installMedia: true,
      ephemeral: false,
      virtioBoot: true,
      display: SIZED,
    })
    expect(lastLaunch()).toContain("-device ramfb")
    expect(lastLaunch()).toContain("vhost-user-fs-pci")
    expect(lastLaunch()).not.toContain("qemu-vdagent")
    runningPid = null
    await qemu.launch("source", p, meta, {
      installMedia: false,
      ephemeral: false,
      virtioBoot: true,
      display: RAMFB,
      shareDevices: "all",
    })
    expect(lastLaunch()).toContain("-device ramfb")
    expect(lastLaunch()).toContain("vhost-user-fs-pci")
    expect(lastLaunch()).toContain("qemu-vdagent")
    expect(virtiofsd).toBe(2)
  })
})

describe("launch outcome", () => {
  it("reports a qemu that exits at once, with its output, under the real settle window", async () => {
    qemu.setSettle()
    qemuOutput = "boom\n"
    runningPid = null
    await expect(
      qemu.launch("source", pathsFor("source"), meta, {
        installMedia: false,
        ephemeral: false,
        virtioBoot: true,
      }),
    ).rejects.toThrow(/qemu exited immediately:\n {2}boom/)
  })
})

describe("listing and switching", () => {
  const listed = (): { name: string; compatible: boolean | null }[] => {
    const log = spyOn(console, "log")
    expect(savecmds.list(parseArgs(["-i", "source", "--json"]))).toBe(0)
    return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      name: string
      compatible: boolean | null
    }[]
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
    const row = log.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("ramfb"))
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
      const child = spawn(
        process.execPath,
        [
          "-e",
          "setInterval(() => {}, 1000)",
          "--",
          "-smp",
          "4",
          "-m",
          "4096",
          "-device",
          device,
        ],
        { stdio: "ignore" },
      )
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
    expect((await gather("source", false)).screen).toBe(
      display.describeDisplay(SIZED),
    )
  })

  it("does not pass off the preference as the display of a process it cannot read", async () => {
    writeDisplay(pathsFor("source"), SIZED)
    const child = spawn(
      process.execPath,
      [
        "-e",
        "setInterval(() => {}, 1000)",
        "--",
        "-smp",
        "4",
        "-m",
        "4096",
        "-device",
        "ramfb",
        "-device",
        "virtio-gpu-pci",
      ],
      { stdio: "ignore" },
    )
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

describe("the host-end stow", () => {
  const hanging = (): {
    readonly sys: finder.QuickUnmount
    readonly killed: () => number
  } => {
    let killed = 0
    return {
      sys: {
        mountTable: () => ({
          done: Promise.resolve(
            SHARE_KEYS.map((key) => ({
              source: `//winvm-share@127.0.0.1:4455/${SHARES[key].share}`,
              dir: mountDir("source", key),
              type: "smbfs",
            })),
          ),
          kill: () => undefined,
        }),
        unmount: (dir) => {
          commands.push(`unmount ${dir}`)
          return {
            done: new Promise<unknown>(() => undefined),
            kill: () => {
              killed += 1
            },
          }
        },
      },
      killed: () => killed,
    }
  }

  it("unmounts the guest's drives before pausing it, within its budget even when an unmount hangs, and writes the stow before quitting", async () => {
    writeSmb(pathsFor("source"), {
      user: "winvm-share",
      password: "Wv1-aaaaaaaaaaaaaaaaaaaaaaaa",
      hostPort: 4455,
      mounted: ["home", "c"],
    })
    const u = hanging()
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 20)
    const started = Date.now()
    try {
      await hostEndSeams("source", { unmount: u.sys, unmountMs: 300 }).stow()
    } finally {
      clearInterval(timer)
    }
    expect(u.killed()).toBe(2)
    expect(commands.indexOf(`unmount ${mountDir("source", "home")}`)).toBe(0)
    expect(commands.indexOf("stop")).toBeGreaterThan(1)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(ticks).toBeGreaterThan(5)
    expect(quitSawStow).toBe(true)
    expect(readSave("source", "stow")?.kind).toBe("stow")
  })

  it("kills the mount listing too when it outlasts the budget", async () => {
    writeSmb(pathsFor("source"), {
      user: "winvm-share",
      password: "Wv1-aaaaaaaaaaaaaaaaaaaaaaaa",
      hostPort: 4455,
      mounted: ["home"],
    })
    let killed = 0
    const started = Date.now()
    const r = await finder.unmountWithin("source", 200, {
      mountTable: () => ({
        done: new Promise<readonly MountEntry[]>(() => undefined),
        kill: () => {
          killed += 1
        },
      }),
      unmount: () => ({ done: Promise.resolve(0), kill: () => undefined }),
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(killed).toBe(1)
    expect(r).toEqual({ unmounted: 0, left: 2 })
  })

  it("reads the running QEMU's facts: -snapshot, install media and the free space", async () => {
    spyOn(display, "runningCommand").mockReturnValue(
      "qemu-system-aarch64 -snapshot -drive if=none,media=cdrom,id=cd0",
    )
    const f = await hostEndFacts("source")
    expect(f.ephemeral).toBe(true)
    expect(f.installMedia).toBe(true)
    expect(f.unsaveable).toBeNull()
    expect(f.freeBytes).toBeGreaterThan(0)
    expect(f.action).toBe("stow")
  })
})

describe("partial saves left behind", () => {
  it("are cleared at the next save when their writer has gone, never while it runs", async () => {
    mkdirSync(savesDir("source"), { recursive: true })
    const dead = resolve(savesDir("source"), ".stow.partial-99999999")
    mkdirSync(dead)
    const writer = Bun.spawn(["sleep", "30"])
    const live = resolve(
      savesDir("source"),
      `.stow.partial-${String(writer.pid)}`,
    )
    mkdirSync(live)
    try {
      await createSave("source", {
        name: "later",
        kind: "manual",
        format: "raw",
      })
      expect(existsSync(dead)).toBe(false)
      expect(existsSync(live)).toBe(true)
    } finally {
      writer.kill("SIGKILL")
      await writer.exited
    }
  })
})

describe("the runtime a stow is labelled with", () => {
  const installed = (): void => {
    const manifest = resolve(state, "runtime", "manifest.json")
    writeFileSync(
      manifest,
      JSON.stringify({
        name: "winvm-runtime",
        version: "11.1.2-2",
        qemu: "11.1.2",
        qemuPatches: "p2",
        components: {},
        macho: [],
        files: {},
      }),
    )
    const old = new Date(Date.now() - 86_400_000)
    utimesSync(manifest, old, old)
  }
  beforeEach(() => {
    spyOn(kept, "launchedRuntime").mockResolvedValue(null)
  })
  const stow = async (): Promise<Manifest> =>
    (
      await createSave("source", {
        name: "stow",
        kind: "stow",
        format: "raw",
        quitAfter: true,
      })
    ).manifest

  it("is the version QEMU itself reports, runtime-unknown, for an adopted QEMU that is not the installed runtime's; no stow is written, and an older build's stow is refused naming --boot", async () => {
    installed()
    program = resolve(state, "runtime", "bin", "qemu-system-aarch64")
    reported = { major: 10, minor: 0, micro: 0 }
    await expect(stow()).rejects.toBeInstanceOf(StowNotRecallable)
    const named = await createSave("source", {
      name: "older",
      kind: "manual",
      format: "raw",
    })
    expect(named.manifest.compatParts?.qemu).toBe("10.0.0+patches:unknown")
    renameSync(saveDir("source", "older"), saveDir("source", "stow"))
    const manifest = resolve(saveDir("source", "stow"), FILES.manifest)
    writeFileSync(
      manifest,
      JSON.stringify({ ...named.manifest, name: "stow", kind: "stow" }),
    )
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    expect(
      await savecmds.recallStow("source", parseArgs(["-i", "source"])),
    ).toBe(1)
    const said = errors.mock.calls.map((c) => String(c[0])).join("\n")
    expect(said).toContain("10.0.0")
    expect(said).toContain("--boot")
    expect(readSave("source", "stow")).not.toBeNull()
  })

  it("is the installed runtime when QEMU reports its version and the runtime predates the process", async () => {
    installed()
    program = resolve(state, "runtime", "bin", "qemu-system-aarch64")
    spyOn(proc, "processAgeMs").mockReturnValue(3_600_000)
    expect((await stow()).compatParts?.qemu).toBe("11.1.2+patches:p2")
  })

  it("is runtime-unknown when the process can't be dated, and a QEMU of the same version may still recall it", async () => {
    installed()
    program = resolve(state, "runtime", "bin", "qemu-system-aarch64")
    const m = await stow()
    expect(m.compatParts?.qemu).toBe("11.1.2+patches:unknown")
    const saved = readSave("source", "stow")
    if (saved === null) throw new Error("no stow")
    expect(compatFor("source", meta, saved).hash).toBe(saved.compat)
    const log = spyOn(console, "log")
    expect(savecmds.list(parseArgs(["-i", "source", "--json"]))).toBe(0)
    const rows = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      name: string
      compatible: boolean | null
    }[]
    expect(rows.find((r) => r.name === "stow")?.compatible).toBe(true)
  })

  it("is the override runtime when QEMU runs from its directory, which has no manifest, and the binary predates the process", async () => {
    const binary = resolve(state, "runtime", "bin", "qemu-system-aarch64")
    writeFileSync(binary, "")
    const old = new Date(Date.now() - 86_400_000)
    utimesSync(binary, old, old)
    program = binary
    spyOn(proc, "processAgeMs").mockReturnValue(3_600_000)
    const m = await stow()
    expect(m.compatParts?.qemu).toBe(currentQemuCompat())
    expect(recallable(m.compatParts?.qemu ?? "")).toBe(true)
  })

  it("makes the host end shut a kept VM down when the keeper launched it on another runtime than the installed one", async () => {
    installed()
    spyOn(kept, "launchedRuntime").mockResolvedValue("11.0.0+patches:p1")
    const f = await hostEndFacts("source")
    expect(f.unsaveable).toContain("QEMU 11.0.0")
    expect(f.unsaveable).toContain("11.1.2")
  })

  it("decides recallability with the one predicate start uses", () => {
    expect(recallable("11.1.2+patches:p2", "11.1.2+patches:p2")).toBe(true)
    expect(recallable("11.1.2+patches:unknown", "11.1.2+patches:p2")).toBe(true)
    expect(recallable("11.0.0+patches:p1", "11.1.2+patches:p2")).toBe(false)
    expect(recallable("10.0.0+patches:unknown", "11.1.2+patches:p2")).toBe(
      false,
    )
    expect(recallable("unknown", "11.1.2+patches:p2")).toBe(false)
  })

  it("makes the host end shut an adopted QEMU of another version down rather than stow what no recall could take", async () => {
    installed()
    program = resolve(state, "runtime", "bin", "qemu-system-aarch64")
    reported = { major: 10, minor: 0, micro: 0 }
    const f = await hostEndFacts("source")
    expect(f.unsaveable).toContain("QEMU 10.0.0")
  })
})

describe("a recall that fails", () => {
  it("names --boot as the way out, so start is never stuck on the stow", async () => {
    await createSave("source", {
      name: "stow",
      kind: "stow",
      format: "raw",
      quitAfter: true,
    })
    spyOn(saves, "loadSave").mockRejectedValue(
      new Error('QEMU exited while loading save "stow"'),
    )
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    expect(
      await savecmds.recallStow("source", parseArgs(["-i", "source"])),
    ).toBe(1)
    const said = errors.mock.calls.map((c) => String(c[0])).join("\n")
    expect(said).toContain("QEMU exited while loading")
    expect(said).toContain("winvm start -i source --boot")
    expect(readSave("source", "stow")).not.toBeNull()
  })
})

describe("a stow whose QEMU will not quit", () => {
  it("is moved aside, so a later start never recalls it over newer disk writes", async () => {
    spyOn(saves, "quitQemu").mockRejectedValue(
      new Error("QEMU (pid 1234567) did not quit and could not be killed"),
    )
    await expect(
      createSave("source", {
        name: "stow",
        kind: "stow",
        format: "raw",
        quitAfter: true,
      }),
    ).rejects.toThrow("stow-unfinished")
    expect(readSave("source", "stow")).toBeNull()
    const aside = readSave("source", "stow-unfinished")
    expect(aside?.name).toBe("stow-unfinished")
    expect(aside?.kind).toBe("manual")
    expect(aside?.note).toContain("did not quit")
  })

  const stuck = (before: () => void = () => undefined): Promise<string> => {
    spyOn(saves, "quitQemu").mockImplementation(() => {
      before()
      return Promise.reject(
        new Error("QEMU (pid 1234567) did not quit and could not be killed"),
      )
    })
    return createSave("source", {
      name: "stow",
      kind: "stow",
      format: "raw",
      quitAfter: true,
    }).then(
      () => "",
      (e: unknown) => (e as Error).message,
    )
  }

  it("keeps an earlier unfinished stow it can't remove, and sets this one aside under a free name", async () => {
    const blocked = saveDir("source", "stow-unfinished")
    mkdirSync(blocked, { recursive: true })
    writeFileSync(resolve(blocked, "pinned"), "x")
    chmodSync(blocked, 0o500)
    try {
      const text = await stuck()
      expect(text).toContain("did not quit")
      expect(text).toContain('"stow-unfinished-2"')
      expect(readSave("source", "stow")).toBeNull()
      expect(readSave("source", "stow-unfinished-2")?.kind).toBe("manual")
      expect(existsSync(resolve(blocked, "pinned"))).toBe(true)
    } finally {
      chmodSync(blocked, 0o700)
    }
  })

  it("is kept where it is, marked so that start does not recall it, when it can't be moved, and an explicit load still can", async () => {
    const dir = savesDir("source")
    try {
      const text = await stuck(() => {
        chmodSync(dir, 0o500)
      })
      expect(text).toContain("did not quit")
      expect(text).toContain("could not be moved aside")
      expect(text).toContain("winvm load -i source stow")
      chmodSync(dir, 0o700)
      const marked = readSave("source", "stow")
      expect(marked?.unfinished).toBe(true)
      expect(marked?.kind).toBe("stow")
      const errors = spyOn(console, "error").mockImplementation(() => undefined)
      expect(
        await savecmds.recallStow("source", parseArgs(["-i", "source"])),
      ).toBe(1)
      const said = errors.mock.calls.map((c) => String(c[0])).join("\n")
      expect(said).toContain("winvm load -i source stow")
      expect(said).toContain("--boot")
      expect(commands).not.toContain("migrate-incoming")
      expect(readSave("source", "stow")).not.toBeNull()
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it("is still set aside, never deleted, when its manifest can't be rewritten there", async () => {
    const stow = saveDir("source", "stow")
    const aside = saveDir("source", "stow-unfinished")
    try {
      const text = await stuck(() => {
        chmodSync(stow, 0o500)
      })
      expect(text).toContain('"stow-unfinished"')
      expect(text).toContain("still calls it the stow")
      expect(existsSync(stow)).toBe(false)
      expect(readSave("source", "stow-unfinished")?.kind).toBe("stow")
    } finally {
      if (existsSync(aside)) chmodSync(aside, 0o700)
      if (existsSync(stow)) chmodSync(stow, 0o700)
    }
  })

  it("consumes the folder it loaded, and discards the real stow it supersedes, when that folder's manifest still calls it the stow", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    renameSync(saveDir("source", "stow"), saveDir("source", "stow-unfinished"))
    fixture(VIRTIO_GPU, true, "stow", "stow")
    spyOn(qga, "waitResponsive").mockResolvedValue(true)
    spyOn(clock, "syncGuestClock").mockResolvedValue({
      beforeOffsetMs: 0,
      afterOffsetMs: 0,
    })
    expect(
      await savecmds.load(parseArgs(["-i", "source", "stow-unfinished"])),
    ).toBe(0)
    expect(existsSync(saveDir("source", "stow-unfinished"))).toBe(false)
    expect(readSave("source", "stow")).toBeNull()
  })

  it("consumes the stow itself when the stow is what it loaded", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    spyOn(qga, "waitResponsive").mockResolvedValue(true)
    spyOn(clock, "syncGuestClock").mockResolvedValue({
      beforeOffsetMs: 0,
      afterOffsetMs: 0,
    })
    expect(await savecmds.load(parseArgs(["-i", "source", "stow"]))).toBe(0)
    expect(readSave("source", "stow")).toBeNull()
  })

  it("is kept as it is when it can be neither moved nor marked", async () => {
    const dir = savesDir("source")
    const stow = saveDir("source", "stow")
    try {
      const text = await stuck(() => {
        chmodSync(stow, 0o500)
        chmodSync(dir, 0o500)
      })
      expect(text).toContain("could not be moved aside")
      expect(text).toContain("--boot")
      chmodSync(dir, 0o700)
      chmodSync(stow, 0o700)
      expect(readSave("source", "stow")?.kind).toBe("stow")
    } finally {
      chmodSync(dir, 0o700)
      chmodSync(stow, 0o700)
    }
  })
})

describe("a stow the installed runtime could not recall", () => {
  const installedR11 = (): void => {
    const manifest = resolve(state, "runtime", "manifest.json")
    writeFileSync(
      manifest,
      JSON.stringify({
        name: "winvm-runtime",
        version: "11.1.2-2",
        qemu: "11.1.2",
        qemuPatches: "p2",
        components: {},
        macho: [],
        files: {},
      }),
    )
  }
  beforeEach(() => {
    installedR11()
    spyOn(kept, "launchedRuntime").mockResolvedValue("11.0.0+patches:p1")
  })

  it("is refused by createSave before the guest is paused, and nothing is written", async () => {
    let refusal: unknown = null
    await createSave("source", {
      name: "stow",
      kind: "stow",
      format: "raw",
      quitAfter: true,
    }).catch((e: unknown) => {
      refusal = e
    })
    expect(refusal).toBeInstanceOf(StowNotRecallable)
    const text = (refusal as Error).message
    expect(text).toContain("QEMU 11.0.0")
    expect(text).toContain("QEMU 11.1.2")
    expect(text).toContain("winvm stop -i source")
    expect(commands).not.toContain("stop")
    expect(commands).not.toContain("quit")
    expect(readSave("source", "stow")).toBeNull()
    expect(runningPid).toBe(FAKE_PID)
  })

  it("still lets a named save be written under its true label, and a load of it says why it can't", async () => {
    const r = await createSave("source", {
      name: "kept-r10",
      kind: "manual",
      format: "raw",
    })
    expect(r.manifest.compatParts?.qemu).toBe("11.0.0+patches:p1")
    await expect(loadSave("source", "kept-r10")).rejects.toThrow(
      "QEMU changed (11.0.0+patches:p1 -> 11.1.2+patches:p2)",
    )
  })

  it("makes winvm stow exit with its own code and the restart guidance, leaving Windows running", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    expect(await savecmds.stow(parseArgs(["-i", "source", "--force"]))).toBe(
      STOW_REFUSED,
    )
    const said = errors.mock.calls.map((c) => String(c[0])).join("\n")
    expect(said).toContain("winvm stop -i source")
    expect(commands).not.toContain("stop")
    expect(runningPid).toBe(FAKE_PID)
  })

  it("is decided before winvm stow stops the watcher or takes the Finder drives down, so both stay up", async () => {
    spyOn(console, "error").mockImplementation(() => undefined)
    const stopped = spyOn(watcher, "stopWatcher").mockResolvedValue(true)
    const restarted = spyOn(watcher, "startWatcherFor").mockImplementation(
      () => undefined,
    )
    const down = spyOn(finder, "beforeDown").mockImplementation(() => undefined)
    expect(await savecmds.stow(parseArgs(["-i", "source", "--force"]))).toBe(
      STOW_REFUSED,
    )
    expect(stopped).not.toHaveBeenCalled()
    expect(restarted).not.toHaveBeenCalled()
    expect(down).not.toHaveBeenCalled()
  })

  it("is recorded as a refusal and not as a stow, so a later unexplained end of QEMU is still told", async () => {
    spyOn(console, "error").mockImplementation(() => undefined)
    const leased = async (run: () => Promise<number>): Promise<number> =>
      await withOperation("source", "stow", run)
    expect(
      await savecmds.stow(parseArgs(["-i", "source", "--force"]), leased),
    ).toBe(STOW_REFUSED)
    const entries = readSince("source", START).entries
    expect(entries.filter((e) => e.kind === "op")).toEqual([])
    expect(
      entries.filter((e) => e.kind === "warning" && e.what === "stow refused"),
    ).toHaveLength(1)
    appendEntry("source", { kind: "disconnected", reason: "qemu-closed" })
    expect(hostPoweredOff("source")?.cause).toBe("qemu-gone")
  })
})

describe("a stow whose QEMU did not say which version it runs", () => {
  beforeEach(() => {
    spyOn(kept, "launchedRuntime").mockResolvedValue(null)
    spyOn(monitor, "qmpCommand").mockRejectedValue(
      new Error("QMP did not answer within 2000 ms"),
    )
  })

  it("is refused this time, as undecided rather than unrecallable", async () => {
    let refusal: unknown = null
    await createSave("source", {
      name: "stow",
      kind: "stow",
      format: "raw",
      quitAfter: true,
    }).catch((e: unknown) => {
      refusal = e
    })
    expect(refusal).toBeInstanceOf(StowNotRecallable)
    expect((refusal as StowNotRecallable).undecided).toBe(true)
    expect((refusal as Error).message).toContain("did not say")
    expect(commands).not.toContain("stop")
    expect(readSave("source", "stow")).toBeNull()
  })

  it("makes winvm stow exit with a code of its own, which the watcher takes as a stow to try again", async () => {
    spyOn(console, "error").mockImplementation(() => undefined)
    const code = await savecmds.stow(parseArgs(["-i", "source", "--force"]))
    expect(code).toBe(saves.STOW_UNDECIDED)
    expect(code).not.toBe(STOW_REFUSED)
    expect(watcher.stowOutcome(code)).toBe("failed")
    expect(runningPid).toBe(FAKE_PID)
  })
})

describe("a winvm stow that fails while QEMU still runs Windows", () => {
  let afterwards: () => Promise<unknown> = async () =>
    await Promise.resolve({ status: "running" })
  let asked: number[] = []
  beforeEach(() => {
    afterwards = async () => await Promise.resolve({ status: "running" })
    asked = []
    spyOn(console, "error").mockImplementation(() => undefined)
    spyOn(saves, "captureScreen").mockRejectedValue(
      new Error("screendump failed"),
    )
    spyOn(monitor, "qmpCommand").mockImplementation(
      async (_socket, cmd, _args, timeoutMs) => {
        if (cmd === "query-version")
          return await Promise.resolve({ qemu: reported, package: "" })
        if (cmd !== "query-status") throw new Error(`unexpected ${cmd}`)
        asked.push(timeoutMs ?? 3000)
        return await afterwards()
      },
    )
  })

  it("starts the watcher it stopped again", async () => {
    spyOn(watcher, "stopWatcher").mockResolvedValue(true)
    const restarted = spyOn(watcher, "startWatcherFor").mockImplementation(
      () => undefined,
    )
    expect(await savecmds.stow(parseArgs(["-i", "source", "--force"]))).toBe(1)
    expect(runningPid).toBe(FAKE_PID)
    expect(commands).toContain("cont")
    expect(restarted).toHaveBeenCalledTimes(1)
  })

  it("starts no watcher when QEMU's monitor won't say what the guest is doing, and asks it only briefly", async () => {
    afterwards = async () =>
      await Promise.reject(new Error("QMP did not answer within 2000 ms"))
    spyOn(qmp, "status").mockImplementation(() =>
      commands.includes("cont")
        ? Promise.reject(new Error("qmp.sock went away"))
        : Promise.resolve("running"),
    )
    spyOn(watcher, "stopWatcher").mockResolvedValue(true)
    const restarted = spyOn(watcher, "startWatcherFor").mockImplementation(
      () => undefined,
    )
    expect(await savecmds.stow(parseArgs(["-i", "source", "--force"]))).toBe(1)
    expect(restarted).not.toHaveBeenCalled()
    expect(asked.length).toBeGreaterThan(0)
    expect(Math.max(...asked)).toBeLessThanOrEqual(2000)
  })

  it("stops and restarts the watcher even when it inherited WINVM_AUTOMATIC", async () => {
    const before = process.env.WINVM_AUTOMATIC
    process.env.WINVM_AUTOMATIC = "1"
    try {
      const stopped = spyOn(watcher, "stopWatcher").mockResolvedValue(true)
      const restarted = spyOn(watcher, "startWatcherFor").mockImplementation(
        () => undefined,
      )
      expect(await savecmds.stow(parseArgs(["-i", "source", "--force"]))).toBe(
        1,
      )
      expect(stopped).toHaveBeenCalledTimes(1)
      expect(restarted).toHaveBeenCalledTimes(1)
    } finally {
      if (before === undefined) delete process.env.WINVM_AUTOMATIC
      else process.env.WINVM_AUTOMATIC = before
    }
  })

  it("starts no watcher it did not stop", async () => {
    spyOn(watcher, "stopWatcher").mockResolvedValue(false)
    const restarted = spyOn(watcher, "startWatcherFor").mockImplementation(
      () => undefined,
    )
    expect(await savecmds.stow(parseArgs(["-i", "source", "--force"]))).toBe(1)
    expect(restarted).not.toHaveBeenCalled()
  })

  it("starts no watcher beside a QEMU that kept the guest stopped after writing the stow", async () => {
    spyOn(saves, "captureScreen").mockResolvedValue(null)
    spyOn(saves, "quitQemu").mockRejectedValue(
      new Error("QEMU (pid 1234567) did not quit and could not be killed"),
    )
    spyOn(qmp, "status").mockImplementation(() =>
      Promise.resolve(commands.includes("migrate") ? "postmigrate" : "running"),
    )
    afterwards = async () =>
      await Promise.resolve({
        status: commands.includes("migrate") ? "postmigrate" : "running",
      })
    spyOn(watcher, "stopWatcher").mockResolvedValue(true)
    const restarted = spyOn(watcher, "startWatcherFor").mockImplementation(
      () => undefined,
    )
    expect(await savecmds.stow(parseArgs(["-i", "source", "--force"]))).toBe(1)
    expect(restarted).not.toHaveBeenCalled()
  })
})

describe("a recall that completed but whose guest did not answer in time", () => {
  beforeEach(() => {
    spyOn(console, "error").mockImplementation(() => undefined)
    spyOn(console, "warn").mockImplementation(() => undefined)
    spyOn(qga, "waitResponsive").mockResolvedValue(false)
  })

  it("retires the stow, says Windows was restored and is still busy, and exits with its own code", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    const warned = spyOn(console, "warn").mockImplementation(() => undefined)
    expect(
      await savecmds.recallStow("source", parseArgs(["-i", "source"])),
    ).toBe(saves.RESTORED_UNANSWERED)
    expect(readSave("source", "stow")).toBeNull()
    const said = warned.mock.calls.map((c) => String(c[0])).join("\n")
    expect(said).toContain("still busy")
    expect(said).toContain("restored")
  })

  it("is not recalled again by the next start after a stop", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    await savecmds.recallStow("source", parseArgs(["-i", "source"]))
    expect(launches()).toHaveLength(1)
    runningPid = null
    expect(
      await savecmds.recallStow("source", parseArgs(["-i", "source"])),
    ).toBeNull()
    expect(launches()).toHaveLength(1)
  })

  it("retires the stow a named load supersedes, though the guest did not answer", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    fixture(VIRTIO_GPU, true, "named", "manual")
    expect(await savecmds.load(parseArgs(["-i", "source", "named"]))).toBe(
      saves.RESTORED_UNANSWERED,
    )
    expect(readSave("source", "stow")).toBeNull()
    expect(readSave("source", "named")).not.toBeNull()
  })

  it("retires the stow a golden reset supersedes, though the guest did not answer", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    fixture(VIRTIO_GPU, true, "golden", "golden")
    await expect(
      resetToGolden("source", "golden", { timeoutMs: 10 }),
    ).rejects.toThrow("did not answer")
    expect(readSave("source", "stow")).toBeNull()
  })
})

describe("a load that never completes", () => {
  it("quits QEMU rather than leave it half-loaded, and keeps the stow", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    spyOn(console, "error").mockImplementation(() => undefined)
    const real = Date.now.bind(Date)
    let skew = 0
    spyOn(Date, "now").mockImplementation(() => real() + skew)
    spyOn(qmp, "status").mockImplementation(() => {
      if (launches().length > 0) skew = 31 * 60_000
      return Promise.resolve(launches().length > 0 ? "inmigrate" : "running")
    })
    expect(
      await savecmds.recallStow("source", parseArgs(["-i", "source"])),
    ).toBe(1)
    expect(commands.filter((c) => c === "quit")).toHaveLength(2)
    expect(runningPid).toBeNull()
    expect(readSave("source", "stow")).not.toBeNull()
  })

  it("leaves a QEMU whose state it could not read, and marks the stow so start does not recall it", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    const said = spyOn(console, "error").mockImplementation(() => undefined)
    const real = Date.now.bind(Date)
    let skew = 0
    spyOn(Date, "now").mockImplementation(() => real() + skew)
    spyOn(qmp, "status").mockImplementation(() => {
      if (launches().length === 0) return Promise.resolve("running")
      skew = 31 * 60_000
      return Promise.reject(new Error("the monitor did not answer"))
    })
    expect(
      await savecmds.recallStow("source", parseArgs(["-i", "source"])),
    ).toBe(1)
    expect(commands.filter((c) => c === "quit")).toHaveLength(1)
    expect(runningPid).toBe(FAKE_PID)
    expect(readSave("source", "stow")?.unfinished).toBe(true)
    expect(said.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "did not say",
    )
  })

  it("marks the stow so start does not recall it when the half-loaded QEMU cannot be quit", async () => {
    fixture(VIRTIO_GPU, true, "stow", "stow")
    spyOn(console, "error").mockImplementation(() => undefined)
    const real = Date.now.bind(Date)
    let skew = 0
    spyOn(Date, "now").mockImplementation(() => {
      if (launches().length > 0) skew += 10 * 60_000
      return real() + skew
    })
    spyOn(qmp, "status").mockResolvedValue("inmigrate")
    spyOn(qemu, "killQemu").mockResolvedValue(false)
    spyOn(qmp, "execute").mockImplementation((_socket, cmd) => {
      commands.push(cmd)
      if (cmd === "quit" && launches().length === 0) runningPid = null
      return Promise.resolve({})
    })
    expect(
      await savecmds.recallStow("source", parseArgs(["-i", "source"])),
    ).toBe(1)
    expect(runningPid).toBe(FAKE_PID)
    expect(readSave("source", "stow")?.unfinished).toBe(true)
  })
})
