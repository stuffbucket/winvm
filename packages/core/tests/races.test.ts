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
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import * as commands from "../src/commands"
import * as display from "../src/display"
import { VIRTIO_GPU } from "../src/display"
import * as host from "../src/host"
import { withOperation } from "../src/operation"
import {
  basePath,
  type InstanceMeta,
  imageMetaPath,
  pathsFor,
} from "../src/paths"
import * as qemu from "../src/qemu"
import * as qga from "../src/qga"
import * as qmp from "../src/qmp"
import * as savecmds from "../src/savecmds"
import * as servicectl from "../src/servicectl"
import * as share from "../src/share"
import * as vnc from "../src/vnc"
import { realActions } from "../src/watch"

const NAME = "race"
const HOLDER = resolve(import.meta.dir, "fakes", "holder.ts")
const meta: InstanceMeta = {
  image: "win11-arm64",
  vnc: 9,
  created: "2026-11-14T00:00:00Z",
}

let state = ""
let previous: Record<string, string | undefined> = {}
let previousProbe: share.Probe
const spawned: ReturnType<typeof Bun.spawn>[] = []

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
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

function script(name: string, body: string): void {
  const path = resolve(state, "runtime", "bin", name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

const lines = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : []
const swtpmLog = (): string => resolve(state, "swtpm.log")
const qemuLog = (): string => resolve(state, "qemu.log")

async function hold(...argv: string[]): Promise<ReturnType<typeof Bun.spawn>> {
  const h = Bun.spawn([process.execPath, HOLDER, ...argv], {
    stdout: "pipe",
    stderr: "ignore",
  })
  spawned.push(h)
  const reader = (h.stdout as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  reader.releaseLock()
  return h
}

const outcome = async (p: Promise<unknown>): Promise<string> =>
  await p.then(
    (v) => `resolved:${String(v)}`,
    (e: unknown) => `rejected:${e instanceof Error ? e.message : String(e)}`,
  )

beforeEach(() => {
  previous = Object.fromEntries(
    [
      "WINVM_HOME",
      "WINVM_RUNTIME",
      "WINVM_TEST_SWTPM_LOG",
      "WINVM_TEST_QEMU_LOG",
    ].map((k) => [k, process.env[k]]),
  )
  state = mkdtempSync(resolve(tmpdir(), "winvm-race-"))
  process.env.WINVM_HOME = state
  process.env.WINVM_RUNTIME = resolve(state, "runtime")
  process.env.WINVM_TEST_SWTPM_LOG = swtpmLog()
  process.env.WINVM_TEST_QEMU_LOG = qemuLog()
  mkdirSync(resolve(state, "runtime", "bin"), { recursive: true })
  script(
    "swtpm",
    'while [ $# -gt 0 ]; do case "$1" in --ctrl) s="${2#*path=}"; s="${s%%,*}"; shift;; esac; shift; done; : > "$s"\n' +
      'echo $$ >> "$WINVM_TEST_SWTPM_LOG"\n' +
      "while :; do sleep 0.2; done",
  )
  script(
    "qemu-system-aarch64",
    'printf "%s\\n" "$*" >> "$WINVM_TEST_QEMU_LOG"; exec sleep 3',
  )
  previousProbe = share.setProbe(() => ({ ok: true, reason: null }))

  mkdirSync(resolve(state, "images", meta.image), { recursive: true })
  writeFileSync(basePath(meta.image), "immutable base")
  writeFileSync(imageMetaPath(meta.image), JSON.stringify({ virtioBoot: true }))
  const p = pathsFor(NAME)
  mkdirSync(p.tpmDir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify(meta))
  writeFileSync(p.overlay, "live disk")
  writeFileSync(p.vars, "live vars")
  const code = resolve(state, "code.fd")
  writeFileSync(code, "firmware")
  spyOn(host, "requireHost").mockImplementation(() => undefined)
  spyOn(host, "requireFirmware").mockReturnValue({ code, vars: code })
  spyOn(host, "tpmTisHasPpi").mockReturnValue(true)
  spyOn(vnc, "ensureFreeDisplay").mockImplementation((_name, _p, m) =>
    Promise.resolve(m),
  )
  spyOn(vnc, "applyPassword").mockResolvedValue(null)
  spyOn(share, "startVirtiofsd").mockImplementation(() =>
    Promise.resolve({ dir: state, readonly: false, folder: null }),
  )
  spyOn(console, "log").mockImplementation(() => undefined)
  spyOn(console, "error").mockImplementation(() => undefined)
  spyOn(console, "warn").mockImplementation(() => undefined)
  spyOn(process.stdout, "write").mockImplementation(() => true)
})

afterEach(() => {
  mock.restore()
  qemu.stopSwtpm(pathsFor(NAME))
  for (const h of spawned.splice(0)) h.kill("SIGKILL")
  share.setProbe(previousProbe)
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(state, { recursive: true, force: true })
})

describe("two cold starts at once", () => {
  it("never lets the second launch stop the TPM emulator the first one's QEMU is connecting to", async () => {
    let inLaunch: () => void = () => undefined
    const firstInLaunch = new Promise<void>((r) => {
      inLaunch = r
    })
    let release: () => void = () => undefined
    const released = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    spyOn(servicectl, "ensureService").mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        inLaunch()
        await released
      }
      return {} as never
    })
    spyOn(qga, "untilReady").mockResolvedValue("timeout")
    const args = parseArgs(["-i", NAME])

    const first = outcome(
      withOperation(NAME, "start", async () => await commands.start(args)),
    )
    await firstInLaunch
    const [firstSwtpm] = lines(swtpmLog())
    expect(firstSwtpm).toBeDefined()
    const second = await outcome(
      withOperation(NAME, "start", async () => await commands.start(args)),
    )
    const firstEmulatorSurvived = alive(Number(firstSwtpm))
    release()
    await first

    expect(firstEmulatorSurvived).toBe(true)
    expect(lines(swtpmLog())).toHaveLength(1)
    expect(lines(qemuLog())).toHaveLength(1)
    expect(second).toMatch(
      new RegExp(
        `^rejected:.*"${NAME}" is busy: start \\(pid ${String(process.pid)}\\)`,
      ),
    )
  }, 20_000)
})

describe("stop during a manual save", () => {
  it("never resumes the guest or asks Windows to shut down while the save holds it", async () => {
    const FAKE_PID = 1_234_567
    let runState = "running"
    const sent: string[] = []
    let migrating: () => void = () => undefined
    const inMigration = new Promise<void>((r) => {
      migrating = r
    })
    let finished = false
    spyOn(qemu, "pidOf").mockImplementation(() => FAKE_PID)
    spyOn(qemu, "isRunning").mockImplementation(() => true)
    spyOn(display, "runningCommand").mockImplementation(() =>
      [
        "qemu-system-aarch64",
        ...qemu.qemuArgs(NAME, pathsFor(NAME), meta, {
          installMedia: false,
          ephemeral: false,
          virtioBoot: true,
          display: VIRTIO_GPU,
        }),
      ].join(" "),
    )
    spyOn(qmp, "status").mockImplementation(() => Promise.resolve(runState))
    spyOn(qmp, "execute").mockImplementation((_socket, cmd) => {
      sent.push(cmd)
      if (cmd === "stop") runState = "paused"
      if (cmd === "cont") runState = "running"
      if (cmd === "query-status")
        return Promise.resolve({
          status: runState,
          running: runState === "running",
        })
      if (cmd === "migrate") migrating()
      if (cmd === "query-migrate")
        return Promise.resolve(
          finished
            ? { status: "failed", "error-desc": "test over" }
            : { status: "active" },
        )
      return Promise.resolve({})
    })
    const shutdowns: string[] = []
    let clock = 0
    const seams: commands.StopCommandSeams = {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        await sleep(1)
      },
      stopWatcher: () => Promise.resolve(false),
      watcherPid: () => null,
      ensureWatcher: () => null,
      beforeDown: () => undefined,
      afterUp: () => Promise.resolve(undefined),
      stopSidecars: () => undefined,
      waitFor: () => Promise.resolve(true),
      shutdown: () => {
        shutdowns.push("guest-shutdown")
        return Promise.resolve()
      },
    }

    const save = outcome(
      withOperation(
        NAME,
        "save",
        async () =>
          await savecmds.save(parseArgs(["-i", NAME, "--force", "checkpoint"])),
      ),
    )
    await inMigration
    const stop = await outcome(
      withOperation(
        NAME,
        "stop",
        async () => await commands.stopWith(parseArgs(["-i", NAME]), seams),
      ),
    )
    const sentDuringSave = [...sent]
    finished = true
    await save

    expect(
      sentDuringSave.slice(sentDuringSave.indexOf("migrate")),
    ).not.toContain("cont")
    expect(shutdowns).toEqual([])
    expect(stop).toMatch(
      new RegExp(
        `^rejected:.*"${NAME}" is busy: save \\(pid ${String(process.pid)}\\)`,
      ),
    )
  }, 20_000)
})

describe("the watcher's work", () => {
  it("skips an autosave while a person's command holds the instance, without touching QEMU", async () => {
    const sent: string[] = []
    spyOn(qemu, "pidOf").mockImplementation(() => 1_234_567)
    spyOn(qemu, "isRunning").mockImplementation(() => true)
    spyOn(qmp, "status").mockResolvedValue("running")
    spyOn(qga, "waitReady").mockResolvedValue(true)
    spyOn(qmp, "execute").mockImplementation((_socket, cmd) => {
      sent.push(cmd)
      return Promise.resolve({})
    })
    const log: string[] = []
    const actions = realActions(NAME, pathsFor(NAME), (l) => log.push(l))
    let release: () => void = () => undefined
    const reboot = withOperation(NAME, "reboot", async () => {
      await new Promise<void>((r) => {
        release = r
      })
    })
    await sleep(20)
    const autosave = await actions.save("auto-1")
    release()
    await reboot
    expect(autosave).toBe("busy")
    expect(sent).toEqual([])
    expect(log.join("\n")).toMatch(/busy: reboot \(pid \d+\)/)
  })

  it("makes a stop that arrives during the watcher's autosave wait for it, then stop the guest", async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const autosave = withOperation(
      NAME,
      "save",
      async () => {
        order.push("autosave begins")
        await new Promise<void>((r) => {
          release = r
        })
        order.push("autosave ends")
      },
      { automatic: true },
    )
    await sleep(20)
    let running = true
    const stop = withOperation(
      NAME,
      "stop",
      async () =>
        await commands.stopWith(parseArgs(["-i", NAME]), {
          isRunning: () => running,
          pidOf: () => 1_234_567,
          frozenState: () => Promise.resolve(null),
          stopWatcher: () => Promise.resolve(false),
          watcherPid: () => null,
          beforeDown: () => undefined,
          stopSidecars: () => undefined,
          waitFor: () => Promise.resolve(true),
          shutdown: () => {
            order.push("guest-shutdown")
            running = false
            return Promise.resolve()
          },
          sleep: async () => {
            await sleep(1)
          },
        }),
    )
    await sleep(300)
    order.push("released")
    release()
    await autosave
    expect(await stop).toBe(0)
    expect(order).toEqual([
      "autosave begins",
      "released",
      "autosave ends",
      "guest-shutdown",
    ])
  })
})

describe("kill", () => {
  it("never SIGKILLs a process that is not this instance's QEMU", async () => {
    const p = pathsFor(NAME)
    const stranger = await hold("unrelated-process")
    writeFileSync(p.pid, `${String(stranger.pid)}\n`)
    const code = commands.kill(parseArgs(["-i", NAME]))
    await sleep(100)
    expect(alive(stranger.pid)).toBe(true)
    expect(code).toBe(1)
    expect(readFileSync(p.pid, "utf8").trim()).toBe(String(stranger.pid))
  })

  it("does not take another instance's QEMU for this one's", async () => {
    const p = pathsFor(NAME)
    const other = await hold(
      "qemu-system-aarch64",
      "-name",
      "winvm-other",
      "-pidfile",
      pathsFor("other").pid,
    )
    writeFileSync(p.pid, `${String(other.pid)}\n`)
    expect(commands.kill(parseArgs(["-i", NAME]))).toBe(1)
    await sleep(100)
    expect(alive(other.pid)).toBe(true)
  })

  it("leaves a cold start's TPM emulator alone when that start holds the lease and has no QEMU yet", async () => {
    const p = pathsFor(NAME)
    const emulator = Bun.spawn(
      [
        resolve(state, "runtime", "bin", "swtpm"),
        "socket",
        "--tpmstate",
        `dir=${p.tpmDir}`,
        "--ctrl",
        `type=unixio,path=${p.tpmSock},terminate`,
        "--tpm2",
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env },
      },
    )
    spawned.push(emulator)
    for (let i = 0; i < 100 && lines(swtpmLog()).length === 0; i += 1)
      await sleep(10)
    spyOn(servicectl, "stopService").mockImplementation(() => undefined)
    let release: () => void = () => undefined
    const starting = withOperation(NAME, "start", async () => {
      await new Promise<void>((r) => {
        release = r
      })
      return 0
    })
    await sleep(20)
    const killed = await outcome(
      withOperation(NAME, "kill", () => commands.kill(parseArgs(["-i", NAME]))),
    )
    const survived = alive(Number(lines(swtpmLog())[0]))
    release()
    await starting
    expect(survived).toBe(true)
    expect(killed).toBe("resolved:1")
  })

  it("refuses without blaming the pid file when it cannot read the process's command line", async () => {
    const p = pathsFor(NAME)
    const own = await hold(
      "qemu-system-aarch64",
      "-name",
      `winvm-${NAME}`,
      "-pidfile",
      p.pid,
    )
    writeFileSync(p.pid, `${String(own.pid)}\n`)
    spyOn(display, "runningCommand").mockReturnValue(null)
    const errors: string[] = []
    spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "))
    })
    expect(commands.kill(parseArgs(["-i", NAME]))).toBe(1)
    expect(alive(own.pid)).toBe(true)
    expect(errors.join("\n")).toContain("could not read")
    expect(errors.join("\n")).not.toContain("remove that file")
  })

  it("kills this instance's QEMU without waiting on a lease another command holds", async () => {
    const p = pathsFor(NAME)
    script("qemu-system-aarch64", "while :; do sleep 0.2; done")
    const own = Bun.spawn(
      [
        resolve(state, "runtime", "bin", "qemu-system-aarch64"),
        "-name",
        `winvm-${NAME}`,
        "-pidfile",
        p.pid,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    spawned.push(own)
    writeFileSync(p.pid, `${String(own.pid)}\n`)
    spyOn(servicectl, "stopService").mockImplementation(() => undefined)
    let release: () => void = () => undefined
    const wedged = withOperation(NAME, "stop", async () => {
      await new Promise<void>((r) => {
        release = r
      })
      return 0
    })
    await sleep(50)
    const killed = await outcome(
      withOperation(NAME, "kill", () => commands.kill(parseArgs(["-i", NAME]))),
    )
    release()
    await wedged
    await own.exited
    expect(killed).toBe("resolved:0")
    expect(own.signalCode).toBe("SIGKILL")
  })
})
