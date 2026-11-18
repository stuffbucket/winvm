import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { QgaChannel, QmpChannel } from "../src/broker"
import { RAMFB, writeDisplay } from "../src/display"
import { type Entry, readSince, START } from "../src/eventlog"
import {
  basePath,
  imageMetaPath,
  type Paths,
  pathsFor,
  readMeta,
} from "../src/paths"
import { qemuArgs } from "../src/qemu"
import { currentCompat, FILES, type Manifest, saveDir } from "../src/saves"
import { stopService } from "../src/servicectl"
import { newPassword, SMB_USER, writeSmb } from "../src/smbstate"
import { FakeAgent } from "./fakes/agent"
import { FakeGuest } from "./fakes/guest"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"
import { FakeQmp } from "./fakes/qmp"
import { scratchPattern } from "./fakes/scratch"

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
const IMAGE = "win11-arm64"
const SCRATCH = "winvm-long-"

let home = ""
let saved: Record<string, string | undefined> = {}
let p: Paths
let fakeQmp: FakeQmp
let fakeAgent: FakeAgent
let guest: FakeGuest
let service: ReturnType<typeof Bun.spawn> | null = null
let powerdownExits = true

const runtime = (): string => resolve(home, "runtime")

const env = (): Record<string, string> => {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("WINVM_")) e[k] = v
  return {
    ...e,
    WINVM_HOME: home,
    WINVM_CLI: CLI,
    WINVM_BUILD_ID: "sha256:long-verbs",
    WINVM_NO_RECONCILE: "1",
    WINVM_KEEPER: "off",
    WINVM_MOUNTS: resolve(home, "mounts"),
    WINVM_RUNTIME: runtime(),
    WINVM_QEMU_DATA: resolve(home, "firmware"),
    WINVM_FAKE_QEMU_LOG: resolve(home, "fake-qemu.log"),
  }
}

interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface Running {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly done: Promise<Ran>
  readonly stderr: () => string
}

function launch(...argv: readonly string[]): Running {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  })
  let err = ""
  const dec = new TextDecoder()
  const reading = (async (): Promise<string> => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>)
      err += dec.decode(chunk)
    return err
  })()
  const done = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    reading,
    proc.exited,
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
  return { proc, done, stderr: () => err }
}

async function winvm(...argv: readonly string[]): Promise<Ran> {
  return await launch(...argv).done
}

const answers = async (): Promise<boolean> => {
  try {
    return (await fetch("http://localhost/status", { unix: p.control })).ok
  } catch {
    return false
  }
}

async function startService(): Promise<void> {
  service = Bun.spawn([process.execPath, CLI, "serve", "-i", "t"], {
    env: env(),
    stdout: "ignore",
    stderr: "ignore",
  })
  const end = Date.now() + 15_000
  while (!(await answers())) {
    if (Date.now() > end) throw new Error("the service never answered")
    await Bun.sleep(50)
  }
}

async function qemuExits(): Promise<void> {
  await qemuGoes()
  await fakeQmp.close().catch(() => undefined)
  await fakeAgent.close().catch(() => undefined)
}

async function qemuGoes(): Promise<void> {
  await releasePidfiles()
}

async function startQemu(): Promise<void> {
  const meta = readMeta("t")
  if (meta === null) throw new Error("no meta")
  const args = qemuArgs("t", p, meta, {
    installMedia: false,
    ephemeral: false,
    virtioBoot: true,
    display: RAMFB,
  })
  await lockPidfile(
    p.pid,
    resolve(runtime(), "bin", "qemu-system-aarch64"),
    ...args.filter((a) => a !== p.pid && a !== "-pidfile"),
    "-pidfile",
    p.pid,
  )
}

const NOT_REMOUNTED =
  "warning: the guest's drives were not mounted again (could not forward a host port to the guest's port 445: Could not set up host forwarding rule) — `winvm files mount -i t`\n"

function rememberDrives(): void {
  writeSmb(p, {
    user: SMB_USER,
    password: newPassword(),
    hostPort: 41_234,
    mounted: ["home", "c"],
  })
}

const timings = (text: string): string =>
  text
    .replaceAll(/[+-]?\d+(?:\.\d+)? (?:ms|s|B|KB|MB|GB|KiB|MiB|GiB)\b/g, "N")
    .replaceAll(/taken [^)]*\)/g, "taken T)")

function migrateTo(uri: string): void {
  const path = uri.startsWith("file:")
    ? uri.slice("file:".length)
    : / -o '([^']+)'$/.exec(uri)?.[1]
  if (path !== undefined) writeFileSync(path, "captured RAM")
}

function monitor(): void {
  const scripted = fakeQmp.handler
  fakeQmp.handler = async (cmd) => {
    const args = (cmd.arguments ?? {}) as Record<string, unknown>
    switch (cmd.execute) {
      case "migrate":
        migrateTo(String(args.uri))
        return { return: {} }
      case "query-migrate":
        return {
          return: { status: "completed", ram: { transferred: 4096 } },
        }
      case "quit":
        setTimeout(() => void qemuExits(), 20)
        return { return: {} }
      case "system_powerdown":
        fakeQmp.emit({
          event: "POWERDOWN",
          timestamp: { seconds: 5, microseconds: 0 },
        })
        if (powerdownExits)
          setTimeout(() => {
            fakeQmp.emit({
              event: "SHUTDOWN",
              data: { guest: true, reason: "guest-shutdown" },
              timestamp: { seconds: 6, microseconds: 0 },
            })
            setTimeout(() => void qemuExits(), 50)
          }, 50)
        return { return: {} }
      default:
        return await scripted(cmd)
    }
  }
}

beforeEach(async () => {
  saved = Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => k.startsWith("WINVM_"))
      .map((k) => [k, process.env[k]]),
  )
  home = mkdtempSync(resolve(tmpdir(), SCRATCH))
  for (const [k, v] of Object.entries(env()))
    if (k.startsWith("WINVM_")) process.env[k] = v
  p = pathsFor("t")
  mkdirSync(p.tpmDir, { recursive: true })
  writeFileSync(
    p.meta,
    JSON.stringify({ image: IMAGE, vnc: 9, created: "2026-11-02T00:00:00Z" }),
  )
  writeFileSync(p.overlay, "live disk")
  writeFileSync(p.vars, "live vars")
  mkdirSync(resolve(home, "images", IMAGE), { recursive: true })
  writeFileSync(basePath(IMAGE), "immutable base")
  writeFileSync(imageMetaPath(IMAGE), JSON.stringify({ virtioBoot: true }))
  mkdirSync(resolve(home, "firmware"), { recursive: true })
  writeFileSync(resolve(home, "firmware", "edk2-aarch64-code.fd"), "firmware")
  writeFileSync(resolve(home, "firmware", "edk2-arm-vars.fd"), "variables")
  mkdirSync(resolve(runtime(), "bin"), { recursive: true })
  const program = resolve(runtime(), "bin", "qemu-system-aarch64")
  writeFileSync(program, "")
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(program, old, old)
  powerdownExits = true
  await startQemu()
  fakeQmp = new FakeQmp(p.qmpQemu)
  await fakeQmp.listen()
  fakeAgent = new FakeAgent(p.qgaQemu)
  await fakeAgent.listen()
  guest = new FakeGuest(fakeQmp, fakeAgent)
  monitor()
  await startService()
})

afterEach(async () => {
  stopService(p)
  service?.kill("SIGKILL")
  await service?.exited
  service = null
  await releasePidfiles()
  await fakeQmp.close().catch(() => undefined)
  await fakeAgent.close().catch(() => undefined)
  for (const k of Object.keys(process.env))
    if (k.startsWith("WINVM_")) delete process.env[k]
  for (const [k, v] of Object.entries(saved))
    if (v !== undefined) process.env[k] = v
  rmSync(home, { recursive: true, force: true })
})

const begins = (operation: string): readonly Entry[] =>
  readSince("t", START).entries.filter(
    (e) => e.kind === "op" && e.phase === "begin" && e.operation === operation,
  )

describe("the suite's own cleanup", () => {
  it("names only a scratch home this suite made, so it can never match every process", () => {
    const made = resolve(tmpdir(), `${SCRATCH}Ab12Cd`)
    expect(scratchPattern(made, SCRATCH)).toBe(made)
    expect(scratchPattern("", SCRATCH)).toBeNull()
    expect(scratchPattern("/", SCRATCH)).toBeNull()
    expect(scratchPattern(tmpdir(), SCRATCH)).toBeNull()
    expect(scratchPattern(resolve(tmpdir(), SCRATCH), SCRATCH)).toBeNull()
    expect(scratchPattern(`/Users/someone/${SCRATCH}x`, SCRATCH)).toBeNull()
  })
})

describe("the long verbs, as the CLI prints and exits with them", () => {
  it("stop asks Windows to shut down and waits for QEMU to exit", async () => {
    expect(await winvm("stop", "-i", "t")).toEqual({
      code: 0,
      stdout: 'instance "t" stopped\n',
      stderr: "",
    })
    expect(fakeQmp.commands).toContain("system_powerdown")
    expect(existsSync(p.pid)).toBe(false)
  }, 30_000)

  it("stop of a stopped instance says it is not running", async () => {
    await qemuGoes()
    expect(await winvm("stop", "-i", "t")).toEqual({
      code: 0,
      stdout: 'instance "t" is not running\n',
      stderr: "",
    })
  }, 30_000)

  it("stow saves the guest, quits QEMU and says start recalls it", async () => {
    const r = await winvm("stow", "-i", "t")
    expect({ ...r, stdout: timings(r.stdout) }).toEqual({
      code: 0,
      stdout:
        "checking the guest has finished starting… \n" +
        'saved "stow" (stow, zstd) in N: RAM N -> N on disk, N total (disks are clones)\n' +
        'stowed "t" in N — QEMU is stopped; `winvm start -i t` recalls it\n',
      stderr: "",
    })
    expect(existsSync(resolve(home, "saves", "t", "stow", "manifest.json")))
  }, 30_000)

  it("stow refuses a QEMU that did not say which version it runs, with its own exit code", async () => {
    await qemuGoes()
    await lockPidfile(
      p.pid,
      "qemu-system-aarch64",
      "-device",
      "ramfb",
      "-pidfile",
      p.pid,
    )
    const r = await winvm("stow", "-i", "t")
    expect(r.code).toBe(5)
    expect(r.stdout).toBe("")
    expect(r.stderr).toStartWith("::error::")
    expect(existsSync(p.pid)).toBe(true)
  }, 30_000)

  it("stow of a stopped instance says it is not running", async () => {
    await qemuGoes()
    expect(await winvm("stow", "-i", "t")).toEqual({
      code: 1,
      stdout: "",
      stderr:
        '::error::instance "t" is not running — a save captures a live guest\n',
    })
  }, 30_000)

  it("save keeps the guest running and sets its clock", async () => {
    const r = await winvm("save", "-i", "t", "before-update", "--force")
    expect({ ...r, stdout: timings(r.stdout) }).toEqual({
      code: 0,
      stdout:
        'saved "before-update" (manual, zstd) in N: RAM N -> N on disk, N total (disks are clones)\n' +
        "  clock: guest was N from the host, now N\n",
      stderr: "",
    })
    expect(guest.status).toBe("running")
  }, 30_000)

  it("save refuses the name stow", async () => {
    expect(await winvm("save", "-i", "t", "stow")).toEqual({
      code: 1,
      stdout: "",
      stderr: '::error::"stow" is reserved for `winvm stow`\n',
    })
  }, 30_000)

  it("save refuses a format it does not know", async () => {
    expect(await winvm("save", "-i", "t", "x", "--format", "gzip")).toEqual({
      code: 1,
      stdout: "",
      stderr:
        '::error::--format must be one of zstd, mapped, raw, got "gzip"\n',
    })
  }, 30_000)

  it("load of an instance with no saves says so", async () => {
    expect(await winvm("load", "-i", "t")).toEqual({
      code: 1,
      stdout: "",
      stderr: '::error::instance "t" has no saves\n',
    })
  }, 30_000)

  it("load of a save that does not exist names the command that lists them", async () => {
    expect(await winvm("load", "-i", "t", "nope")).toEqual({
      code: 1,
      stdout: "",
      stderr: '::error::instance "t" has no save "nope" — `winvm saves -i t`\n',
    })
  }, 30_000)

  it("rewind with neither a snapshot nor a save says what is missing", async () => {
    await qemuGoes()
    expect(await winvm("rewind", "-i", "t", "nope")).toEqual({
      code: 1,
      stdout: "",
      stderr:
        '::error::instance "t" has no snapshot "nope" — `winvm snapshots -i t`\n',
    })
  }, 30_000)

  it("golden reset with no golden says so", async () => {
    const r = await winvm("golden", "reset", "-i", "t")
    expect(r).toEqual({
      code: 1,
      stdout: "",
      stderr:
        '::error::instance "t" has no save "golden" — `winvm saves -i t`\n',
    })
  }, 30_000)

  it.skipIf(process.platform !== "darwin")(
    "start of a running instance says so and mounts the guest's drives again",
    async () => {
      rememberDrives()
      expect(await winvm("start", "-i", "t", "--no-watch")).toEqual({
        code: 0,
        stdout: 'instance "t" already running\n',
        stderr: NOT_REMOUNTED,
      })
    },
    30_000,
  )

  it("a long verb meets another command holding the instance with the usual busy words", async () => {
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "reboot",
        id: "someone-else",
        pid: process.pid,
        pidStart: null,
        startedAt: "2026-11-17T00:00:00.000Z",
        instance: "t",
        automatic: false,
      }),
    )
    const r = await winvm("stop", "-i", "t")
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toStartWith(
      `::error::instance "t" is busy: reboot (pid ${String(process.pid)}) since 2026-11-17T00:00:00.000Z`,
    )
    expect(begins("stop")).toEqual([])
  }, 30_000)
})

const until = async (ok: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(20)
  }
}

const ends = (operation: string): readonly Entry[] =>
  readSince("t", START).entries.filter(
    (e) => e.kind === "op" && e.phase === "end" && e.operation === operation,
  )

describe("the long verbs, run by winvm's service", () => {
  const ranBy = (operation: string): number | undefined => {
    const b = begins(operation).at(-1)
    return b?.kind === "op" && b.phase === "begin" ? b.pid : undefined
  }

  it("stop runs in the service", async () => {
    expect((await winvm("stop", "-i", "t")).code).toBe(0)
    expect(ranBy("stop")).toBe(service?.pid)
  }, 30_000)

  it("stow runs in the service", async () => {
    expect((await winvm("stow", "-i", "t")).code).toBe(0)
    expect(ranBy("stow")).toBe(service?.pid)
  }, 30_000)

  it("save runs in the service", async () => {
    expect((await winvm("save", "-i", "t", "x", "--force")).code).toBe(0)
    expect(ranBy("save")).toBe(service?.pid)
  }, 30_000)

  it.skipIf(process.platform !== "darwin")(
    "start of a running instance runs in the service, and the CLI mounts the drives",
    async () => {
      rememberDrives()
      expect((await winvm("start", "-i", "t", "--no-watch")).code).toBe(0)
      expect(ranBy("start")).toBe(service?.pid)
      expect(
        readSince("t", START).entries.some(
          (e) =>
            e.kind === "op" && e.phase === "output" && e.text.includes("445"),
        ),
      ).toBe(false)
    },
    30_000,
  )

  it("load, rewind and golden reset run in the service", async () => {
    expect((await winvm("load", "-i", "t", "nope")).code).toBe(1)
    expect(ranBy("load")).toBe(service?.pid)
    expect((await winvm("golden", "reset", "-i", "t")).code).toBe(1)
    expect(ranBy("golden-reset")).toBe(service?.pid)
    await qemuGoes()
    expect((await winvm("rewind", "-i", "t", "nope")).code).toBe(1)
    expect(ranBy("rewind")).toBe(service?.pid)
  }, 30_000)

  it("a stop interrupted after its request detaches, and the stop ends normally in the service", async () => {
    powerdownExits = false
    const r = launch("stop", "-i", "t")
    await until(() => fakeQmp.commands.includes("system_powerdown"))
    r.proc.kill("SIGINT")
    expect(await r.done).toEqual({
      code: 130,
      stdout: "",
      stderr:
        "stop continues in winvm's service; follow it with `winvm events -i t --follow`\n",
    })
    expect(ends("stop")).toEqual([])
    fakeQmp.emit({
      event: "SHUTDOWN",
      data: { guest: true, reason: "guest-shutdown" },
      timestamp: { seconds: 6, microseconds: 0 },
    })
    await qemuGoes()
    await until(() => ends("stop").length > 0)
    expect(ends("stop")[0]).toMatchObject({ ok: true, exitCode: 0 })
  }, 30_000)

  it("a save cancelled before its migration completes asks QEMU to cancel it, and keeps Windows running", async () => {
    let cancelled = false
    const scripted = fakeQmp.handler
    fakeQmp.handler = async (cmd) => {
      if (cmd.execute === "migrate_cancel") {
        cancelled = true
        return { return: {} }
      }
      if (cmd.execute === "query-migrate")
        return {
          return: { status: cancelled ? "cancelled" : "active" },
        }
      return await scripted(cmd)
    }
    const r = launch("save", "-i", "t", "x", "--force")
    await until(() => fakeQmp.commands.includes("migrate"))
    const c = await winvm("cancel", "-i", "t")
    expect(c).toEqual({
      code: 0,
      stdout: 'cancelled save on "t"\n',
      stderr: "",
    })
    const done = await r.done
    expect(done.code).toBe(130)
    expect(done.stderr).toContain("save was cancelled (winvm cancel)")
    expect(fakeQmp.commands).toContain("migrate_cancel")
    expect(guest.status).toBe("running")
    expect(existsSync(resolve(home, "saves", "t", "x"))).toBe(false)
  }, 30_000)

  it("a stop cannot be cancelled once it has asked Windows to shut down", async () => {
    powerdownExits = false
    const r = launch("stop", "-i", "t")
    await until(() => fakeQmp.commands.includes("system_powerdown"))
    const c = await winvm("cancel", "-i", "t")
    expect(c.code).toBe(1)
    expect(c.stderr).toContain("stop is past its point of no return")
    await qemuGoes()
    expect((await r.done).code).toBe(0)
  }, 30_000)
})

describe("a command whose own WINVM_KEEPER differs from the service's", () => {
  it("runs in the CLI, so a per-command WINVM_KEEPER takes effect", async () => {
    const proc = Bun.spawn([process.execPath, CLI, "pause", "-i", "t"], {
      env: { ...env(), WINVM_KEEPER: resolve(home, "another-keeper") },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await proc.exited).toBe(0)
    const b = begins("pause").at(-1)
    expect(b?.kind === "op" && b.phase === "begin" ? b.pid : null).toBe(
      proc.pid,
    )
  }, 30_000)
})

describe("the long verbs, with a service from before they moved", () => {
  let control: ReturnType<typeof Bun.serve> | null = null

  afterEach(async () => {
    await control?.stop(true)
    control = null
  })

  it("run in the CLI itself when the service does not run them, with the same output", async () => {
    stopService(p)
    service?.kill("SIGKILL")
    await service?.exited
    service = null
    rmSync(p.control, { force: true })
    const broker = new QmpChannel({ listen: p.qmp, upstream: p.qmpQemu })
    await broker.start()
    const agentBroker = new QgaChannel({
      listen: p.qga,
      upstream: p.qgaQemu,
      portOpen: () => Promise.resolve(true),
    })
    await agentBroker.start()
    control = Bun.serve({
      unix: p.control,
      fetch: () =>
        Response.json(
          { protocol: 1, error: "this service does not run save" },
          { status: 501 },
        ),
    })
    try {
      const r = launch("save", "-i", "t", "x", "--force")
      const done = await r.done
      expect({ ...done, stdout: timings(done.stdout) }).toEqual({
        code: 0,
        stdout:
          'saved "x" (manual, zstd) in N: RAM N -> N on disk, N total (disks are clones)\n' +
          "  clock: guest was N from the host, now N\n",
        stderr: "",
      })
      expect(ranByCli("save")).toBe(r.proc.pid)
    } finally {
      await broker.stop()
      await agentBroker.stop()
    }
  }, 30_000)
})

const ranByCli = (operation: string): number | undefined => {
  const b = begins(operation).at(-1)
  return b?.kind === "op" && b.phase === "begin" ? b.pid : undefined
}

describe("an op a client names, and reads back from the record", () => {
  const ID = "0b9c2f1e-7d3a-4e5b-9c8d-112233445566"

  const named = (id: string): readonly Entry[] =>
    readSince("t", START).entries.filter((e) => e.kind === "op" && e.id === id)

  it("runs under the id the client gave", async () => {
    expect((await winvm("stow", "-i", "t", "--op-id", ID)).code).toBe(0)
    expect(named(ID).map((e) => (e.kind === "op" ? e.phase : ""))).toContain(
      "begin",
    )
    expect(named(ID).at(-1)).toMatchObject({ phase: "end", exitCode: 0 })
  }, 30_000)

  it("refuses an id that is not one", async () => {
    expect(await winvm("stop", "-i", "t", "--op-id", "x y")).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "::error::--op-id wants 8 to 64 letters, digits and dashes, starting with a letter or digit\n",
    })
    expect(fakeQmp.commands).not.toContain("system_powerdown")
  }, 30_000)

  it("is named in status while it runs", async () => {
    powerdownExits = false
    const r = launch("stop", "-i", "t", "--op-id", ID)
    await until(() => fakeQmp.commands.includes("system_powerdown"))
    const s = await winvm("status", "-i", "t", "--json")
    expect(JSON.parse(s.stdout)).toMatchObject({
      operation: { operation: "stop", id: ID },
    })
    await qemuGoes()
    await r.done
  }, 30_000)

  it("is read back by its id: how it ended and what it said", async () => {
    await winvm("save", "-i", "t", "x", "--force", "--op-id", ID)
    const r = await winvm("events", "-i", "t", "--op", ID, "--json")
    expect(r.code).toBe(0)
    const got = JSON.parse(r.stdout) as Record<string, unknown>
    expect(got).toMatchObject({
      id: ID,
      operation: "save",
      ended: true,
      ok: true,
      exitCode: 0,
    })
    expect(String(got.output)).toContain('saved "x" (manual, zstd)')
  }, 30_000)

  it("is followed by its id until it ends", async () => {
    powerdownExits = false
    const r = launch("stop", "-i", "t", "--op-id", ID)
    await until(() => fakeQmp.commands.includes("system_powerdown"))
    const following = launch("events", "-i", "t", "--op", ID, "--follow")
    await Bun.sleep(300)
    await qemuGoes()
    expect(await following.done).toEqual({
      code: 0,
      stdout: 'instance "t" stopped\n',
      stderr: "",
    })
    await r.done
  }, 30_000)

  it("says so when no op of that id was recorded, and does not wait for it", async () => {
    const r = await winvm("events", "-i", "t", "--op", ID, "--follow", "--json")
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ id: ID, ended: false })
  }, 30_000)
})

describe("the long verbs that launch QEMU, run by winvm's service with the keeper off", () => {
  const FAKE_QEMU = resolve(import.meta.dir, "fakes", "qemu.ts")

  const fakeRuntime = (): void => {
    const bin = resolve(runtime(), "bin")
    const script = (name: string, body: string): void => {
      writeFileSync(resolve(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(resolve(bin, name), 0o755)
    }
    script(
      "swtpm",
      `while [ $# -gt 0 ]; do case "$1" in --ctrl) s="\${2#*path=}"; s="\${s%%,*}"; shift;; esac; shift; done; : > "$s"\nwhile :; do sleep 1; done`,
    )
    script(
      "qemu-system-aarch64",
      `exec "${process.execPath}" "${FAKE_QEMU}" "$0" "$@"`,
    )
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(resolve(bin, "qemu-system-aarch64"), old, old)
  }

  const publish = (name: string, kind: Manifest["kind"]): void => {
    const meta = readMeta("t")
    if (meta === null) throw new Error("no meta")
    const compat = currentCompat("t", meta, RAMFB)
    const m: Manifest = {
      name,
      instance: "t",
      kind,
      createdAt: "2026-11-02T00:00:00Z",
      bytes: 42,
      image: IMAGE,
      compat: compat.hash,
      compatParts: compat.parts,
      format: "raw",
      ramFile: FILES.ramRaw,
      display: RAMFB,
    }
    const dir = saveDir("t", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, FILES.manifest), JSON.stringify(m))
    writeFileSync(resolve(dir, FILES.ramRaw), "saved RAM")
    writeFileSync(resolve(dir, FILES.overlay), `${name} disk`)
    writeFileSync(resolve(dir, FILES.vars), `${name} vars`)
  }

  afterEach(() => {
    const pattern = scratchPattern(home, SCRATCH)
    if (pattern !== null) Bun.spawnSync(["pkill", "-KILL", "-f", pattern])
  })

  it.skipIf(process.platform !== "darwin")(
    "load, rewind and golden reset launch a new QEMU and end well, and a start in the service's linger boots one",
    async () => {
      writeDisplay(p, RAMFB)
      fakeRuntime()
      publish("named", "manual")
      publish("golden", "golden")
      const run = async (...argv: string[]): Promise<Ran> => {
        const proc = Bun.spawn([process.execPath, CLI, ...argv], {
          env: env(),
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { code, stdout, stderr }
      }
      const loaded = await run("load", "-i", "t", "named")
      expect(loaded.code).toBe(0)
      expect(loaded.stdout).toContain('loaded "t" from "named"')
      expect(ranByCli("load")).toBe(service?.pid)
      expect(readFileSync(p.overlay, "utf8")).toBe("named disk")

      const rewound = await run("rewind", "-i", "t", "named")
      expect(rewound.code).toBe(0)
      expect(rewound.stdout).toContain('rewound "t" from "named"')
      expect(ranByCli("rewind")).toBe(service?.pid)

      const reset = await run("golden", "reset", "-i", "t")
      expect(reset.code).toBe(0)
      expect(reset.stdout).toContain('reset "t" to "golden"')
      expect(ranByCli("golden-reset")).toBe(service?.pid)

      expect((await run("stop", "-i", "t")).code).toBe(0)
      const started = await run("start", "-i", "t", "--no-watch")
      expect(started.code).toBe(0)
      expect(started.stdout).toContain('instance "t" up')
      expect(ranByCli("start")).toBe(service?.pid)

      const lines = readFileSync(resolve(home, "fake-qemu.log"), "utf8")
        .trim()
        .split("\n")
      expect(lines.filter((l) => l.startsWith("start "))).toHaveLength(4)
      expect(lines.filter((l) => l.startsWith("lock-failed"))).toEqual([])
      let alive = 0
      for (const l of lines) {
        alive += l.startsWith("start ") ? 1 : l.startsWith("exit ") ? -1 : 0
        expect(alive).toBeLessThanOrEqual(1)
      }
      for (const e of ["load", "rewind", "golden-reset", "start"]) {
        const end = readSince("t", START).entries.findLast(
          (x) => x.kind === "op" && x.phase === "end" && x.operation === e,
        )
        expect(end).toMatchObject({ ok: true, exitCode: 0 })
      }
    },
    90_000,
  )
})
