import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  mock,
  spyOn,
} from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { dirname, resolve } from "node:path"

import { parseArgs } from "../src/args"
import * as commands from "../src/commands"
import { readSince, START } from "../src/eventlog"
import * as host from "../src/host"
import {
  type JobInfo,
  KeeperBusy,
  keeperLabel,
  type Launchd,
} from "../src/keeper"
import {
  callerUmask,
  KEEPER_OFF,
  type KeeperHello,
  keeperDir,
  keeperHello,
  keeperMonitor,
  keeperPlist,
  keeperSocket,
  keeperStanding,
  keeperUse,
  killKept,
  launchedRuntime,
  setLaunchd,
} from "../src/kept"
import { adoptLegacy } from "../src/legacy"
import { reconcileManagement, reconcileNote } from "../src/lifecycle"
import { InstanceBusy, LeaseNotHeld, withOperation } from "../src/operation"
import { type InstanceMeta, pathsFor } from "../src/paths"
import * as proc from "../src/proc"
import * as qemu from "../src/qemu"
import * as qmp from "../src/qmp"
import { currentQemuCompat } from "../src/runtime"
import * as saves from "../src/saves"
import * as servicectl from "../src/servicectl"
import * as share from "../src/share"
import { gather } from "../src/status"
import * as vnc from "../src/vnc"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"

const NAME = "kept"
const FAKE_KEEPER = resolve(import.meta.dir, "fakes", "keeper.ts")
const meta: InstanceMeta = {
  image: "win11-arm64",
  vnc: 7,
  created: "2026-11-17T00:00:00Z",
}

let state = ""
let previousEnv: Record<string, string | undefined> = {}
let previousLaunchd: () => Launchd
let previousSettle: qemu.Settle
let previousSpawner: qemu.Spawner
let previousProbe: share.Probe
let ensuring: Mock<typeof servicectl.ensureService>
const keepers: ReturnType<typeof Bun.spawn>[] = []
let launchdCalls: string[] = []
let bootstrapFails = false
let silentlyRunning = false
let listingFails = false
let detached: string[] = []

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

function script(name: string, body: string): void {
  const path = resolve(state, "runtime", "bin", name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  })
    .stdout.trim()
    .startsWith("Z")
}

function fakeLaunchd(): Launchd {
  const running = new Map<string, ReturnType<typeof Bun.spawn>>()
  return {
    bootstrap: (plist) => {
      launchdCalls.push("bootstrap")
      if (bootstrapFails)
        throw new Error("launchctl bootstrap user/501 keeper.plist: 5: EIO")
      const proc = Bun.spawn(
        [process.execPath, FAKE_KEEPER, "run", "--dir", dirname(plist)],
        { stdout: "ignore", stderr: "inherit" },
      )
      keepers.push(proc)
      running.set(plist, proc)
    },
    bootout: (label) => {
      launchdCalls.push(`bootout ${label}`)
      return false
    },
    print: (): JobInfo | null =>
      silentlyRunning
        ? { state: "running", pid: 1, lastExit: null, program: null, runs: 1 }
        : null,
    labels: () => {
      if (listingFails) throw new Error("launchctl print: boom")
      return []
    },
  }
}

const requests = (): Record<string, unknown>[] => {
  const file = resolve(keeperDir(pathsFor(NAME)), "requests.jsonl")
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : []
}

const ops = (): string[] =>
  requests()
    .map((r) => String(r.op))
    .filter((op) => op !== "hello")

const HOLDER = resolve(import.meta.dir, "fakes", "holder.ts")
const fakeQemu = (): string =>
  `while [ $# -gt 0 ]; do [ "$1" = -pidfile ] && p="$2"; shift; done\nexec "${process.execPath}" "${HOLDER}" qemu-system-aarch64 -name winvm-${NAME} -pidfile "$p" --lock "$p"`

const launchOptions: qemu.LaunchOptions = {
  installMedia: false,
  ephemeral: false,
  virtioBoot: true,
}

const leasedLaunch = async (
  o: qemu.LaunchOptions = launchOptions,
): Promise<void> => {
  await withOperation(NAME, "start", async () => {
    await qemu.launch(NAME, pathsFor(NAME), meta, o)
  })
}

beforeEach(() => {
  previousEnv = Object.fromEntries(
    [
      "WINVM_HOME",
      "WINVM_RUNTIME",
      "WINVM_KEEPER",
      "XDG_DATA_HOME",
      "KEPT_TEST_NOISE",
      "WINVM_CLI",
    ].map((k) => [k, process.env[k]]),
  )
  state = mkdtempSync("/tmp/wkept-")
  process.env.WINVM_HOME = resolve(state, "home")
  process.env.WINVM_RUNTIME = resolve(state, "runtime")
  process.env.XDG_DATA_HOME = resolve(state, "data")
  process.env.KEPT_TEST_NOISE = "x".repeat(70_000)
  const fakeBinary = resolve(state, "winvm-keeper")
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n")
  chmodSync(fakeBinary, 0o755)
  process.env.WINVM_KEEPER = fakeBinary
  mkdirSync(resolve(state, "runtime", "bin"), { recursive: true })
  script(
    "swtpm",
    `while [ $# -gt 0 ]; do case "$1" in --ctrl) s="\${2#*path=}"; s="\${s%%,*}"; shift;; esac; shift; done; : > "$s"\nexec sleep 30`,
  )
  script(
    "virtiofsd",
    'while [ $# -gt 0 ]; do case "$1" in --socket-path) : > "$2"; shift;; esac; shift; done\nexec sleep 30',
  )
  script("qemu-system-aarch64", fakeQemu())
  const p = pathsFor(NAME)
  mkdirSync(p.tpmDir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify(meta))
  const code = resolve(state, "code.fd")
  writeFileSync(code, "firmware")
  spyOn(host, "requireFirmware").mockReturnValue({ code, vars: code })
  spyOn(host, "tpmTisHasPpi").mockReturnValue(true)
  spyOn(vnc, "ensureFreeDisplay").mockImplementation((_n, _p, m) =>
    Promise.resolve(m),
  )
  spyOn(vnc, "applyPassword").mockResolvedValue(null)
  ensuring = spyOn(servicectl, "ensureService").mockResolvedValue({} as never)
  spyOn(console, "warn").mockImplementation(() => undefined)
  previousProbe = share.setProbe(() => ({ ok: true, reason: null }))
  previousLaunchd = setLaunchd(fakeLaunchd)
  previousSettle = qemu.setSettle((survived) => {
    const t = setTimeout(survived, 300)
    return () => {
      clearTimeout(t)
    }
  })
  previousSpawner = qemu.setSpawner((command) => {
    detached.push(command)
    throw new Error(`detached spawn of ${command}`)
  })
  launchdCalls = []
  detached = []
  bootstrapFails = false
  silentlyRunning = false
  listingFails = false
})

afterEach(async () => {
  mock.restore()
  setLaunchd(previousLaunchd)
  qemu.setSettle(previousSettle)
  qemu.setSpawner(previousSpawner)
  share.setProbe(previousProbe)
  const ending = keepers.splice(0)
  for (const k of ending) k.kill("SIGTERM")
  await Promise.all(ending.map(async (k) => await k.exited))
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(state, { recursive: true, force: true })
})

describe("choosing how QEMU is launched", () => {
  it("uses the keeper that is found, and none when WINVM_KEEPER=off or none is found", () => {
    const found = { path: "/k", source: "override" as const }
    expect(keeperUse({}, () => found)).toEqual({
      kind: "keeper",
      keeper: found,
    })
    expect(keeperUse({ WINVM_KEEPER: KEEPER_OFF }, () => found)).toEqual({
      kind: "off",
    })
    expect(keeperUse({}, () => null)).toEqual({ kind: "missing" })
  })
})

describe("launching QEMU through the keeper", () => {
  it("launches QEMU with the runtime it comes from, and remembers that after the runtime changes", async () => {
    const before = currentQemuCompat()
    await leasedLaunch()
    const p = pathsFor(NAME)
    const launch = requests().find((r) => r.op === "launch")?.child as
      | { readonly runtime?: string }
      | undefined
    expect(launch?.runtime).toBe(before)
    await until("the pidfile", () => qemu.isRunning(p))
    const pid = qemu.pidOf(p) ?? 0
    writeFileSync(
      resolve(state, "runtime", "manifest.json"),
      JSON.stringify({
        name: "winvm-runtime",
        version: "9",
        qemu: "99.0.0",
        qemuPatches: "x",
        components: {},
        macho: [],
        files: {},
      }),
    )
    expect(currentQemuCompat()).toBe("99.0.0+patches:x")
    expect(await launchedRuntime(p, pid)).toBe(before)
    expect(await launchedRuntime(p, pid + 1)).toBeNull()
  })

  it("starts the keeper under the lease, then the TPM emulator, then QEMU with the keeper's own monitor", async () => {
    await leasedLaunch()
    const p = pathsFor(NAME)
    expect(launchdCalls).toContain("bootstrap")
    expect(detached).toEqual([])
    expect(ops()).toEqual(["launch-sidecar", "launch"])
    const [tpm, main] = requests().filter((r) => r.op !== "hello")
    const tpmChild = tpm?.child as Record<string, unknown>
    expect(tpmChild.name).toBe("swtpm")
    expect(String((tpmChild.argv as string[])[0])).toEndWith("/bin/swtpm")
    expect(tpmChild.argv).toContain(`dir=${p.tpmDir}`)
    const child = main?.child as Record<string, unknown>
    expect(child.name).toBe("qemu")
    expect(child.pidfile).toBe(p.pid)
    expect(child.log).toBe(p.qemuLog)
    expect(child.qmp).toBe(keeperMonitor(p))
    expect(child.shield).toBeUndefined()
    expect(child.umask).toBe(callerUmask())
    expect(tpmChild.umask).toBe(callerUmask())
    const env = child.env as Record<string, string>
    expect(env.HOME).toBe(process.env.HOME ?? "")
    expect(env.PATH).toBe(process.env.PATH ?? "")
    expect(env.WINVM_HOME).toBe(process.env.WINVM_HOME ?? "")
    expect(env.KEPT_TEST_NOISE).toBeUndefined()
    expect(tpmChild.env).toEqual(env)
    const argv = child.argv as string[]
    expect(String(argv[0])).toEndWith("/bin/qemu-system-aarch64")
    expect(argv.join(" ")).toContain(
      `-qmp unix:${keeperMonitor(p)},server=on,wait=off`,
    )
    expect(argv.join(" ")).toContain(
      `-qmp unix:${p.qmpQemu},server=on,wait=off`,
    )
    const hello = await keeperHello(p)
    expect(hello?.child?.name).toBe("qemu")
    expect(hello?.sidecars.map((s) => s.name)).toEqual(["swtpm"])
  })

  it("keeps the shared folder's daemon beside QEMU when the machine has one", async () => {
    await leasedLaunch({ ...launchOptions, shareDevices: "fs" })
    expect(ops()).toEqual(["launch-sidecar", "launch-sidecar", "launch"])
    const names = requests()
      .filter((r) => r.op === "launch-sidecar")
      .map((r) => (r.child as Record<string, unknown>).name)
    expect(names).toEqual(["swtpm", "virtiofsd"])
    const hello = await keeperHello(pathsFor(NAME))
    expect(hello?.sidecars.map((s) => s.name).sort()).toEqual([
      "swtpm",
      "virtiofsd",
    ])
    expect(existsSync(share.virtiofsdState(pathsFor(NAME)))).toBe(true)
  })

  it("will not start a keeper, or anything else, without the instance's lease", async () => {
    await expect(
      qemu.launch(NAME, pathsFor(NAME), meta, launchOptions),
    ).rejects.toThrow(LeaseNotHeld)
    expect(launchdCalls).toEqual([])
    expect(detached).toEqual([])
    expect(existsSync(keeperDir(pathsFor(NAME)))).toBe(false)
  })

  it("raises an immediate exit with qemu.log's words, and the keeper ends the TPM emulator", async () => {
    script(
      "qemu-system-aarch64",
      'echo "qemu-system-aarch64: -drive: Could not open overlay" >&2\nexit 1',
    )
    await expect(leasedLaunch()).rejects.toThrow(
      "qemu exited immediately:\n  qemu-system-aarch64: -drive: Could not open overlay",
    )
    for (let i = 0; i < 50; i += 1) {
      if ((await keeperHello(pathsFor(NAME)))?.sidecars.length === 0) break
      await sleep(20)
    }
    expect((await keeperHello(pathsFor(NAME)))?.sidecars).toEqual([])
  })

  it("counts an incoming QEMU as up once its monitor answers", async () => {
    qemu.setSettle(() => () => undefined)
    const p = pathsFor(NAME)
    const answered = spyOn(
      await import("../src/qmp"),
      "execute",
    ).mockResolvedValue({ status: "inmigrate" })
    const launching = leasedLaunch({ ...launchOptions, incoming: "defer" })
    for (let i = 0; i < 100 && ops().length < 2; i += 1) await sleep(20)
    writeFileSync(p.qmp, "")
    await launching
    expect(answered).toHaveBeenCalled()
  })

  it("never stops the TPM emulator of a QEMU the keeper still runs", async () => {
    await leasedLaunch()
    const p = pathsFor(NAME)
    const before = await keeperHello(p)
    const tpm = before?.sidecars[0]?.pid ?? 0
    await until("the pidfile", () => qemu.isRunning(p))
    rmSync(p.pid, { force: true })
    await expect(leasedLaunch()).rejects.toThrow("still runs")
    expect(alive(tpm)).toBe(true)
    expect(ops()).toEqual(["launch-sidecar", "launch"])
  }, 15_000)
})

const qemuPid = (): number =>
  Number(readFileSync(pathsFor(NAME).pid, "utf8").trim())

async function until(what: string, probe: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    if (probe()) return
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("a build's installer", () => {
  it("takes its scratch instance's lease to launch through the keeper", async () => {
    await commands.launchInstaller(NAME, pathsFor(NAME), meta)
    expect(ops()).toContain("launch")
    const ops_ = readFileSync(pathsFor(NAME).events, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.kind === "op")
      .map((e) => `${String(e.operation)}:${String(e.phase)}`)
    expect(ops_).toEqual(["build:begin", "build:end"])
  })
})

describe("ending a kept QEMU", () => {
  it("kill asks the keeper, which SIGKILLs its child and ends the sidecars", async () => {
    await leasedLaunch()
    await until("the pidfile", () => existsSync(pathsFor(NAME).pid))
    const pid = qemuPid()
    const tpm = (await keeperHello(pathsFor(NAME)))?.sidecars[0]?.pid ?? 0
    spyOn(console, "log").mockImplementation(() => undefined)
    expect(await commands.kill(parseArgs(["-i", NAME]))).toBe(0)
    expect(ops()).toEqual(["launch-sidecar", "launch", "kill"])
    await until("QEMU to go", () => !alive(pid))
    await until("the TPM emulator to go", () => !alive(tpm))
  })

  it("quitQemu has the keeper kill a QEMU that will not quit", async () => {
    await leasedLaunch()
    await until("the pidfile", () => existsSync(pathsFor(NAME).pid))
    const pid = qemuPid()
    spyOn(qmp, "execute").mockRejectedValue(new Error("no monitor"))
    await saves.quitQemu(pathsFor(NAME), 200)
    expect(ops()).toContain("kill")
    expect(alive(pid)).toBe(false)
  })

  it("destroy boots the instance's keeper job out", async () => {
    await leasedLaunch()
    await until("the pidfile", () => existsSync(pathsFor(NAME).pid))
    spyOn(console, "log").mockImplementation(() => undefined)
    expect(await commands.kill(parseArgs(["-i", NAME]))).toBe(0)
    await until("QEMU to go", () => !qemu.isRunning(pathsFor(NAME)))
    const before = launchdCalls.length
    expect(commands.destroy(parseArgs(["-i", NAME]))).toBe(0)
    expect(launchdCalls.slice(before)).toEqual([
      `bootout ${keeperLabel(process.env.WINVM_HOME ?? "", NAME)}`,
    ])
  })
})

describe("a QEMU started detached, before the keeper", () => {
  it("is still killed directly, without starting a keeper", async () => {
    const p = pathsFor(NAME)
    const legacy = Bun.spawn(
      [
        resolve(state, "runtime", "bin", "qemu-system-aarch64"),
        "-name",
        `winvm-${NAME}`,
        "-pidfile",
        p.pid,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    await until("the pidfile", () => existsSync(p.pid))
    spyOn(console, "log").mockImplementation(() => undefined)
    expect(await commands.kill(parseArgs(["-i", NAME]))).toBe(0)
    await legacy.exited
    expect(legacy.signalCode).toBe("SIGKILL")
    expect(launchdCalls).toEqual([])
    expect(existsSync(keeperDir(p))).toBe(false)
  })
})

describe("whether the keeper protects a VM", () => {
  const hello = (child: number | null, legacy = false): KeeperHello => ({
    pid: 9,
    protocol: 3,
    version: "0.1.0",
    child:
      child === null
        ? null
        : { name: "qemu", pid: child, adopted: legacy, legacy, runtime: null },
    sidecars: [],
    service: null,
    hostEnding: false,
  })

  it("is kept when the keeper's child is the QEMU qemu.pid names", () => {
    expect(keeperStanding(10, hello(10), "keeper")).toEqual({
      protection: "kept",
      version: "0.1.0",
      pid: 9,
    })
  })

  it("is legacy, off or missing for a QEMU no keeper runs", () => {
    expect(keeperStanding(10, null, "keeper")?.protection).toBe("legacy")
    expect(keeperStanding(10, hello(null), "keeper")?.protection).toBe("legacy")
    expect(keeperStanding(10, null, "off")?.protection).toBe("off")
    expect(keeperStanding(10, null, "missing")?.protection).toBe("missing")
  })

  it("is broken when the keeper and qemu.pid disagree", () => {
    expect(keeperStanding(10, hello(11), "keeper")?.protection).toBe("broken")
    expect(keeperStanding(null, hello(11), "keeper")?.protection).toBe("broken")
  })

  it("is adopted when the keeper watches a QEMU it did not launch", () => {
    expect(keeperStanding(10, hello(10, true), "keeper")?.protection).toBe(
      "adopted",
    )
  })

  it("says nothing for a stopped VM with no kept QEMU", () => {
    expect(keeperStanding(null, hello(null), "keeper")).toBeNull()
    expect(keeperStanding(null, null, "off")).toBeNull()
  })

  it("is reported by status for a kept VM, and a note says how to protect a legacy one", async () => {
    await leasedLaunch()
    await until("the pidfile", () => existsSync(pathsFor(NAME).pid))
    const keptStatus = await gather(NAME, false)
    expect(keptStatus.keeper?.protection).toBe("kept")
    expect(keptStatus.notes.join("\n")).not.toContain("keeper")
    expect(await commands.kill(parseArgs(["-i", NAME]))).toBe(0)
    await until("QEMU to go", () => !qemu.isRunning(pathsFor(NAME)))

    const legacy = Bun.spawn(
      [
        resolve(state, "runtime", "bin", "qemu-system-aarch64"),
        "-pidfile",
        pathsFor(NAME).pid,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    try {
      await until("the pidfile", () => qemu.isRunning(pathsFor(NAME)))
      const legacyStatus = await gather(NAME, false)
      expect(legacyStatus.keeper?.protection).toBe("legacy")
      expect(legacyStatus.notes.join("\n")).toContain(
        `not protected if the Mac shuts down`,
      )
      expect(legacyStatus.notes.join("\n")).toContain(
        `winvm stow -i ${NAME} && winvm start -i ${NAME}`,
      )
    } finally {
      legacy.kill("SIGKILL")
    }
  })
})

describe("launching QEMU without the keeper", () => {
  it("spawns QEMU detached when WINVM_KEEPER=off, and starts no keeper", async () => {
    process.env.WINVM_KEEPER = KEEPER_OFF
    await expect(leasedLaunch()).rejects.toThrow("detached spawn of")
    expect(detached.some((c) => c.endsWith("/bin/swtpm"))).toBe(true)
    expect(launchdCalls).toEqual([])
    expect(existsSync(keeperDir(pathsFor(NAME)))).toBe(false)
  })

  it("spawns QEMU detached, with a warning, when the keeper cannot be started", async () => {
    bootstrapFails = true
    const warnings: string[] = []
    spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warnings.push(a.map(String).join(" "))
    })
    await expect(leasedLaunch()).rejects.toThrow("detached spawn of")
    expect(launchdCalls.at(-1)).toBe("bootstrap")
    expect(warnings.join("\n")).toContain(
      "winvm's keeper did not start (launchctl bootstrap user/501 keeper.plist: 5: EIO); starting QEMU without it, so it is not protected if the Mac shuts down",
    )
  })

  it("spawns QEMU detached when no keeper is installed", async () => {
    delete process.env.WINVM_KEEPER
    await expect(leasedLaunch()).rejects.toThrow("detached spawn of")
    expect(launchdCalls).toEqual([])
  })
})

describe("fix round 1", () => {
  it("asks the keeper to stay while a launch is in progress, in every hello", async () => {
    await leasedLaunch({ ...launchOptions, shareDevices: "fs" })
    const hellos = requests().filter((r) => r.op === "hello")
    expect(hellos.length).toBeGreaterThan(0)
    expect(hellos.filter((r) => r.launching !== true)).toEqual([])
  })

  it("creates qemu.log with the caller's umask, not the keeper's", async () => {
    await leasedLaunch()
    expect(statSync(pathsFor(NAME).qemuLog).mode & 0o777).toBe(
      0o666 & ~callerUmask(),
    )
  })

  it("ends the sidecars when the keeper refuses QEMU itself", async () => {
    rmSync(resolve(state, "runtime", "bin", "qemu-system-aarch64"))
    await expect(leasedLaunch()).rejects.toThrow("refused launch")
    await until("the sidecars to go", () => {
      const file = resolve(keeperDir(pathsFor(NAME)), "requests.jsonl")
      return readFileSync(file, "utf8").includes('"op":"kill"')
    })
    expect(ops()).toEqual(["launch-sidecar", "launch", "kill"])
  })

  it("refuses, rather than falling back, while the keeper is running but silent", async () => {
    silentlyRunning = true
    await expect(leasedLaunch()).rejects.toThrow(KeeperBusy)
    expect(detached).toEqual([])
    expect(launchdCalls).toEqual([])
  }, 15_000)

  it("warns when it cannot collect old keeper versions, and still launches", async () => {
    listingFails = true
    const warnings: string[] = []
    spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warnings.push(a.map(String).join(" "))
    })
    await leasedLaunch()
    expect(ops()).toEqual(["launch-sidecar", "launch"])
    expect(warnings.join("\n")).toContain(
      "could not clean up old keeper versions: launchctl print: boom",
    )
  })

  it("kill ends the keeper's QEMU when qemu.pid names none, and spares nothing else", async () => {
    await leasedLaunch()
    await until("the pidfile", () => qemu.isRunning(pathsFor(NAME)))
    const hello = await keeperHello(pathsFor(NAME))
    const child = hello?.child?.pid ?? 0
    rmSync(pathsFor(NAME).pid)
    expect(qemu.pidOf(pathsFor(NAME))).toBeNull()
    expect((await gather(NAME, false)).keeper?.protection).toBe("broken")
    spyOn(console, "log").mockImplementation(() => undefined)
    expect(await commands.kill(parseArgs(["-i", NAME]))).toBe(0)
    expect(ops()).toEqual(["launch-sidecar", "launch", "kill"])
    await until("the keeper's QEMU to go", () => !alive(child))
  })

  it("does not call a launch in progress confused", async () => {
    await withOperation(NAME, "start", async () => {
      await qemu.launch(NAME, pathsFor(NAME), meta, launchOptions)
      await until("the pidfile", () => qemu.isRunning(pathsFor(NAME)))
      rmSync(pathsFor(NAME).pid)
      const s = await gather(NAME, false)
      expect(s.keeper).toBeNull()
      expect(s.notes.join("\n")).not.toContain("keeper")
    })
  })

  it("never counts the keeper's refusal as a kill, even once it has named the child", async () => {
    const p = pathsFor(NAME)
    mkdirSync(keeperDir(p), { recursive: true })
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.on("data", (line: string) => {
        const op = (JSON.parse(line) as { op: string }).op
        socket.end(
          op === "hello"
            ? `${JSON.stringify({ ok: true, pid: 9, protocol: 2, child: { name: "qemu", pid: 4242 } })}\n`
            : `${JSON.stringify({ ok: false, error: "no child" })}\n`,
        )
      })
    })
    await new Promise<void>((ready) => {
      server.listen(keeperSocket(p), () => {
        ready()
      })
    })
    try {
      expect(await killKept(p, 4242)).toBe(false)
      expect(await killKept(p, 4243)).toBe(false)
    } finally {
      await new Promise<void>((done) => {
        server.close(() => {
          done()
        })
      })
    }
  })

  it("says the keeper did not kill QEMU when its kill request itself failed", async () => {
    const p = pathsFor(NAME)
    mkdirSync(keeperDir(p), { recursive: true })
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.on("data", (line: string) => {
        const op = (JSON.parse(line) as { op: string }).op
        if (op === "hello")
          socket.end(
            `${JSON.stringify({ ok: true, pid: 9, protocol: 2, child: { name: "qemu", pid: 4242 } })}\n`,
          )
        else socket.destroy()
      })
    })
    await new Promise<void>((ready) => {
      server.listen(keeperSocket(p), () => {
        ready()
      })
    })
    try {
      expect(await killKept(p, 4242)).toBe(false)
    } finally {
      await new Promise<void>((done) => {
        server.close(() => {
          done()
        })
      })
    }
  })

  it("kills QEMU itself after a failed keeper request only while the pidfile lock still names it", async () => {
    const p = pathsFor(NAME)
    const held = (
      await lockPidfile(p.pid, "qemu-system-aarch64", "-pidfile", p.pid)
    ).pid
    mkdirSync(keeperDir(p), { recursive: true })
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.on("data", (line: string) => {
        const op = (JSON.parse(line) as { op: string }).op
        if (op === "hello")
          socket.end(
            `${JSON.stringify({ ok: true, pid: 9, protocol: 2, child: { name: "qemu", pid: held } })}\n`,
          )
        else socket.destroy()
      })
    })
    await new Promise<void>((ready) => {
      server.listen(keeperSocket(p), () => {
        ready()
      })
    })
    try {
      expect(await qemu.killQemu(p, held + 1)).toBe(false)
      expect(alive(held)).toBe(true)
      expect(await qemu.killQemu(p, held)).toBe(true)
      await until("the QEMU to go", () => !alive(held))
    } finally {
      await new Promise<void>((done) => {
        server.close(() => {
          done()
        })
      })
      await releasePidfiles()
    }
  })

  it("names keeper.log, not a restart, when the VM runs unprotected because the keeper could not start", async () => {
    bootstrapFails = true
    spyOn(console, "warn").mockImplementation(() => undefined)
    await withOperation(NAME, "start", async () => {
      await qemu.launch(NAME, pathsFor(NAME), meta, launchOptions)
    }).catch(() => undefined)
    const legacy = Bun.spawn(
      [
        resolve(state, "runtime", "bin", "qemu-system-aarch64"),
        "-pidfile",
        pathsFor(NAME).pid,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    try {
      await until("the pidfile", () => qemu.isRunning(pathsFor(NAME)))
      const notes = (await gather(NAME, false)).notes.join("\n")
      expect(notes).toContain("could not start")
      expect(notes).toContain(resolve(keeperDir(pathsFor(NAME)), "keeper.log"))
      expect(notes).not.toContain("winvm stow")
    } finally {
      legacy.kill("SIGKILL")
    }
  })

  it("says what is true when no keeper is installed", async () => {
    delete process.env.WINVM_KEEPER
    const legacy = Bun.spawn(
      [
        resolve(state, "runtime", "bin", "qemu-system-aarch64"),
        "-pidfile",
        pathsFor(NAME).pid,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    try {
      await until("the pidfile", () => qemu.isRunning(pathsFor(NAME)))
      const notes = (await gather(NAME, false)).notes.join("\n")
      expect(notes).toContain("not protected if the Mac shuts down")
      expect(notes).not.toContain("winvm setup")
    } finally {
      legacy.kill("SIGKILL")
    }
  })

  it("boots out a lingering keeper before a build clears its scratch instance", () => {
    const p = pathsFor(NAME)
    mkdirSync(keeperDir(p), { recursive: true })
    writeFileSync(keeperPlist(p), "plist")
    commands.clearScratch(NAME, p)
    expect(launchdCalls).toEqual([
      `bootout ${keeperLabel(process.env.WINVM_HOME ?? "", NAME)}`,
    ])
    expect(existsSync(p.dir)).toBe(false)
  })

  it("will not clear a build's scratch, or boot its keeper out, while another build holds its lease", async () => {
    const p = pathsFor(NAME)
    mkdirSync(keeperDir(p), { recursive: true })
    writeFileSync(keeperPlist(p), "plist")
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { withOperation } = await import(${JSON.stringify(resolve(import.meta.dir, "..", "src", "operation.ts"))}); await withOperation(${JSON.stringify(NAME)}, "build", async () => { console.log("held"); await new Promise((r) => setTimeout(r, 20000)) })`,
      ],
      { stdout: "pipe", stderr: "inherit", env: process.env },
    )
    try {
      const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      reader.releaseLock()
      expect(() => {
        commands.clearScratch(NAME, p)
      }).toThrow(InstanceBusy)
      expect(launchdCalls).toEqual([])
      expect(existsSync(keeperPlist(p))).toBe(true)
    } finally {
      holder.kill("SIGKILL")
      await holder.exited
    }
  })
})

describe("the control service under the keeper", () => {
  const CLI = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "apps",
    "cli",
    "src",
    "winvm.ts",
  )
  const parentOf = (pid: number): number =>
    Number(
      spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout.trim(),
    )

  it("runs as the keeper's child, shrugs off SIGTERM, and stops when asked", async () => {
    process.env.WINVM_CLI = CLI
    await leasedLaunch()
    ensuring.mockRestore()
    const p = pathsFor(NAME)
    const info = await servicectl.ensureService(NAME, p)
    const hello = await keeperHello(p)
    expect(hello?.service?.pid).toBe(info.pid)
    expect(parentOf(info.pid)).toBe(hello?.pid ?? -1)
    expect(ops()).toContain("service")
    process.kill(info.pid, "SIGTERM")
    await sleep(500)
    expect(alive(info.pid)).toBe(true)
    expect(
      readSince(NAME, START).entries.some(
        (e) =>
          e.kind === "service" &&
          e.what === "signal ignored" &&
          e.signal === "SIGTERM",
      ),
    ).toBe(true)
    const again = await servicectl.ensureService(NAME, p)
    expect(again.pid).toBe(info.pid)
    const started = Date.now()
    servicectl.stopService(p)
    expect(alive(info.pid)).toBe(false)
    expect(Date.now() - started).toBeLessThan(3000)
  }, 20_000)

  it("stops a stray service before the keeper starts its own", async () => {
    process.env.WINVM_CLI = CLI
    await leasedLaunch()
    ensuring.mockRestore()
    const p = pathsFor(NAME)
    const stray = Bun.spawn([process.execPath, CLI, "serve", "-i", NAME], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, WINVM_NO_RECONCILE: "1" },
    })
    await until("the stray service", () => servicectl.readService(p) !== null)
    const info = await servicectl.ensureService(NAME, p)
    await stray.exited
    expect(info.pid).not.toBe(stray.pid)
    expect((await keeperHello(p))?.service?.pid).toBe(info.pid)
    servicectl.stopService(p)
  }, 20_000)
})

describe("adopting a VM an older winvm started", () => {
  const startLegacy = async (): Promise<number> =>
    (
      await lockPidfile(
        pathsFor(NAME).pid,
        "qemu-system-aarch64",
        "-pidfile",
        pathsFor(NAME).pid,
      )
    ).pid

  it("bootstraps a keeper that watches the running QEMU in place, then runs the service under it", async () => {
    const p = pathsFor(NAME)
    const pid = await startLegacy()
    try {
      expect(await adoptLegacy(NAME, p)).toBe("adopted")
      const spec = JSON.parse(
        readFileSync(resolve(keeperDir(p), "spec.json"), "utf8"),
      ) as { readonly adopt?: unknown }
      expect(spec.adopt).toEqual({ name: "qemu", pidfile: p.pid, qmp: p.qmp })
      const hello = await keeperHello(p)
      expect(hello?.child).toMatchObject({ pid, legacy: true, adopted: true })
      expect(alive(pid)).toBe(true)
      expect(ensuring).toHaveBeenCalledTimes(1)
      expect(launchdCalls.filter((c) => c === "bootstrap")).toHaveLength(1)
      expect(await adoptLegacy(NAME, p)).toBe("kept")
      expect(launchdCalls.filter((c) => c === "bootstrap")).toHaveLength(1)
      expect(ops()).toEqual([])
      const s = await gather(NAME, false)
      expect(s.keeper?.protection).toBe("adopted")
      const notes = s.notes.join("\n")
      expect(notes).toContain("not shielded")
      expect(notes).toContain("Protect now")
    } finally {
      await releasePidfiles()
    }
  })

  it("is what reconcile does first, and reconcile says so", async () => {
    process.env.WINVM_CLI = resolve(
      import.meta.dir,
      "..",
      "..",
      "..",
      "apps",
      "cli",
      "src",
      "winvm.ts",
    )
    const p = pathsFor(NAME)
    const pid = await startLegacy()
    try {
      const r = await reconcileManagement(NAME, p)
      expect(r.adopted).toBe(true)
      expect((await keeperHello(p))?.child).toMatchObject({ pid, legacy: true })
      expect(reconcileNote(NAME, r, p)).toContain("winvm's keeper now watches")
      expect((await reconcileManagement(NAME, p)).adopted).toBeUndefined()
    } finally {
      await releasePidfiles()
    }
  })

  it("leaves a VM alone when the keeper is off or missing, when nothing runs, and while another operation holds it", async () => {
    const p = pathsFor(NAME)
    expect(await adoptLegacy(NAME, p)).toBe("none")
    await startLegacy()
    try {
      expect(await adoptLegacy(NAME, p, { kind: "off" })).toBe("none")
      expect(await adoptLegacy(NAME, p, { kind: "missing" })).toBe("none")
      expect(
        await withOperation(NAME, "save", async () => {
          const holder = Bun.spawn(
            [
              process.execPath,
              "-e",
              `const { adoptLegacy } = await import(${JSON.stringify(resolve(import.meta.dir, "..", "src", "legacy.ts"))}); console.log(await adoptLegacy(${JSON.stringify(NAME)}))`,
            ],
            { stdout: "pipe", stderr: "inherit", env: process.env },
          )
          return (await new Response(holder.stdout).text()).trim()
        }),
      ).toBe("busy")
      expect(launchdCalls).toEqual([])
    } finally {
      await releasePidfiles()
    }
  })
})

describe("a keeper from phase 3, which speaks protocol 2", () => {
  const oldKeeper = async (
    p: ReturnType<typeof pathsFor>,
    child: number | null,
    kill: (request: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<ReturnType<typeof createServer>> => {
    mkdirSync(keeperDir(p), { recursive: true })
    const server = createServer((socket) => {
      socket.setEncoding("utf8")
      socket.on("data", (line: string) => {
        const request = JSON.parse(line) as Record<string, unknown>
        const answer =
          request.op === "hello"
            ? {
                ok: true,
                pid: 9,
                protocol: 2,
                child: child === null ? null : { name: "qemu", pid: child },
              }
            : typeof request.protocol === "number" && request.protocol > 2
              ? {
                  ok: false,
                  error: `protocol ${String(request.protocol)} is newer than this keeper's`,
                  protocol: 2,
                }
              : kill(request)
        socket.end(`${JSON.stringify(answer)}\n`)
      })
    })
    await new Promise<void>((ready) => {
      server.listen(keeperSocket(p), () => {
        ready()
      })
    })
    return server
  }
  const closing = async (
    server: ReturnType<typeof createServer>,
  ): Promise<void> => {
    await new Promise<void>((done) => {
      server.close(() => {
        done()
      })
    })
  }
  const held = async (): Promise<number> =>
    (
      await lockPidfile(
        pathsFor(NAME).pid,
        "qemu-system-aarch64",
        "-pidfile",
        pathsFor(NAME).pid,
      )
    ).pid

  it("kills its QEMU with a protocol 2 request, never counting a refusal as a kill", async () => {
    const p = pathsFor(NAME)
    const pid = await held()
    const server = await oldKeeper(p, pid, (request) => {
      if (request.op !== "kill") return { ok: false, error: "unknown op" }
      process.kill(pid, "SIGKILL")
      return { ok: true, pid }
    })
    spyOn(console, "log").mockImplementation(() => undefined)
    try {
      expect(await commands.kill(parseArgs(["-i", NAME]))).toBe(0)
      await until("the QEMU to go", () => !alive(pid))
    } finally {
      await closing(server)
      await releasePidfiles()
    }
  })

  it("says kill failed and keeps qemu.pid while QEMU still holds its lock", async () => {
    const p = pathsFor(NAME)
    const pid = await held()
    const server = await oldKeeper(p, pid, () => ({
      ok: false,
      error: "no child",
    }))
    spyOn(proc, "signalProcess").mockReturnValue(true)
    spyOn(console, "log").mockImplementation(() => undefined)
    const errors = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(await commands.kill(parseArgs(["-i", NAME]))).toBe(1)
      expect(alive(pid)).toBe(true)
      expect(existsSync(p.pid)).toBe(true)
      expect(String(errors.mock.calls.at(-1)?.[0])).toContain(
        "still holds its pidfile lock",
      )
    } finally {
      await closing(server)
      await releasePidfiles()
    }
  }, 15_000)

  it("is asked to exit when it lingers with no QEMU, and the launch goes through a current keeper", async () => {
    const p = pathsFor(NAME)
    const asked: Record<string, unknown>[] = []
    let server: ReturnType<typeof createServer> | null = null
    server = await oldKeeper(p, null, (request) => {
      asked.push(request)
      if (request.op === "exit-when-idle")
        setTimeout(() => {
          server?.close()
          rmSync(keeperSocket(p), { force: true })
        }, 50)
      return { ok: true }
    })
    try {
      await leasedLaunch()
      expect(asked).toEqual([{ op: "exit-when-idle", protocol: 2 }])
      expect(detached).toEqual([])
      expect(ops()).toEqual(["launch-sidecar", "launch"])
    } finally {
      server.close()
    }
  }, 15_000)

  it("leaves the start refused while a QEMU of the instance runs, whatever qemu.pid says", async () => {
    const p = pathsFor(NAME)
    const pid = await held()
    rmSync(p.pid)
    try {
      await expect(leasedLaunch()).rejects.toThrow(
        `QEMU (pid ${String(pid)}) still runs for "${NAME}"`,
      )
      expect(launchdCalls).toEqual([])
      expect(detached).toEqual([])
      expect(alive(pid)).toBe(true)
    } finally {
      await releasePidfiles()
    }
  }, 15_000)
})
