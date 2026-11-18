import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { RAMFB } from "../src/display"
import { type Entry, readSince, START } from "../src/eventlog"
import {
  basePath,
  imageMetaPath,
  type Paths,
  pathsFor,
  readMeta,
} from "../src/paths"
import { qemuArgs } from "../src/qemu"
import { stopService } from "../src/servicectl"
import { newPassword, SMB_USER, writeSmb } from "../src/smbstate"
import { FakeAgent } from "./fakes/agent"
import { FakeGuest } from "./fakes/guest"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"
import { FakeQmp } from "./fakes/qmp"

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
        setTimeout(() => void qemuGoes(), 20)
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
            setTimeout(() => void qemuGoes(), 50)
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
  home = mkdtempSync(resolve(tmpdir(), "winvm-long-"))
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

  it("start of a running instance says so and mounts the guest's drives again", async () => {
    rememberDrives()
    expect(await winvm("start", "-i", "t", "--no-watch")).toEqual({
      code: 0,
      stdout: 'instance "t" already running\n',
      stderr: NOT_REMOUNTED,
    })
  }, 30_000)

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
