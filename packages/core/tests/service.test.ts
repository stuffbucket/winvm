import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { QmpChannel } from "../src/broker"
import * as monitor from "../src/monitor"
import { PACKAGE_DIR, pathsFor, type Paths } from "../src/paths"
import * as qga from "../src/qga"
import { qemuArgs } from "../src/qemu"
import * as qmp from "../src/qmp"
import { buildIdentity } from "../src/identity"
import {
  dropServiceRecord,
  ensureService,
  keepService,
  readService,
  runService,
  serviceFreshness,
  stopService,
  type ServiceHandle,
  type ServiceInfo,
} from "../src/service"
import { FakeAgent } from "./fakes/agent"
import { FakeQmp } from "./fakes/qmp"

const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

let home = ""
let savedHome: string | undefined
let p: Paths
let fake: FakeQmp
let agent: FakeAgent
let svc: ServiceHandle | null = null

beforeEach(async () => {
  savedHome = process.env["WINVM_HOME"]
  home = mkdtempSync(resolve(tmpdir(), "winvm-svc-"))
  process.env["WINVM_HOME"] = home
  p = pathsFor("t")
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.pid, `${String(process.pid)}\n`)
  fake = new FakeQmp(p.qmpQemu)
  await fake.listen()
  agent = new FakeAgent(p.qgaQemu)
  await agent.listen()
})

afterEach(async () => {
  await svc?.stop()
  svc = null
  await fake.close().catch(() => undefined)
  await agent.close().catch(() => undefined)
  if (savedHome === undefined) delete process.env["WINVM_HOME"]
  else process.env["WINVM_HOME"] = savedHome
  rmSync(home, { recursive: true, force: true })
})

const lastEvent = (): Record<string, unknown> => {
  const lines = readFileSync(p.events, "utf8").trim().split("\n")
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>
}

/**
 * The record as written. These tests run the service in this very process,
 * which readService rightly never takes for a service (its command line is
 * `bun test`), so they read what it claimed directly.
 */
const recorded = (): ServiceInfo | null => {
  try {
    return JSON.parse(readFileSync(p.service, "utf8")) as ServiceInfo
  } catch {
    return null
  }
}

describe("the service", () => {
  it("serves the instance's sockets and records itself", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    expect(await qmp.status(p.qmp)).toBe("running")
    const info = recorded()
    expect(info?.pid).toBe(process.pid)
    expect(statSync(p.service).mode & 0o777).toBe(0o600)
    expect(info?.build).toBe(buildIdentity())
    expect(lastEvent()).toMatchObject({ instance: "t", kind: "service", what: "started" })
  })

  it("records QMP events as state events, on disk and on the stream", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    const res = await fetch("http://localhost/events", { unix: p.control })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await qmp.status(p.qmp)
    fake.emit({ event: "STOP", timestamp: { seconds: 1, microseconds: 0 } })
    let text = ""
    const dec = new TextDecoder()
    while (!text.includes('"state"')) text += dec.decode((await reader.read()).value)
    await reader.cancel()
    expect(text).toContain('"state":"paused"')
    expect(lastEvent()).toMatchObject({ kind: "state", state: "paused" })
  })

  it("keeps a quiet stream open past Bun's default idle timeout", async () => {
    svc = await runService("t", { exitAfterMs: 30_000, checkMs: 50, heartbeatMs: 60_000 })
    const res = await fetch("http://localhost/events", { unix: p.control })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await sleep(14_000)
    await qmp.status(p.qmp)
    fake.emit({ event: "STOP", timestamp: { seconds: 1, microseconds: 0 } })
    let text = ""
    const dec = new TextDecoder()
    while (!text.includes('"state"')) {
      const r = await reader.read()
      if (r.done) break
      text += dec.decode(r.value)
    }
    await reader.cancel().catch(() => undefined)
    expect(text).toContain('"state":"paused"')
  }, 25_000)

  it("drops a subscriber that went away", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50, heartbeatMs: 50 })
    const ac = new AbortController()
    const res = await fetch("http://localhost/events", { unix: p.control, signal: ac.signal })
    await (res.body as ReadableStream<Uint8Array>).getReader().read()
    expect(svc.subscribers()).toBe(1)
    ac.abort()
    await sleep(300)
    expect(svc.subscribers()).toBe(0)
  })

  it("answers on the instance's control socket, which only its owner can open", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    expect(statSync(p.control).mode & 0o777).toBe(0o600)
    const res = await fetch("http://localhost/status", { unix: p.control })
    expect(((await res.json()) as { qemuPid: number }).qemuPid).toBe(process.pid)
    expect(recorded()).not.toHaveProperty("port")
    expect(recorded()).not.toHaveProperty("token")
  })

  it("survives QEMU being replaced, and stops once QEMU is gone for good", async () => {
    svc = await runService("t", { exitAfterMs: 300, checkMs: 50 })
    expect(await qmp.status(p.qmp)).toBe("running")
    await fake.close()
    await sleep(300)
    fake = new FakeQmp(p.qmpQemu)
    await fake.listen()
    expect(await qmp.status(p.qmp)).toBe("running")
    rmSync(p.pid)
    await svc.done
    svc = null
    expect(existsSync(p.service)).toBe(false)
    expect(existsSync(p.qmp)).toBe(false)
    expect(existsSync(p.qga)).toBe(false)
    expect(existsSync(p.control)).toBe(false)
    expect(lastEvent()).toMatchObject({ kind: "service", what: "stopped" })
  })

  it("waits out a load: QEMU gone but the save lock held by a live pid", async () => {
    svc = await runService("t", { exitAfterMs: 200, checkMs: 50 })
    const lockDir = resolve(home, "saves", "t")
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(resolve(lockDir, ".lock"), String(process.pid))
    rmSync(p.pid)
    await sleep(600)
    expect(recorded()?.pid).toBe(process.pid)
    expect(existsSync(p.qmp)).toBe(true)
  })
})

describe("one service per instance", () => {
  it("refuses to start while another service holds the instance, and leaves it working", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    await expect(runService("t", { exitAfterMs: 5000, checkMs: 50 })).rejects.toThrow(`holds instance "t"`)
    expect(recorded()?.pid).toBe(process.pid)
    expect(await qmp.status(p.qmp)).toBe("running")
    expect((await fetch("http://localhost/status", { unix: p.control })).status).toBe(200)
  })

  it("takes over the record of a service that has gone", async () => {
    const gone = Bun.spawn(["true"])
    await gone.exited
    writeFileSync(p.service, JSON.stringify({ pid: gone.pid, cli: "", version: "", startedAt: "" }))
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(recorded()?.pid).toBe(process.pid)
  })

  it("stops when its record names another service, and leaves that service's sockets", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    const newer = new QmpChannel({ listen: p.qmp, upstream: resolve(home, "nowhere.sock") })
    await newer.start()
    writeFileSync(p.service, JSON.stringify({ pid: 1, cli: "", version: "", startedAt: "" }))
    await svc.done
    svc = null
    expect(existsSync(p.qmp)).toBe(true)
    await newer.stop()
  })

  it("is kept alive by a launch that just reused it", async () => {
    svc = await runService("t", { exitAfterMs: 300, checkMs: 50 })
    rmSync(p.pid)
    await sleep(200)
    keepService(p)
    await sleep(250)
    expect(recorded()?.pid).toBe(process.pid)
    await svc.done
    svc = null
  })

  it("does not take a live process that is not this instance's service for one", () => {
    const other = Bun.spawn(["sleep", "30"])
    writeFileSync(p.service, JSON.stringify({ pid: other.pid, cli: "", version: "", startedAt: "" }))
    expect(readService(p)).toBeNull()
    other.kill()
  })

  it("never takes this very process for a service, so a stale record naming it cannot make it signal itself", () => {
    writeFileSync(p.service, JSON.stringify({ pid: process.pid, cli: "", version: "", startedAt: "" }))
    expect(readService(p)).toBeNull()
    let t = 0
    const kills: string[] = []
    stopService(p, {
      kill: (_pid, sig) => void kills.push(sig),
      now: () => t,
      sleep: (ms) => {
        t += ms
      },
    })
    expect(kills).toEqual([])
  })

  it("drops a rejected record only while it is still that record, never a service's fresh claim", () => {
    const rejected = JSON.stringify({ pid: 424_242, cli: "", version: "", startedAt: "" })
    const fresh = JSON.stringify({ pid: 424_243, cli: "", version: "", startedAt: "", build: "sha256:new" })
    writeFileSync(p.service, fresh)
    expect(dropServiceRecord(p, rejected)).toBe(false)
    expect(readFileSync(p.service, "utf8")).toBe(fresh)
    writeFileSync(p.service, rejected)
    expect(dropServiceRecord(p, rejected)).toBe(true)
    expect(existsSync(p.service)).toBe(false)
  })

  for (const [label, argv] of [
    ["an instance whose name starts with this one's", ["winvm", "serve", "-i", "tt"]],
    ["another instance named with --instance=", ["winvm", "serve", "--instance=other"]],
  ] as const) {
    it(`never takes the service of ${label} for this one's, nor signals it`, () => {
      const h = Bun.spawn([process.execPath, resolve(import.meta.dir, "fakes", "holder.ts"), ...argv], { stdout: "ignore", stderr: "ignore" })
      try {
        writeFileSync(p.service, JSON.stringify({ pid: h.pid, cli: "", version: "", startedAt: "" }))
        expect(readService(p)).toBeNull()
        const kills: string[] = []
        stopService(p, { kill: (_pid, sig) => void kills.push(sig) })
        expect(kills).toEqual([])
      } finally {
        h.kill()
      }
    })
  }
})

describe("which process is the default instance's service", () => {
  const holder = resolve(import.meta.dir, "fakes", "holder.ts")
  const d = (): Paths => {
    const dp = pathsFor("default")
    mkdirSync(dp.dir, { recursive: true })
    return dp
  }

  // A pid reused by any of these must never be signalled as a winvm service.
  for (const argv of [["ollama", "serve"], ["hugo", "serve"], ["node", "server.js", "serve"], ["winvm", "serve"], ["evilwinvm", "serve", "-i", "default"], ["ollama", "serve", "-i", "default"]]) {
    it(`is never \`${argv.join(" ")}\``, () => {
      const dp = d()
      const h = Bun.spawn([process.execPath, holder, ...argv], { stdout: "ignore", stderr: "ignore" })
      try {
        writeFileSync(dp.service, JSON.stringify({ pid: h.pid, cli: "", version: "", startedAt: "" }))
        expect(readService(dp)).toBeNull()
        const kills: string[] = []
        stopService(dp, { kill: (_pid, sig) => void kills.push(sig) })
        expect(kills).toEqual([])
      } finally {
        h.kill()
      }
    })
  }

  // What winvm spawns: from source, an installed CLI, and Tauri's target-suffixed sidecar.
  for (const argv of [
    ["/repo/apps/cli/src/winvm.ts", "serve", "-i", "default"],
    ["/Applications/winvm.app/Contents/MacOS/winvm", "serve", "--instance=default"],
    ["/Applications/winvm.app/Contents/MacOS/winvm-aarch64-apple-darwin", "serve", "-i", "default"],
  ]) {
    it(`is \`${argv.join(" ")}\``, () => {
      const dp = d()
      const h = Bun.spawn([process.execPath, holder, ...argv], { stdout: "ignore", stderr: "ignore" })
      try {
        writeFileSync(dp.service, JSON.stringify({ pid: h.pid, cli: "", version: "", startedAt: "" }))
        expect(readService(dp)?.pid).toBe(h.pid)
      } finally {
        h.kill()
      }
    })
  }
})

describe("one service per instance, continued", () => {

  it("asks for the guest's port without waiting behind a QMP caller", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    const held = monitor.withQmp(p.qmp, async () => await sleep(1500), 3000)
    await sleep(100)
    const t0 = Date.now()
    expect(await qga.call(p.qga, { execute: "guest-ping" }, 1000)).toEqual({ return: {} })
    expect(Date.now() - t0).toBeLessThan(800)
    await held
  })

  it("never connects to the agent after the guest closed its port, though QEMU sends no event for it", async () => {
    svc = await runService("t", { exitAfterMs: 5000, checkMs: 50 })
    expect(await qga.call(p.qga, { execute: "guest-ping" }, 1000)).toEqual({ return: {} })
    const before = agent.connections
    const open = fake.handler
    fake.handler = (cmd) =>
      cmd["execute"] === "query-chardev" ? { return: [{ label: "qga0", "frontend-open": false }] } : open(cmd)
    await expect(qga.call(p.qga, { execute: "guest-ping" }, 500)).rejects.toThrow("timed out")
    expect(agent.connections).toBe(before)
  })
})

describe("starting the service", () => {
  const cli = resolve(PACKAGE_DIR, "..", "..", "apps", "cli", "src", "winvm.ts")
  let savedCli: string | undefined

  beforeEach(() => {
    savedCli = process.env["WINVM_CLI"]
    process.env["WINVM_CLI"] = cli
  })

  afterEach(() => {
    stopService(p)
    if (savedCli === undefined) delete process.env["WINVM_CLI"]
    else process.env["WINVM_CLI"] = savedCli
  })

  it("starts the service once, detached, and reuses it", async () => {
    const first = await ensureService("t", p)
    expect(first.pid).not.toBe(process.pid)
    expect(first.cli).toBe(cli)
    expect(existsSync(p.qmp) && existsSync(p.qga)).toBe(true)
    expect(await qmp.status(p.qmp)).toBe("running")
    expect((await fetch("http://localhost/status", { unix: p.control })).status).toBe(200)
    const again = await ensureService("t", p)
    expect(again.pid).toBe(first.pid)
    expect(first.build).toBe(buildIdentity())
  }, 30_000)

  it("stops it, and waits until it has gone", async () => {
    const info = await ensureService("t", p)
    stopService(p)
    expect(readService(p)).toBeNull()
    expect(spawnSync("ps", ["-o", "stat=", "-p", String(info.pid)], { encoding: "utf8" }).stdout.trim()).toMatch(/^(Z.*)?$/)
  }, 30_000)
})

/**
 * A stand-in service: a process of ours whose command line passes the service
 * check (` serve -i <name>`) without being one. A single process (fakes/holder.ts),
 * so killing it leaves no orphan behind.
 */
const fakeService = (name: string): ReturnType<typeof Bun.spawn> =>
  Bun.spawn([process.execPath, resolve(import.meta.dir, "fakes", "holder.ts"), "winvm", "serve", "-i", name], { stdout: "ignore", stderr: "ignore" })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("Z") === false
  } catch {
    return false
  }
}

describe("service generations", () => {
  const CLI = "/test/apps/cli/src/winvm.ts"
  const CURRENT = "sha256:current"
  let savedCli: string | undefined
  let control: ReturnType<typeof Bun.serve> | null = null
  const spawned: ReturnType<typeof Bun.spawn>[] = []

  const holder = (): ReturnType<typeof Bun.spawn> => {
    const h = fakeService("t")
    spawned.push(h)
    return h
  }
  const record = (pid: number, build: string | undefined, cli = CLI): void => {
    const info: ServiceInfo = { pid, cli, version: "0", startedAt: "", ...(build === undefined ? {} : { build }) }
    writeFileSync(p.service, JSON.stringify(info))
  }

  beforeEach(() => {
    savedCli = process.env["WINVM_CLI"]
    process.env["WINVM_CLI"] = CLI
    control = Bun.serve({ unix: p.control, fetch: () => new Response("ok") })
  })

  afterEach(async () => {
    await control?.stop(true)
    control = null
    for (const s of spawned.splice(0)) s.kill()
    if (savedCli === undefined) delete process.env["WINVM_CLI"]
    else process.env["WINVM_CLI"] = savedCli
  })

  it("classifies a record by its build: current, stale, or legacy when it has none", () => {
    const base = { pid: 1, cli: CLI, version: "0", startedAt: "" }
    expect(serviceFreshness({ ...base, build: CURRENT }, CURRENT)).toBe("current")
    expect(serviceFreshness({ ...base, build: "sha256:old" }, CURRENT)).toBe("stale")
    expect(serviceFreshness(base, CURRENT)).toBe("legacy")
    expect(serviceFreshness({ ...base, build: buildIdentity() })).toBe("current")
  })

  it("still reads a live legacy record: freshness is the caller's decision", () => {
    const h = holder()
    record(h.pid, undefined)
    expect(readService(p)?.pid).toBe(h.pid)
    expect(readService(p)?.build).toBeUndefined()
  })

  for (const [label, cli] of [["this CLI path", CLI], ["another CLI path", "/Applications/winvm.app/Contents/MacOS/winvm"]] as const) {
    it(`reuses a service of the current generation from ${label}`, async () => {
      const h = holder()
      record(h.pid, CURRENT, cli)
      const info = await ensureService("t", p, {
        current: CURRENT,
        start: () => {
          throw new Error("must not start a second service")
        },
      })
      expect(info.pid).toBe(h.pid)
      expect(alive(h.pid)).toBe(true)
    })
  }

  for (const [label, build] of [["another generation", "sha256:old"], ["no recorded generation", undefined]] as const) {
    it(`replaces a service with ${label}`, async () => {
      const old = holder()
      record(old.pid, build)
      let next: ReturnType<typeof Bun.spawn> | null = null
      const info = await ensureService("t", p, {
        current: CURRENT,
        start: () => {
          next = holder()
          record(next.pid, CURRENT)
        },
      })
      expect(next).not.toBeNull()
      expect(info.pid).toBe((next as unknown as { pid: number }).pid)
      expect(info.build).toBe(CURRENT)
      await sleep(50)
      expect(alive(old.pid)).toBe(false)
    })
  }

  it("does not call the replacement ready until its record carries the current build", async () => {
    const old = holder()
    record(old.pid, "sha256:old")
    await expect(
      ensureService("t", p, {
        current: CURRENT,
        timeoutMs: 400,
        // A replacement that answers, but that is still the old generation.
        start: () => record(holder().pid, "sha256:old"),
      }),
    ).rejects.toThrow("did not start")
  })

  it("never signals a pid that is not this instance's service, and drops the record", async () => {
    const stranger = Bun.spawn(["sleep", "20"])
    spawned.push(stranger)
    record(stranger.pid, "sha256:old")
    let started = 0
    await expect(ensureService("t", p, { current: CURRENT, timeoutMs: 300, start: () => void (started += 1) })).rejects.toThrow(
      "did not start",
    )
    expect(started).toBe(1)
    expect(alive(stranger.pid)).toBe(true)
    expect(existsSync(p.service)).toBe(false)
  })

  it("can be called again after a start that failed", async () => {
    await expect(ensureService("t", p, { current: CURRENT, timeoutMs: 200, start: () => undefined })).rejects.toThrow("did not start")
    const info = await ensureService("t", p, {
      current: CURRENT,
      start: () => record(holder().pid, CURRENT),
    })
    expect(info.build).toBe(CURRENT)
    const again = await ensureService("t", p, {
      current: CURRENT,
      start: () => {
        throw new Error("already running")
      },
    })
    expect(again.pid).toBe(info.pid)
  })
})

describe("stopping a service", () => {
  /** A fake clock and process table: no real wait, no real signal. */
  const run = (o: { readonly isService: (t: number) => boolean }): { kills: string[]; elapsed: number } => {
    writeFileSync(p.service, JSON.stringify({ pid: 424_242, cli: "", version: "", startedAt: "" }))
    let t = 0
    const kills: string[] = []
    stopService(p, {
      kill: (_pid, sig) => void kills.push(sig),
      now: () => t,
      sleep: (ms) => {
        t += ms
      },
      running: () => true,
      isService: () => o.isService(t),
    })
    return { kills, elapsed: t }
  }

  it("kills a service that is still running 5 s after SIGTERM", () => {
    const r = run({ isService: () => true })
    expect(r.kills).toEqual(["SIGTERM", "SIGKILL"])
    expect(r.elapsed).toBeGreaterThanOrEqual(5000)
    expect(existsSync(p.service)).toBe(false)
  })

  it("re-checks the pid is still this instance's service just before SIGKILL", () => {
    // It ignores SIGTERM for its 5 s, and by then the pid belongs to something else.
    const r = run({ isService: (t) => t < 5000 })
    expect(r.kills).toEqual(["SIGTERM"])
  })

  it("signals nothing when the record names a process that is not its service", () => {
    expect(run({ isService: () => false }).kills).toEqual([])
  })
})

describe("QEMU's command line", () => {
  it("hands QEMU the private sockets", () => {
    const args = qemuArgs("t", p, { image: "win11-arm64", vnc: 9, created: "" }, {
      installMedia: false,
      ephemeral: true,
      virtioBoot: false,
    }).join(" ")
    expect(args).toContain(`unix:${p.qmpQemu},server=on,wait=off`)
    expect(args).toContain(`socket,path=${p.qgaQemu},`)
    expect(args).not.toContain(`unix:${p.qmp},`)
    expect(args).not.toContain(`path=${p.qga},`)
  })
})
