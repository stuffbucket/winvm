import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
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
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"

import { parseArgs } from "../src/args"
import * as commands from "../src/commands"
import * as host from "../src/host"
import { type JobInfo, keeperLabel, type Launchd } from "../src/keeper"
import {
  KEEPER_OFF,
  keeperDir,
  keeperHello,
  keeperMonitor,
  keeperUse,
  setLaunchd,
} from "../src/kept"
import { LeaseNotHeld, withOperation } from "../src/operation"
import { type InstanceMeta, pathsFor } from "../src/paths"
import * as qemu from "../src/qemu"
import * as qmp from "../src/qmp"
import * as saves from "../src/saves"
import * as servicectl from "../src/servicectl"
import * as share from "../src/share"
import * as vnc from "../src/vnc"

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
let keepers: ReturnType<typeof Bun.spawn>[] = []
let launchdCalls: string[] = []
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
    print: (): JobInfo | null => null,
    labels: () => [],
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

const FAKE_QEMU =
  'while [ $# -gt 0 ]; do [ "$1" = -pidfile ] && echo $$ > "$2"; shift; done\nwhile :; do sleep 0.2; done'

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
    ["WINVM_HOME", "WINVM_RUNTIME", "WINVM_KEEPER", "XDG_DATA_HOME"].map(
      (k) => [k, process.env[k]],
    ),
  )
  state = mkdtempSync("/tmp/wkept-")
  process.env.WINVM_HOME = resolve(state, "home")
  process.env.WINVM_RUNTIME = resolve(state, "runtime")
  process.env.XDG_DATA_HOME = resolve(state, "data")
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
  script("qemu-system-aarch64", FAKE_QEMU)
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
  spyOn(servicectl, "ensureService").mockResolvedValue({} as never)
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
})

afterEach(() => {
  mock.restore()
  setLaunchd(previousLaunchd)
  qemu.setSettle(previousSettle)
  qemu.setSpawner(previousSpawner)
  share.setProbe(previousProbe)
  for (const k of keepers.splice(0)) k.kill("SIGTERM")
  keepers = []
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
    rmSync(p.pid, { force: true })
    await expect(leasedLaunch()).rejects.toThrow("still runs QEMU")
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

describe("launching QEMU without the keeper", () => {
  it("spawns QEMU detached when WINVM_KEEPER=off, and starts no keeper", async () => {
    process.env.WINVM_KEEPER = KEEPER_OFF
    await expect(leasedLaunch()).rejects.toThrow("detached spawn of")
    expect(detached.some((c) => c.endsWith("/bin/swtpm"))).toBe(true)
    expect(launchdCalls).toEqual([])
    expect(existsSync(keeperDir(pathsFor(NAME)))).toBe(false)
  })

  it("spawns QEMU detached when no keeper is installed", async () => {
    delete process.env.WINVM_KEEPER
    await expect(leasedLaunch()).rejects.toThrow("detached spawn of")
    expect(launchdCalls).toEqual([])
  })
})
