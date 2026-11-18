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

import { QmpChannel } from "../src/broker"
import { type Entry, readSince, START } from "../src/eventlog"
import { PACKAGE_DIR, type Paths, pathsFor } from "../src/paths"
import { stopService } from "../src/servicectl"
import { newPassword, SMB_USER, writeSmb } from "../src/smbstate"
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
    WINVM_MOUNTS: resolve(home, "mounts"),
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
  readonly stdout: () => string
}

function launch(...argv: readonly string[]): Running {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  })
  let out = ""
  const dec = new TextDecoder()
  const reading = (async (): Promise<string> => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>)
      out += dec.decode(chunk)
    return out
  })()
  const done = Promise.all([
    reading,
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
  return { proc, done, stdout: () => out }
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

async function stopTheService(): Promise<void> {
  stopService(p)
  service?.kill("SIGKILL")
  await service?.exited
  service = null
  rmSync(p.control, { force: true })
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

  it("resume tries to mount the guest's drives again, and says why it could not", async () => {
    rememberDrives()
    guest.status = "paused"
    const r = await winvm("resume", "-i", "t")
    expect({ ...r, stdout: clock(r.stdout) }).toEqual({
      code: 0,
      stdout: '  clock: guest was ±T from the host, now ±T\nresumed "t"\n',
      stderr: NOT_REMOUNTED,
    })
  }, 30_000)

  it("reboot tries to mount the guest's drives again, and says why it could not", async () => {
    rememberDrives()
    expect(await winvm("reboot", "-i", "t")).toEqual({
      code: 0,
      stdout: 'rebooting\ninstance "t" rebooted in 0 s\n',
      stderr: NOT_REMOUNTED,
    })
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
    expect(
      await Promise.race([
        service?.exited.then(() => "stopped"),
        Bun.sleep(5000).then(() => "still running"),
      ]),
    ).toBe("stopped")
  }, 30_000)

  const stoppedWith = async (
    verb: string,
    service: "up" | "gone",
  ): Promise<{ readonly r: Ran; readonly pid: number | undefined }> => {
    await releasePidfiles()
    if (service === "gone") await stopTheService()
    const run = launch(verb, "-i", "t")
    return { r: await run.done, pid: run.proc.pid }
  }

  for (const service of ["up", "gone"] as const) {
    for (const verb of ["pause", "resume", "wake", "sleep", "lock", "reboot"])
      it(`${verb} of a stopped instance says it is not running, with the service ${service}`, async () => {
        const { r } = await stoppedWith(verb, service)
        expect(r.code).toBe(1)
        expect(r.stdout).toBe("")
        expect(r.stderr).toStartWith('::error::instance "t" is not running')
      }, 30_000)

    it(`kill of a stopped instance says it is not running, with the service ${service}`, async () => {
      const { r } = await stoppedWith("kill", service)
      expect(r).toEqual({
        code: 0,
        stdout: 'instance "t" is not running\n',
        stderr: "",
      })
    }, 30_000)
  }

  it("kill succeeds when another kill already ended QEMU and still holds the instance", async () => {
    await releasePidfiles()
    await stopTheService()
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "kill",
        id: "the-other-kill",
        pid: process.pid,
        pidStart: null,
        startedAt: "2026-11-17T10:00:00.000Z",
        instance: "t",
        automatic: false,
      }),
    )
    expect(await winvm("kill", "-i", "t")).toEqual({
      code: 0,
      stdout: 'instance "t" is not running\n',
      stderr: `note: kill (pid ${String(process.pid)}) holds "t"; killing it anyway\n`,
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

const ops = (): readonly Entry[] =>
  readSince("t", START).entries.filter((e) => e.kind === "op")

const endOf = (operation: string): Entry | undefined =>
  ops().find(
    (e) => e.kind === "op" && e.phase === "end" && e.operation === operation,
  )

const until = async (ok: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(20)
  }
}

describe("the short verbs, run by winvm's service", () => {
  const begun = (operation: string): Entry | undefined =>
    ops().find(
      (e) =>
        e.kind === "op" && e.phase === "begin" && e.operation === operation,
    )

  for (const [verb, paused] of [
    ["pause", false],
    ["resume", true],
    ["wake", true],
    ["sleep", true],
    ["lock", true],
    ["reboot", false],
    ["kill", false],
  ] as const)
    it(`${verb} runs in the service`, async () => {
      if (paused) guest.status = "paused"
      const servicePid = service?.pid
      await winvm(verb, "-i", "t")
      expect(begun(verb)).toMatchObject({ pid: servicePid })
    }, 30_000)

  for (const verb of [
    "pause",
    "resume",
    "wake",
    "sleep",
    "lock",
    "reboot",
    "kill",
  ])
    it(`${verb} runs in the CLI itself when no service answers`, async () => {
      const { pid } = await (async () => {
        await releasePidfiles()
        await stopTheService()
        const run = launch(verb, "-i", "t")
        await run.done
        return { pid: run.proc.pid }
      })()
      expect(begun(verb)).toMatchObject({ pid })
    }, 30_000)

  it("run in the service, which records what they printed under the op's id", async () => {
    expect((await winvm("pause", "-i", "t")).code).toBe(0)
    const begin = ops().find((e) => e.kind === "op" && e.phase === "begin")
    expect(begin).toMatchObject({ operation: "pause", pid: service?.pid })
    const id = begin?.kind === "op" ? begin.id : ""
    expect(
      ops().filter(
        (e) => e.kind === "op" && e.id === id && e.phase === "output",
      ),
    ).toEqual([
      expect.objectContaining({
        stream: "out",
        text: 'paused "t" — `winvm resume -i t` to continue\n',
      }) as Entry,
    ])
  }, 30_000)

  for (const verb of ["resume", "reboot"])
    it(`${verb} leaves the guest's drives to the CLI that follows it, and never mounts them in the service`, async () => {
      rememberDrives()
      if (verb === "resume") guest.status = "paused"
      const r = await winvm(verb, "-i", "t")
      expect(r.code).toBe(0)
      expect(r.stderr).toBe(NOT_REMOUNTED)
      const own = ops().filter((e) => e.kind === "op" && e.operation === verb)
      expect(
        own.filter(
          (e) =>
            e.kind === "op" &&
            e.phase === "output" &&
            e.text.includes("mounted again"),
        ),
      ).toEqual([])
      expect(own.map((e) => (e.kind === "op" ? e.phase : ""))).toContain(
        "remount",
      )
      expect(endOf(verb)).toMatchObject({ remount: true })
    }, 30_000)

  it("status names the command that mounts the drives again when no one did", async () => {
    rememberDrives()
    const r = await winvm("status", "-i", "t", "--json")
    expect(r.code).toBe(0)
    const notes = (JSON.parse(r.stdout) as { notes: string[] }).notes
    expect(notes).toContain(
      "the guest's drives Home and C were mounted before and are not now; `winvm files mount -i t` mounts them again",
    )
  }, 30_000)

  it("leave the op running when the CLI is interrupted, and say how to follow it", async () => {
    guest.bootDelayMs = 2000
    const r = launch("reboot", "-i", "t")
    await until(() => r.stdout().includes("rebooting"))
    r.proc.kill("SIGINT")
    expect(await r.done).toEqual({
      code: 130,
      stdout: "rebooting",
      stderr:
        "reboot continues in winvm's service; follow it with `winvm events -i t --follow`\n",
    })
    expect(endOf("reboot")).toBeUndefined()
    await until(() => endOf("reboot") !== undefined)
    expect(endOf("reboot")).toMatchObject({ ok: true, exitCode: 0 })
  }, 30_000)

  it("finish and are recorded when the CLI is killed outright", async () => {
    guest.bootDelayMs = 1500
    const r = launch("reboot", "-i", "t")
    await until(() => r.stdout().includes("rebooting"))
    r.proc.kill("SIGKILL")
    expect((await r.done).code).not.toBe(0)
    await until(() => endOf("reboot") !== undefined)
    expect(endOf("reboot")).toMatchObject({ ok: true, exitCode: 0 })
    expect(guest.shutdownRequests).toEqual(["reboot"])
  }, 30_000)

  it("are refused as busy while another op runs, and queue behind it with --wait", async () => {
    guest.bootDelayMs = 1500
    const first = launch("reboot", "-i", "t")
    await until(() => first.stdout().includes("rebooting"))
    const busy = await winvm("pause", "-i", "t")
    expect(busy.code).toBe(1)
    expect(busy.stderr).toStartWith(
      `::error::instance "t" is busy: reboot (pid ${String(service?.pid)}) since `,
    )
    const waited = await winvm("pause", "-i", "t", "--wait")
    expect(waited).toEqual({
      code: 0,
      stdout: 'paused "t" — `winvm resume -i t` to continue\n',
      stderr: `instance "t": waiting for the reboot (pid ${String(service?.pid)}) to finish\n`,
    })
    expect((await first.done).code).toBe(0)
    expect(guest.status).toBe("paused")
  }, 30_000)

  it("say how to take a queued op off the queue when the CLI is interrupted while it waits", async () => {
    guest.bootDelayMs = 2500
    const first = launch("reboot", "-i", "t")
    await until(() => first.stdout().includes("rebooting"))
    const queued = launch("pause", "-i", "t", "--wait")
    await until(() =>
      ops().some(
        (e) =>
          e.kind === "op" &&
          e.phase === "output" &&
          e.operation === "pause" &&
          e.text.includes("waiting for the reboot"),
      ),
    )
    queued.proc.kill("SIGINT")
    const detached = await queued.done
    expect(detached.code).toBe(130)
    expect(detached.stderr).toContain(
      "pause continues in winvm's service; follow it with `winvm events -i t --follow`\n",
    )
    const id = /winvm cancel -i t --id (\S+)`/.exec(detached.stderr)?.[1]
    expect(id).toBeDefined()
    expect(await winvm("cancel", "-i", "t", "--id", id ?? "")).toEqual({
      code: 0,
      stdout: 'cancelled pause on "t"\n',
      stderr: "",
    })
    expect((await first.done).code).toBe(0)
    expect(endOf("pause")).toMatchObject({ ok: false, exitCode: 130 })
    expect(guest.status).toBe("running")
  }, 30_000)

  it("can be cancelled before their point of no return, and not after it", async () => {
    guest.holdBootQuery = true
    const r = launch("reboot", "-i", "t")
    await until(() => ops().some((e) => e.kind === "op" && e.phase === "begin"))
    expect(await winvm("cancel", "-i", "t")).toEqual({
      code: 0,
      stdout: 'cancelled reboot on "t"\n',
      stderr: "",
    })
    const cancelled = await r.done
    expect(cancelled.code).toBe(130)
    expect(cancelled.stderr).toContain("reboot was cancelled")
    guest.holdBootQuery = false
    await Bun.sleep(300)
    expect(guest.shutdownRequests).toEqual([])

    guest.bootDelayMs = 1500
    const again = launch("reboot", "-i", "t")
    await until(() => again.stdout().includes("rebooting"))
    const refused = await winvm("cancel", "-i", "t")
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("point of no return")
    expect((await again.done).code).toBe(0)
  }, 30_000)

  it("say there is nothing to cancel when no op runs", async () => {
    expect(await winvm("cancel", "-i", "t")).toEqual({
      code: 1,
      stdout: "",
      stderr: `::error::nothing is running in winvm's service for "t", so nothing was cancelled\n`,
    })
  }, 30_000)

  it("say so when the service ends before the op does, instead of waiting for ever", async () => {
    guest.bootDelayMs = 60_000
    const r = launch("reboot", "-i", "t")
    await until(() => r.stdout().includes("rebooting"))
    service?.kill("SIGKILL")
    expect(await r.done).toEqual({
      code: 1,
      stdout: "rebooting",
      stderr:
        '::error::winvm\'s service for "t" ended before reboot finished; `winvm events -i t` shows how far it got\n',
    })
  }, 30_000)

  it("end the op in flight when kill runs beside it", async () => {
    guest.bootDelayMs = 60_000
    const r = launch("reboot", "-i", "t")
    await until(() => r.stdout().includes("rebooting"))
    expect(await winvm("kill", "-i", "t")).toEqual({
      code: 0,
      stdout: 'killed instance "t"\n',
      stderr: `note: reboot (pid ${String(service?.pid)}) holds "t"; killing it anyway\n`,
    })
    expect(await r.done).toEqual({
      code: 1,
      stdout: "rebooting",
      stderr: "::error::reboot was ended by `winvm kill` while it ran\n",
    })
    expect(endOf("reboot")).toMatchObject({ ok: false, error: "killed" })
  }, 30_000)
})

describe("the short verbs, with a service that runs no ops", () => {
  let broker: QmpChannel | null = null
  let control: ReturnType<typeof Bun.serve> | null = null

  const replace = async (
    fetch: (req: Request) => Response | Promise<Response>,
  ): Promise<void> => {
    stopService(p)
    service?.kill("SIGKILL")
    await service?.exited
    service = null
    rmSync(p.control, { force: true })
    broker = new QmpChannel({ listen: p.qmp, upstream: p.qmpQemu })
    await broker.start()
    control = Bun.serve({ unix: p.control, fetch })
  }

  afterEach(async () => {
    await control?.stop(true)
    control = null
    await broker?.stop()
    broker = null
  })

  it("run in the CLI itself when the service is older and has no ops, with the same output", async () => {
    await replace(() => new Response("not found", { status: 404 }))
    const r = launch("pause", "-i", "t")
    expect(await r.done).toEqual({
      code: 0,
      stdout: 'paused "t" — `winvm resume -i t` to continue\n',
      stderr: "",
    })
    expect(
      ops().find((e) => e.kind === "op" && e.phase === "begin"),
    ).toMatchObject({ operation: "pause", pid: r.proc.pid })
    expect(guest.status).toBe("paused")
  }, 30_000)

  it("say so, and change nothing, when the service takes the op but never answers", async () => {
    await replace(async () => {
      await new Promise(() => undefined)
      return new Response(null)
    })
    const r = await winvm("pause", "-i", "t")
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`winvm's service for "t" did not answer`)
    expect(r.stderr).toContain("winvm events -i t")
    expect(guest.status).toBe("running")
  }, 30_000)

  it("never follow an op whose service names a pid that can't be it", async () => {
    await replace(() =>
      Response.json(
        {
          protocol: 1,
          id: "op-1",
          cursor: { ino: 0, generation: null, offset: 0, archive: null },
          pid: 1,
          queued: null,
        },
        { status: 202 },
      ),
    )
    const r = await winvm("pause", "-i", "t")
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`winvm's service for "t" did not answer`)
  }, 30_000)

  it("run nothing, in the service or the CLI, once the Mac is shutting down", async () => {
    await replace(() =>
      Response.json(
        {
          protocol: 1,
          error: "the Mac is shutting down",
          hostEnding: true,
        },
        { status: 503 },
      ),
    )
    expect(await winvm("pause", "-i", "t")).toEqual({
      code: 1,
      stdout: "",
      stderr: "::error::the Mac is shutting down, so pause was not run\n",
    })
    expect(guest.status).toBe("running")
  }, 30_000)

  const accepted = (o: { readonly pidStart?: string } = {}): Response =>
    Response.json(
      {
        protocol: 1,
        id: "op-1",
        cursor: { ino: 0, generation: null, offset: 0, archive: null },
        pid: process.pid,
        queued: null,
        ...o,
      },
      { status: 202 },
    )

  it("detach with the op's id when interrupted while the service is answering", async () => {
    await replace(async () => {
      await Bun.sleep(1000)
      return accepted()
    })
    const r = launch("pause", "-i", "t")
    await Bun.sleep(400)
    r.proc.kill("SIGINT")
    expect(await r.done).toEqual({
      code: 130,
      stdout: "",
      stderr:
        "pause continues in winvm's service; follow it with `winvm events -i t --follow`\n",
    })
  }, 30_000)

  it("take a service whose pid now names another process as gone", async () => {
    await replace(() => accepted({ pidStart: "Thu Jan  1 00:00:00 1970" }))
    const r = await winvm("pause", "-i", "t")
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(
      `winvm's service for "t" ended before pause finished`,
    )
  }, 30_000)

  it("kill from the CLI itself when the service takes the kill but never answers", async () => {
    await replace(async () => {
      await new Promise(() => undefined)
      return new Response(null)
    })
    const r = await winvm("kill", "-i", "t")
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('killed instance "t"\n')
    expect(await qemu.proc.exited).not.toBe(0)
  }, 30_000)
})

describe("reboot", () => {
  const order = (): readonly string[] =>
    readSince("t", START).entries.flatMap((e) =>
      e.kind === "qmp" && e.event === "RESET"
        ? ["RESET"]
        : e.kind === "op" && e.phase === "end"
          ? [`end ${e.operation}`]
          : [],
    )

  it("counts the restart only once QEMU says Windows reset", async () => {
    guest.resetDelayMs = 1500
    expect((await winvm("reboot", "-i", "t")).code).toBe(0)
    expect(order()).toEqual(["RESET", "end reboot"])
  }, 30_000)

  const warnings = (): readonly string[] =>
    readSince("t", START).entries.flatMap((e) =>
      e.kind === "warning" ? [e.what] : [],
    )

  it("counts a restart the record never saw as a restart, and says so in the record", async () => {
    guest.resets = false
    expect(await winvm("reboot", "-i", "t", "--timeout", "4")).toEqual({
      code: 0,
      stdout: 'rebooting\ninstance "t" rebooted in 4 s\n',
      stderr: "",
    })
    expect(warnings()).toEqual(["reboot without RESET"])
  }, 30_000)

  it("never takes a reset recorded before it asked Windows to restart for this one", async () => {
    guest.resets = false
    guest.staleResetOnStatus = true
    expect((await winvm("reboot", "-i", "t", "--timeout", "2")).code).toBe(0)
    expect(warnings()).toEqual(["reboot without RESET"])
  }, 30_000)

  it("stops waiting, and says so, when QEMU exits while Windows restarts", async () => {
    guest.bootDelayMs = 60_000
    const r = launch("reboot", "-i", "t", "--timeout", "30")
    await until(() => r.stdout().includes("rebooting"))
    const t0 = Date.now()
    await releasePidfiles()
    expect(await r.done).toEqual({
      code: 1,
      stdout: "rebooting\n",
      stderr:
        '::error::QEMU exited while Windows restarted, so "t" is no longer running — `winvm start -i t`\n',
    })
    expect(Date.now() - t0).toBeLessThan(5000)
  }, 40_000)
})
