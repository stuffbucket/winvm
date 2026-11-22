import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { readSince, START } from "../src/eventlog"
import {
  ensureCurrent,
  ManagementError,
  needsRepair,
  type ReconcileOptions,
  serviceUp,
} from "../src/lifecycle"
import { InstanceBusy } from "../src/operation"
import { PACKAGE_DIR, type Paths, pathsFor } from "../src/paths"
import { processStart } from "../src/proc"
import { reconcileNote, shouldReconcileVerb } from "../src/reconcile"
import {
  ensureService,
  readService,
  type ServiceInfo,
  stopService,
} from "../src/servicectl"
import { readWatchState, watchPathsFor } from "../src/watch"
import { FakeAgent } from "./fakes/agent"
import { lockPidfile, releasePidfiles } from "./fakes/pidfile"
import { FakeQmp } from "./fakes/qmp"

const HOLDER = resolve(import.meta.dir, "fakes", "holder.ts")
const CLI = "/test/apps/cli/src/winvm.ts"
const CURRENT = "sha256:current"
const OLD = "sha256:old"

type Proc = ReturnType<typeof Bun.spawn>

let home = ""
let p: Paths
let saved: Record<string, string | undefined> = {}
let control: ReturnType<typeof Bun.serve> | null = null
let qemu: Proc
const spawned: Proc[] = []

const signals: { readonly pid: number; readonly sig: string }[] = []
const realKill = process.kill.bind(process)

const sleep = async (ms: number): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

const live = (pid: number): boolean => {
  try {
    realKill(pid, 0)
  } catch {
    return false
  }
  return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  })
    .stdout.trim()
    .startsWith("Z")
}

async function hold(...args: string[]): Promise<Proc> {
  const h = Bun.spawn([process.execPath, HOLDER, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  })
  spawned.push(h)
  const reader = (h.stdout as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  reader.releaseLock()
  return h
}

function holdNow(...args: string[]): Proc {
  const h = Bun.spawn([process.execPath, HOLDER, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  })
  spawned.push(h)
  return h
}

const recordService = (
  pid: number,
  build: string | undefined,
  cli = CLI,
): void => {
  const info: ServiceInfo = {
    pid,
    cli,
    version: "0",
    startedAt: new Date().toISOString(),
    ...(build === undefined ? {} : { build }),
  }
  writeFileSync(p.service, JSON.stringify(info))
}

async function service(build: string | undefined, cli = CLI): Promise<Proc> {
  const h = await hold("winvm", "serve", "-i", "t")
  recordService(h.pid, build, cli)
  return h
}

function seams(o: Partial<ReconcileOptions> = {}): {
  starts: { service: number }
  options: ReconcileOptions
} {
  const starts = { service: 0 }
  return {
    starts,
    options: {
      current: CURRENT,
      serviceTimeoutMs: 3000,
      startService: () => {
        starts.service += 1
        recordService(holdNow("winvm", "serve", "-i", "t").pid, CURRENT)
      },
      ...o,
    },
  }
}

function expectQemuUntouched(): void {
  expect(live(qemu.pid)).toBe(true)
  expect(signals.filter((s) => s.pid === qemu.pid)).toEqual([])
  expect(readFileSync(p.pid, "utf8").trim()).toBe(String(qemu.pid))
}

const lease = (pid: number, operation: string, automatic = false): void => {
  writeFileSync(
    p.lease,
    JSON.stringify({
      operation,
      id: `lease-${String(pid)}`,
      pid,
      pidStart: processStart(pid),
      startedAt: "2026-11-14T00:00:00.000Z",
      instance: "t",
      automatic,
    }),
  )
}

beforeEach(async () => {
  saved = Object.fromEntries(
    ["WINVM_HOME", "WINVM_CLI", "WINVM_NO_RECONCILE", "WINVM_KEEPER"].map(
      (k) => [k, process.env[k]],
    ),
  )
  home = mkdtempSync(resolve(tmpdir(), "winvm-lc-"))
  process.env.WINVM_HOME = home
  process.env.WINVM_CLI = CLI
  process.env.WINVM_KEEPER = ""
  delete process.env.WINVM_NO_RECONCILE
  p = pathsFor("t")
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify({ image: "x", vnc: 9, created: "" }))
  writeFileSync(p.qmpQemu, "")
  qemu = (await lockPidfile(p.pid, "qemu-stand-in")).proc
  control = Bun.serve({ unix: p.control, fetch: () => new Response("ok") })
  signals.length = 0
  process.kill = (pid: number, sig?: string | number): true => {
    if (sig !== 0) signals.push({ pid, sig: String(sig ?? "SIGTERM") })
    return realKill(pid, sig)
  }
})

afterEach(async () => {
  process.kill = realKill
  await control?.stop(true)
  control = null
  for (const s of spawned.splice(0)) s.kill("SIGKILL")
  await releasePidfiles()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

describe("handing the control service over", () => {
  it("does nothing while QEMU is not running", async () => {
    rmSync(p.pid)
    const old = await service(OLD)
    const s = seams()
    expect(await ensureCurrent("t", p, s.options)).toEqual({
      changed: false,
      servicePid: null,
    })
    expect(s.starts).toEqual({ service: 0 })
    expect(live(old.pid)).toBe(true)
    expect(signals).toEqual([])
  })

  it("leaves a current service alone", async () => {
    const svc = await service(CURRENT)
    const s = seams()
    expect(await ensureCurrent("t", p, s.options)).toEqual({
      changed: false,
      servicePid: svc.pid,
    })
    expect(s.starts).toEqual({ service: 0 })
    expect(signals).toEqual([])
    expectQemuUntouched()
  })

  it("replaces a stale one under the instance's lease, so no autosave can start under it", async () => {
    const svc = await service(OLD)
    const during: unknown[] = []
    const s = seams()
    const base = s.options
    const r = await ensureCurrent("t", p, {
      ...base,
      startService: () => {
        const held = existsSync(p.lease)
          ? (JSON.parse(readFileSync(p.lease, "utf8")) as Record<
              string,
              unknown
            >)
          : null
        during.push(
          held === null
            ? "no lease"
            : {
                operation: held.operation,
                pid: held.pid,
                automatic: held.automatic,
              },
        )
        base.startService?.()
      },
    })
    expect(during).toEqual([
      { operation: "reconcile", pid: process.pid, automatic: true },
    ])
    expect(r.changed).toBe(true)
    expect(live(svc.pid)).toBe(false)
    expect(readService(p)?.build).toBe(CURRENT)
    expect(r.servicePid).toBe(readService(p)?.pid ?? -1)
    expect(existsSync(p.lease)).toBe(false)
    expectQemuUntouched()
  })

  it("rotates a legacy record, which carries no build", async () => {
    const svc = await service(undefined)
    const s = seams()
    expect((await ensureCurrent("t", p, s.options)).changed).toBe(true)
    expect(s.starts).toEqual({ service: 1 })
    expect(live(svc.pid)).toBe(false)
    expectQemuUntouched()
  })

  it("starts a service for a running QEMU that has lost its own", async () => {
    const s = seams()
    const r = await ensureCurrent("t", p, s.options)
    expect(s.starts).toEqual({ service: 1 })
    expect(r.servicePid).toBe(readService(p)?.pid ?? -1)
    expectQemuUntouched()
  })

  it("leaves a QEMU started before the control service existed without one", async () => {
    rmSync(p.qmpQemu)
    const s = seams()
    expect(await ensureCurrent("t", p, s.options)).toEqual({
      changed: false,
      servicePid: null,
    })
    expect(s.starts).toEqual({ service: 0 })
  })

  for (const [who, operation, automatic] of [
    ["a person's save", "save", false],
    ["a person's load", "load", false],
    ["a person's reboot", "reboot", false],
    ["winvm's own autosave", "save", true],
  ] as const) {
    it(`is put off at once while ${who} holds the instance, and changes nothing`, async () => {
      const svc = await service(OLD)
      const holder = await hold("winvm", operation, "-i", "t")
      lease(holder.pid, operation, automatic)
      const s = seams()
      const t0 = Date.now()
      expect(await ensureCurrent("t", p, s.options)).toEqual({
        changed: false,
        servicePid: svc.pid,
        deferred: "busy",
      })
      expect(Date.now() - t0).toBeLessThan(2000)
      expect(s.starts).toEqual({ service: 0 })
      expect(signals).toEqual([])
      holder.kill("SIGKILL")
      await holder.exited
      expect((await ensureCurrent("t", p, s.options)).changed).toBe(true)
      expect(s.starts).toEqual({ service: 1 })
      expectQemuUntouched()
    })
  }

  it("replaces once when two run at the same moment", async () => {
    await service(OLD)
    const s = seams()
    const base = s.options
    const slow: ReconcileOptions = {
      ...base,
      startService: () => {
        Bun.sleepSync(200)
        base.startService?.()
      },
    }
    const both = await Promise.all([
      ensureCurrent("t", p, slow),
      ensureCurrent("t", p, slow),
    ])
    expect(s.starts).toEqual({ service: 1 })
    expect(both.filter((r) => r.changed)).toHaveLength(1)
    expectQemuUntouched()
  })
})

describe("a handover that fails", () => {
  it("says so, keeps QEMU, and recovers on the next run", async () => {
    const svc = await service(OLD)
    const broken = seams({
      serviceTimeoutMs: 300,
      startService: () => undefined,
    })
    let error: unknown
    try {
      await ensureCurrent("t", p, broken.options)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ManagementError)
    expect((error as ManagementError).message).toContain("still running")
    expect((error as ManagementError).message).toContain(
      resolve(p.dir, "service.log"),
    )
    expect(
      readSince("t", START)
        .entries.filter((e) => e.kind === "op" && e.phase === "end")
        .at(-1),
    ).toMatchObject({
      operation: "reconcile",
      ok: false,
      error: expect.stringContaining("did not start") as string,
    })
    expect(live(svc.pid)).toBe(false)
    expect(readService(p)).toBeNull()
    expect(existsSync(p.lease)).toBe(false)
    expectQemuUntouched()

    const fixed = seams()
    const r = await ensureCurrent("t", p, fixed.options)
    expect(r.changed).toBe(true)
    expect(fixed.starts.service).toBe(1)
    expect(readService(p)?.build).toBe(CURRENT)
    expectQemuUntouched()
  })

  it("wraps a launch that throws", async () => {
    await service(OLD)
    const s = seams({
      startService: () => {
        throw new Error("spawn ENOENT")
      },
    })
    await expect(ensureCurrent("t", p, s.options)).rejects.toBeInstanceOf(
      ManagementError,
    )
    expectQemuUntouched()
  })
})

describe("generations from another install", () => {
  const VIEWER = "/Applications/WinVM.app/Contents/MacOS/winvm"
  const VIEWER_BUILD = "sha256:viewer"

  it("reuses a service of this build started from another path", async () => {
    const svc = await service(CURRENT, VIEWER)
    const s = seams()
    expect(await ensureCurrent("t", p, s.options)).toEqual({
      changed: false,
      servicePid: svc.pid,
    })
    expect(s.starts).toEqual({ service: 0 })
    expect(signals).toEqual([])
  })

  it("rotates a service of another build started from this same path (an update in place)", async () => {
    const svc = await service(OLD, CLI)
    const s = seams()
    await ensureCurrent("t", p, s.options)
    expect(s.starts).toEqual({ service: 1 })
    expect(live(svc.pid)).toBe(false)
  })

  it("rotates a legacy record, with no build, whatever path started it", async () => {
    const svc = await service(undefined, VIEWER)
    const s = seams()
    await ensureCurrent("t", p, s.options)
    expect(s.starts).toEqual({ service: 1 })
    expect(live(svc.pid)).toBe(false)
  })

  it("leaves another install's live service alone, as each install asks in turn", async () => {
    const svc = await service(VIEWER_BUILD, VIEWER)
    const source = seams()
    const viewer = seams({ current: VIEWER_BUILD })
    for (let i = 0; i < 2; i += 1) {
      process.env.WINVM_CLI = CLI
      expect(await ensureCurrent("t", p, source.options)).toEqual({
        changed: false,
        servicePid: svc.pid,
      })
      process.env.WINVM_CLI = VIEWER
      expect(await ensureCurrent("t", p, viewer.options)).toEqual({
        changed: false,
        servicePid: svc.pid,
      })
    }
    expect(source.starts).toEqual({ service: 0 })
    expect(viewer.starts).toEqual({ service: 0 })
    expect(signals).toEqual([])
    expect(live(svc.pid)).toBe(true)
  })

  it("says a repair is due for a stale or missing service, and changes nothing by saying so", async () => {
    expect(needsRepair("t", p, CURRENT)).toBe(true)
    const svc = await service(OLD)
    expect(needsRepair("t", p, CURRENT)).toBe(true)
    recordService(svc.pid, CURRENT)
    expect(needsRepair("t", p, CURRENT)).toBe(false)
    recordService(svc.pid, VIEWER_BUILD, VIEWER)
    expect(needsRepair("t", p, CURRENT)).toBe(false)
    expect(signals).toEqual([])
  })
})

describe("no recursion", () => {
  it("reconciles before instance read and management verbs", () => {
    for (const verb of [
      "info",
      "exec",
      "put",
      "get",
      "terminal",
      "screenshot",
      "save",
      "snapshot",
      "config",
      "share",
      "watch",
    ]) {
      expect(shouldReconcileVerb(verb, {})).toBe(true)
    }
  })

  it("never inside the service, nor for teardown, build or test verbs, nor for status, which only reads", () => {
    for (const verb of [
      "status",
      "events",
      "reconcile",
      "serve",
      "stop",
      "kill",
      "destroy",
      "reset",
      "stow",
      "build",
      "setup",
      "adopt",
      "create",
      "run",
      "test",
      "rmi",
      "prune",
      "ls",
      "doctor",
      "help",
    ]) {
      expect(shouldReconcileVerb(verb, {})).toBe(false)
    }
  })

  it("never in a process started with WINVM_NO_RECONCILE=1", () => {
    expect(shouldReconcileVerb("info", { WINVM_NO_RECONCILE: "1" })).toBe(false)
    expect(shouldReconcileVerb("info", { WINVM_NO_RECONCILE: "" })).toBe(true)
  })
  it("marks the detached service it starts", async () => {
    const out = resolve(home, "spawned")
    const cli = resolve(home, "fake-cli.ts")
    writeFileSync(
      cli,
      `import { writeFileSync } from "node:fs"\n` +
        `writeFileSync(${JSON.stringify(out)} + "." + process.argv[2], String(process.env["WINVM_NO_RECONCILE"] ?? "unset"))\n`,
    )
    process.env.WINVM_CLI = cli
    const deadline = Date.now() + 10_000
    await expect(ensureService("t", p, { timeoutMs: 200 })).rejects.toThrow()
    while (Date.now() < deadline && !existsSync(`${out}.serve`)) await sleep(50)
    expect(readFileSync(`${out}.serve`, "utf8")).toBe("1")
  }, 30_000)
})

describe("the CLI", () => {
  const cli = resolve(PACKAGE_DIR, "..", "..", "apps", "cli", "src", "winvm.ts")
  let fake: FakeQmp
  let agent: FakeAgent

  beforeEach(async () => {
    rmSync(p.qmpQemu, { force: true })
    fake = new FakeQmp(p.qmpQemu)
    await fake.listen()
    agent = new FakeAgent(p.qgaQemu)
    await agent.listen()
    await control?.stop(true)
    control = null
    rmSync(p.control, { force: true })
  })

  afterEach(async () => {
    stopService(p)
    await fake.close().catch(() => undefined)
    await agent.close().catch(() => undefined)
  })

  const env = (
    extra: Record<string, string>,
  ): Record<string, string | undefined> => {
    const e: Record<string, string | undefined> = {
      ...process.env,
      WINVM_HOME: home,
      WINVM_BUILD_ID: "sha256:cli-test",
      ...extra,
    }
    for (const k of ["WINVM_CLI", "WINVM_INSTANCE", "WINVM_NO_RECONCILE"])
      if (!(k in extra)) delete e[k]
    return e
  }

  const winvm = (
    verb: readonly string[],
    extra: Record<string, string> = {},
    timeout = 60_000,
  ): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [cli, ...verb], {
      env: env(extra),
      encoding: "utf8",
      timeout,
    })

  const status = (
    extra: Record<string, string> = {},
    instance: readonly string[] = ["-i", "t"],
  ): ReturnType<typeof spawnSync> =>
    winvm(["status", "--json", ...instance], extra)

  const reconcile = (
    extra: Record<string, string> = {},
    instance: readonly string[] = ["-i", "t"],
  ): ReturnType<typeof spawnSync> => winvm(["reconcile", ...instance], extra)

  async function staleFromSameCli(): Promise<Proc> {
    const h = await hold("winvm", "serve", "-i", "t")
    const info: ServiceInfo = {
      pid: h.pid,
      cli,
      version: "0",
      startedAt: new Date().toISOString(),
      build: OLD,
    }
    writeFileSync(p.service, JSON.stringify(info))
    return h
  }

  function tree(): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = resolve(dir, name)
        const s = lstatSync(path)
        if (s.isDirectory()) {
          out[path] = "dir"
          walk(path)
        } else if (s.isFile())
          out[path] =
            `${String(s.mtimeMs)}:${readFileSync(path).toString("base64")}`
        else out[path] = "other"
      }
    }
    walk(home)
    return out
  }

  it("status --json changes nothing, though the service is stale", async () => {
    const old = await staleFromSameCli()
    const before = tree()
    const one = status()
    const all = status({}, [])
    expect(one.status).toBe(0)
    expect(all.status).toBe(0)
    expect(tree()).toEqual(before)
    expect(live(old.pid)).toBe(true)
    expect(readService(p)?.build).toBe(OLD)
    expect(live(qemu.pid)).toBe(true)
    expect(JSON.parse(String(one.stdout))).toMatchObject({
      name: "t",
      management: "repair",
    })
    expect(String(one.stderr)).not.toContain("now runs this build")
  }, 60_000)

  it("status names the repair it leaves to reconcile, and reconcile repairs a stale service and leaves QEMU running", async () => {
    const old = await staleFromSameCli()
    expect(String(winvm(["status", "-i", "t"]).stdout)).toContain(
      "winvm reconcile -i t",
    )
    const r = reconcile()
    expect(r.status).toBe(0)
    expect(String(r.stderr)).toContain("now runs this build")
    expect(live(old.pid)).toBe(false)
    expect(readService(p)?.build).toBe("sha256:cli-test")
    expect(readService(p)?.cli).toBe(cli)
    expect(live(qemu.pid)).toBe(true)
    expect(JSON.parse(String(status().stdout))).toMatchObject({
      name: "t",
      management: "current",
    })
  }, 60_000)

  it("start of a running instance hands a stale service over before it sends the start", async () => {
    await control?.stop(true)
    control = null
    rmSync(p.control, { force: true })
    const old = Bun.spawn([process.execPath, cli, "serve", "-i", "t"], {
      env: env({ WINVM_BUILD_ID: OLD, WINVM_CLI: cli }),
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      const end = Date.now() + 15_000
      while (readService(p)?.build !== OLD) {
        if (Date.now() > end) throw new Error("the old service never claimed")
        await Bun.sleep(50)
      }
      winvm(["start", "-i", "t", "--no-watch"])
      expect(readService(p)?.build).toBe("sha256:cli-test")
      expect(live(old.pid)).toBe(false)
      expect(live(qemu.pid)).toBe(true)
    } finally {
      old.kill("SIGKILL")
      await old.exited
    }
  }, 60_000)

  it("does not reconcile with WINVM_NO_RECONCILE=1", async () => {
    const old = await staleFromSameCli()
    expect(reconcile({ WINVM_NO_RECONCILE: "1" }).status).toBe(0)
    expect(live(old.pid)).toBe(true)
    expect(readService(p)?.build).toBe(OLD)
  }, 60_000)

  it("reconcile with no -i repairs every instance, though one could not be repaired", async () => {
    const a = pathsFor("a")
    mkdirSync(a.dir, { recursive: true })
    writeFileSync(a.meta, JSON.stringify({ image: "x", vnc: 8, created: "" }))
    await lockPidfile(a.pid, "qemu-stand-in-a")
    writeFileSync(a.qmpQemu, "")
    mkdirSync(resolve(a.dir, "service.log"))
    const old = await staleFromSameCli()
    const r = reconcile({}, [])
    expect(r.status).toBe(1)
    expect(String(r.stderr)).toContain(
      `::error::could not start a current control service for "a"`,
    )
    expect(live(old.pid)).toBe(false)
    expect(readService(p)?.build).toBe("sha256:cli-test")
    expect(live(qemu.pid)).toBe(true)
  }, 60_000)

  it("hands a stale service over, and the new one stops an older winvm's watcher and takes its duties once it has gone", async () => {
    const got = resolve(home, "legacy-watcher-signals")
    const w = await hold(
      "--log-signals",
      got,
      "--linger",
      "600",
      "winvm",
      "watch",
      "-i",
      "t",
    )
    writeFileSync(resolve(p.dir, "watch.pid"), `${String(w.pid)}\n`)
    writeFileSync(
      watchPathsFor("t").state,
      JSON.stringify({ pid: w.pid, build: OLD, state: "watching" }),
    )
    const old = await staleFromSameCli()
    expect(reconcile().status).toBe(0)
    const fresh = readService(p)
    expect(fresh?.build).toBe("sha256:cli-test")
    expect(live(old.pid)).toBe(false)
    const end = Date.now() + 20_000
    while (readWatchState("t")?.pid !== fresh?.pid) {
      if (Date.now() > end) throw new Error("the service never took over")
      await sleep(50)
    }
    expect(readFileSync(got, "utf8")).toBe("SIGTERM\n")
    expect(live(w.pid)).toBe(false)
    expect(existsSync(resolve(p.dir, "watch.pid"))).toBe(false)
    expect(readWatchState("t")).toMatchObject({ state: "watching" })
    expect(
      readSince("t", START).entries.filter(
        (e) => e.kind === "service" && e.what === "watcher taken over",
      ),
    ).toMatchObject([{ pid: w.pid }])
    expect(live(qemu.pid)).toBe(true)
  }, 60_000)
})

describe("bringing a service up for a command", () => {
  const realCli = resolve(
    PACKAGE_DIR,
    "..",
    "..",
    "apps",
    "cli",
    "src",
    "winvm.ts",
  )
  const answers = async (q: Paths): Promise<boolean> => {
    try {
      return (await fetch("http://localhost/status", { unix: q.control })).ok
    } catch {
      return false
    }
  }

  beforeEach(async () => {
    process.env.WINVM_CLI = realCli
    process.env.WINVM_KEEPER = process.env.WINVM_FAKE_KEEPER ?? ""
    await control?.stop(true)
    control = null
    rmSync(p.control, { force: true })
  })

  it("starts the keeper and a service under it for a stopped instance, holding it under the command's own name", async () => {
    await releasePidfiles()
    await serviceUp("t", "stop", false)
    expect(await answers(p)).toBe(true)
    expect(existsSync(resolve(p.dir, "keeper", "keeper.sock"))).toBe(true)
    const held = readSince("t", START).entries.filter(
      (e) =>
        e.kind === "op" &&
        (e.phase === "begin" || e.phase === "end") &&
        e.pid === process.pid,
    )
    expect(held.map((e) => (e.kind === "op" ? e.phase : ""))).toEqual([
      "begin",
      "end",
    ])
    expect(held[0]).toMatchObject({ operation: "stop", automatic: false })
  }, 30_000)

  for (const op of ["start", "load"] as const)
    it(`starts a service for an instance a ${op} creates, which has no meta.json yet`, async () => {
      const q = pathsFor("brandnew")
      await serviceUp("brandnew", op, false)
      expect(await answers(q)).toBe(true)
      expect(existsSync(q.meta)).toBe(false)
    }, 30_000)

  it("says how to get a keeper, and starts nothing, when none is found", async () => {
    await releasePidfiles()
    process.env.WINVM_KEEPER = ""
    await expect(serviceUp("t", "start", false)).rejects.toThrow(
      `no winvm-keeper was found, so winvm's service for "t" was not started`,
    )
    expect(existsSync(resolve(p.dir, "keeper"))).toBe(false)
  })

  it("is refused as busy while a person's command holds the instance, and waits for it with --wait", async () => {
    await releasePidfiles()
    lease(process.pid, "snapshot")
    await expect(serviceUp("t", "start", false)).rejects.toBeInstanceOf(
      InstanceBusy,
    )
    const t0 = Date.now()
    setTimeout(() => {
      rmSync(p.lease, { force: true })
    }, 500)
    await serviceUp("t", "start", true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
    expect(await answers(p)).toBe(true)
  }, 30_000)

  it("hands a running VM's stale service over, waiting with --wait for the command that holds it", async () => {
    process.env.WINVM_KEEPER = ""
    const old = await service(OLD, realCli)
    lease(process.pid, "snapshot")
    await expect(serviceUp("t", "save", false)).rejects.toBeInstanceOf(
      InstanceBusy,
    )
    expect(live(old.pid)).toBe(true)
    setTimeout(() => {
      rmSync(p.lease, { force: true })
    }, 500)
    await serviceUp("t", "save", true)
    expect(live(old.pid)).toBe(false)
    expect(live(qemu.pid)).toBe(true)
  }, 30_000)
})

describe("what the CLI says after a repair", () => {
  const changed = { changed: true, servicePid: 1 } as const

  it("says the control service now runs this build", () => {
    expect(reconcileNote("t", changed, p)).toBe(
      `note: "t"'s control service now runs this build; Windows kept running`,
    )
  })

  it("says nothing of the kind once QEMU has gone", () => {
    rmSync(p.pid)
    expect(reconcileNote("t", changed, p)).toBeNull()
  })

  it("says nothing when nothing changed, or the work was left for later", () => {
    expect(reconcileNote("t", { changed: false, servicePid: 1 }, p)).toBeNull()
    expect(reconcileNote("t", { ...changed, deferred: "busy" }, p)).toBeNull()
  })
})

describe("a service asked to ensure itself, as an op it runs does", () => {
  it("answers with its own record and starts no other service", async () => {
    const own: ServiceInfo = {
      pid: process.pid,
      cli: "",
      version: "0",
      startedAt: "2026-11-17T00:00:00.000Z",
      build: CURRENT,
    }
    writeFileSync(p.service, JSON.stringify(own))
    let started = 0
    const info = await ensureService("t", p, {
      start: () => {
        started += 1
      },
      timeoutMs: 200,
    })
    expect(started).toBe(0)
    expect(info.pid).toBe(process.pid)
    expect(existsSync(p.service)).toBe(true)
  })
})
