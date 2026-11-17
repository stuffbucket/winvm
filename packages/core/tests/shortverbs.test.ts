import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { PACKAGE_DIR, type Paths, pathsFor } from "../src/paths"
import { stopService } from "../src/servicectl"
import { FakeAgent } from "./fakes/agent"
import { FakeGuest } from "./fakes/guest"
import {
  type LockedPidfile,
  lockPidfile,
  releasePidfiles,
} from "./fakes/pidfile"
import { FakeQmp } from "./fakes/qmp"

const CLI = resolve(PACKAGE_DIR, "..", "..", "apps", "cli", "src", "winvm.ts")

let home = ""
let saved: Record<string, string | undefined> = {}
let p: Paths
let fakeQmp: FakeQmp
let fakeAgent: FakeAgent
let guest: FakeGuest
let qemu: LockedPidfile
let service: ReturnType<typeof Bun.spawn> | null = null

const env = (): Record<string, string> => {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("WINVM_")) e[k] = v
  return {
    ...e,
    WINVM_HOME: home,
    WINVM_CLI: CLI,
    WINVM_BUILD_ID: "sha256:short-verbs",
    WINVM_NO_RECONCILE: "1",
    WINVM_KEEPER: "off",
  }
}

interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function winvm(...argv: readonly string[]): Promise<Ran> {
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

const clock = (text: string): string =>
  text.replaceAll(/[+-]\d+(?:\.\d+)? (?:ms|s)\b/g, "±T")

beforeEach(async () => {
  saved = Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => k.startsWith("WINVM_"))
      .map((k) => [k, process.env[k]]),
  )
  home = mkdtempSync(resolve(tmpdir(), "winvm-verbs-"))
  process.env.WINVM_HOME = home
  p = pathsFor("t")
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(
    p.meta,
    JSON.stringify({ image: "win11-arm64", vnc: 9, created: "" }),
  )
  qemu = await lockPidfile(p.pid, "qemu-system-aarch64", "-pidfile", p.pid)
  fakeQmp = new FakeQmp(p.qmpQemu)
  await fakeQmp.listen()
  fakeAgent = new FakeAgent(p.qgaQemu)
  await fakeAgent.listen()
  guest = new FakeGuest(fakeQmp, fakeAgent)
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

describe("the short verbs, as the CLI prints and exits with them", () => {
  it("pause stops the guest and says how to resume it", async () => {
    expect(await winvm("pause", "-i", "t")).toEqual({
      code: 0,
      stdout: 'paused "t" — `winvm resume -i t` to continue\n',
      stderr: "",
    })
    expect(fakeQmp.commands).toContain("stop")
    expect(guest.status).toBe("paused")
  }, 30_000)

  it("resume continues a paused guest and sets its clock", async () => {
    guest.status = "paused"
    const r = await winvm("resume", "-i", "t")
    expect({ ...r, stdout: clock(r.stdout) }).toEqual({
      code: 0,
      stdout: '  clock: guest was ±T from the host, now ±T\nresumed "t"\n',
      stderr: "",
    })
    expect(guest.status).toBe("running")
  }, 30_000)

  it("resume of a running guest says so and still sets its clock", async () => {
    const r = await winvm("resume", "-i", "t")
    expect({ ...r, stdout: clock(r.stdout) }).toEqual({
      code: 0,
      stdout:
        '"t" was not paused\n  clock: guest was ±T from the host, now ±T\n',
      stderr: "",
    })
    expect(fakeQmp.commands).not.toContain("cont")
  }, 30_000)

  it("wake continues a guest put to sleep and names the lock screen", async () => {
    guest.status = "paused"
    writeFileSync(
      resolve(p.dir, "asleep.json"),
      JSON.stringify({ pid: qemu.pid, at: new Date().toISOString() }),
    )
    const r = await winvm("wake", "-i", "t")
    expect({ ...r, stdout: clock(r.stdout) }).toEqual({
      code: 0,
      stdout:
        '  clock: guest was ±T from the host, now ±T\nwoke "t" — Windows is at its lock screen\n',
      stderr: "",
    })
    expect(existsSync(resolve(p.dir, "asleep.json"))).toBe(false)
  }, 30_000)

  it("sleep refuses a guest that is already paused", async () => {
    guest.status = "paused"
    expect(await winvm("sleep", "-i", "t")).toEqual({
      code: 1,
      stdout: "",
      stderr: '::error::instance "t" is already paused\n',
    })
  }, 30_000)

  it("lock says why it could not lock a paused guest", async () => {
    guest.status = "paused"
    const r = await winvm("lock", "-i", "t")
    expect(r.code).toBe(1)
    expect(r.stdout).toBe("")
    expect(r.stderr).toStartWith('::error::could not lock Windows in "t": ')
    expect(r.stderr).toContain("paused")
  }, 30_000)

  it("reboot restarts Windows and waits for it to come back", async () => {
    expect(await winvm("reboot", "-i", "t")).toEqual({
      code: 0,
      stdout: 'rebooting\ninstance "t" rebooted in 0 s\n',
      stderr: "",
    })
    expect(guest.shutdownRequests).toEqual(["reboot"])
  }, 30_000)

  it("reboot refuses a timeout that is not a number of seconds", async () => {
    expect(await winvm("reboot", "-i", "t", "--timeout", "soon")).toEqual({
      code: 1,
      stdout: "",
      stderr: '::error::--timeout wants seconds, got "soon"\n',
    })
    expect(guest.shutdownRequests).toEqual([])
  }, 30_000)

  it("kill ends QEMU and says so", async () => {
    expect(await winvm("kill", "-i", "t")).toEqual({
      code: 0,
      stdout: 'killed instance "t"\n',
      stderr: "",
    })
    expect(await qemu.proc.exited).not.toBe(0)
    expect(existsSync(p.pid)).toBe(false)
  }, 30_000)

  for (const verb of ["pause", "resume", "wake", "sleep", "lock", "reboot"])
    it(`${verb} of a stopped instance says it is not running`, async () => {
      await releasePidfiles()
      const r = await winvm(verb, "-i", "t")
      expect(r.code).toBe(1)
      expect(r.stdout).toBe("")
      expect(r.stderr).toStartWith('::error::instance "t" is not running')
    }, 30_000)

  it("kill of a stopped instance says it is not running", async () => {
    await releasePidfiles()
    expect(await winvm("kill", "-i", "t")).toEqual({
      code: 0,
      stdout: 'instance "t" is not running\n',
      stderr: "",
    })
  }, 30_000)

  it("a verb another command holds the instance for is refused as busy", async () => {
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "stop",
        id: "held-by-test",
        pid: process.pid,
        pidStart: null,
        startedAt: "2026-11-17T10:00:00.000Z",
        instance: "t",
        automatic: false,
      }),
    )
    expect(await winvm("pause", "-i", "t")).toEqual({
      code: 1,
      stdout: "",
      stderr: `::error::instance "t" is busy: stop (pid ${String(process.pid)}) since 2026-11-17T10:00:00.000Z; try again once it finishes\n`,
    })
    expect(fakeQmp.commands).not.toContain("stop")
    expect(JSON.parse(readFileSync(p.lease, "utf8"))).toMatchObject({
      id: "held-by-test",
    })
  }, 30_000)
})
