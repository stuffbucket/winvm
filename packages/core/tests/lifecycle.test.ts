/**
 * Startup reconciliation of an instance's management processes (lifecycle.ts):
 * the control service and the watcher are brought to this build while QEMU,
 * which only ever stands in here as a process the test spawned, is left alone.
 *
 * Every process signalled is one these tests spawned (tests/fakes/holder.ts),
 * under a temporary WINVM_HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { ManagementError, reconcileManagement, shouldReconcileVerb, type ReconcileOptions } from "../src/lifecycle"
import { PACKAGE_DIR, pathsFor, type Paths } from "../src/paths"
import { ensureService, readService, stopService, type ServiceInfo } from "../src/service"
import { ensureWatcher, realActions, watchPathsFor, watcherRecord } from "../src/watch"
import { FakeAgent } from "./fakes/agent"
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

/** Every non-zero signal this process sends, by pid. Nothing is intercepted: the signal is still sent. */
const signals: { readonly pid: number; readonly sig: string }[] = []
const realKill = process.kill.bind(process)

const sleep = async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms))

const live = (pid: number): boolean => {
  try {
    realKill(pid, 0)
  } catch {
    return false
  }
  return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("Z")
}

/** A holder process with these arguments; waits until it has its SIGTERM handler. */
async function hold(...args: string[]): Promise<Proc> {
  const h = Bun.spawn([process.execPath, HOLDER, ...args], { stdout: "pipe", stderr: "ignore" })
  spawned.push(h)
  const reader = (h.stdout as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  reader.releaseLock()
  return h
}

/** Started without waiting for it: what a seam that must be synchronous can do. */
function holdNow(...args: string[]): Proc {
  const h = Bun.spawn([process.execPath, HOLDER, ...args], { stdout: "ignore", stderr: "ignore" })
  spawned.push(h)
  return h
}

const recordService = (pid: number, build: string | undefined): void => {
  const info: ServiceInfo = { pid, cli: CLI, version: "0", startedAt: "", ...(build === undefined ? {} : { build }) }
  writeFileSync(p.service, JSON.stringify(info))
}

const recordWatcher = (pid: number, build: string | undefined, state = "watching"): void => {
  writeFileSync(watchPathsFor("t").pid, `${String(pid)}\n`)
  writeFileSync(watchPathsFor("t").state, JSON.stringify({ pid, state, ...(build === undefined ? {} : { build }) }))
}

async function service(build: string | undefined): Promise<Proc> {
  const h = await hold("serve", "-i", "t")
  recordService(h.pid, build)
  return h
}

async function watcher(build: string | undefined, state = "watching", ...extra: string[]): Promise<Proc> {
  const h = await hold(...extra, "winvm", "watch", "-i", "t")
  recordWatcher(h.pid, build, state)
  return h
}

/** Seams that start current-generation stand-ins and count the starts. */
function seams(o: Partial<ReconcileOptions> = {}): { starts: { service: number; watcher: number }; options: ReconcileOptions } {
  const starts = { service: 0, watcher: 0 }
  return {
    starts,
    options: {
      current: CURRENT,
      serviceTimeoutMs: 3000,
      watcherTimeoutMs: 3000,
      startService: () => {
        starts.service += 1
        recordService(holdNow("serve", "-i", "t").pid, CURRENT)
      },
      startWatcher: () => {
        starts.watcher += 1
        const h = holdNow("winvm", "watch", "-i", "t")
        recordWatcher(h.pid, CURRENT)
        return h.pid
      },
      ...o,
    },
  }
}

/** QEMU's stand-in is alive and this process never sent it anything but signal 0. */
function expectQemuUntouched(): void {
  expect(live(qemu.pid)).toBe(true)
  expect(signals.filter((s) => s.pid === qemu.pid)).toEqual([])
  expect(readFileSync(p.pid, "utf8").trim()).toBe(String(qemu.pid))
}

beforeEach(async () => {
  saved = Object.fromEntries(["WINVM_HOME", "WINVM_CLI", "WINVM_NO_RECONCILE"].map((k) => [k, process.env[k]]))
  home = mkdtempSync(resolve(tmpdir(), "winvm-lc-"))
  process.env["WINVM_HOME"] = home
  process.env["WINVM_CLI"] = CLI
  delete process.env["WINVM_NO_RECONCILE"]
  p = pathsFor("t")
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.meta, JSON.stringify({ image: "x", vnc: 9, created: "" }))
  // QEMU's broker socket: its presence says this QEMU talks through a service.
  writeFileSync(p.qmpQemu, "")
  qemu = await hold("qemu-stand-in")
  writeFileSync(p.pid, `${String(qemu.pid)}\n`)
  control = Bun.serve({ unix: p.control, fetch: () => new Response("ok") })
  signals.length = 0
  process.kill = ((pid: number, sig?: string | number): true => {
    if (sig !== 0) signals.push({ pid, sig: String(sig ?? "SIGTERM") })
    return realKill(pid, sig)
  }) as typeof process.kill
})

afterEach(async () => {
  process.kill = realKill
  await control?.stop(true)
  control = null
  for (const s of spawned.splice(0)) s.kill("SIGKILL")
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

describe("reconciling management processes", () => {
  it("does nothing while QEMU is not running", async () => {
    rmSync(p.pid)
    const old = await service(OLD)
    const s = seams()
    expect(await reconcileManagement("t", p, s.options)).toEqual({ changed: false, servicePid: null, watcherPid: null })
    expect(s.starts).toEqual({ service: 0, watcher: 0 })
    expect(live(old.pid)).toBe(true)
    expect(signals).toEqual([])
  })

  it("leaves a current service and watcher alone", async () => {
    const svc = await service(CURRENT)
    const w = await watcher(CURRENT)
    const s = seams()
    expect(await reconcileManagement("t", p, s.options)).toEqual({ changed: false, servicePid: svc.pid, watcherPid: w.pid })
    expect(s.starts).toEqual({ service: 0, watcher: 0 })
    expect(signals).toEqual([])
    expectQemuUntouched()
  })

  it("stops the watcher before the service, and starts the service before the watcher", async () => {
    const svc = await service(OLD)
    const w = await watcher(OLD)
    const order: string[] = []
    const watcherAliveAtServiceStop: boolean[] = []
    process.kill = ((pid: number, sig?: string | number): true => {
      if (sig !== 0) {
        signals.push({ pid, sig: String(sig ?? "SIGTERM") })
        if (pid === w.pid) order.push("stop watcher")
        if (pid === svc.pid) {
          order.push("stop service")
          watcherAliveAtServiceStop.push(live(w.pid))
        }
      }
      return realKill(pid, sig)
    }) as typeof process.kill
    const s = seams()
    const base = s.options
    const r = await reconcileManagement("t", p, {
      ...base,
      startService: () => {
        order.push(`start service (old alive: ${String(live(svc.pid))})`)
        base.startService?.()
      },
      startWatcher: () => {
        order.push("start watcher")
        return base.startWatcher?.() ?? null
      },
    })
    expect(order).toEqual(["stop watcher", "stop service", "start service (old alive: false)", "start watcher"])
    expect(watcherAliveAtServiceStop).toEqual([false])
    expect(r.changed).toBe(true)
    expect(readService(p)?.build).toBe(CURRENT)
    expect(watcherRecord("t")?.build).toBe(CURRENT)
    expect(r.servicePid).toBe(readService(p)?.pid ?? -1)
    expect(r.watcherPid).toBe(watcherRecord("t")?.pid ?? -1)
    expectQemuUntouched()
  })

  it("quiesces and restores a current watcher while it replaces a stale service", async () => {
    const svc = await service(OLD)
    const w = await watcher(CURRENT)
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 1, watcher: 1 })
    expect(live(w.pid)).toBe(false)
    expect(live(svc.pid)).toBe(false)
    expect(r.watcherPid).not.toBe(w.pid)
    expect(watcherRecord("t")).toEqual({ pid: r.watcherPid ?? -1, build: CURRENT })
    expectQemuUntouched()
  })

  it("replaces a stale watcher without touching a current service", async () => {
    const svc = await service(CURRENT)
    const w = await watcher(OLD)
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 0, watcher: 1 })
    expect(r).toMatchObject({ changed: true, servicePid: svc.pid })
    expect(live(w.pid)).toBe(false)
    expect(signals.filter((x) => x.pid === svc.pid)).toEqual([])
    expectQemuUntouched()
  })

  it("starts no watcher where none was running", async () => {
    const svc = await service(OLD)
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 1, watcher: 0 })
    expect(r.watcherPid).toBeNull()
    expect(live(svc.pid)).toBe(false)
    expect(existsSync(watchPathsFor("t").pid)).toBe(false)
    expectQemuUntouched()
  })

  it("does not restart a watcher once watching has been turned off", async () => {
    await service(OLD)
    await watcher(OLD)
    writeFileSync(resolve(p.dir, "config.json"), JSON.stringify({ "watch.enabled": false }))
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 1, watcher: 0 })
    expect(r.watcherPid).toBeNull()
  })

  it("rotates legacy records, which carry no build", async () => {
    const svc = await service(undefined)
    const w = await watcher(undefined)
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 1, watcher: 1 })
    expect(r.changed).toBe(true)
    expect(live(svc.pid) || live(w.pid)).toBe(false)
    expectQemuUntouched()
  })

  it("starts a service for a running QEMU that has lost its own", async () => {
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 1, watcher: 0 })
    expect(r.servicePid).toBe(readService(p)?.pid ?? -1)
    expectQemuUntouched()
  })

  it("leaves a QEMU started before the control service existed without one", async () => {
    rmSync(p.qmpQemu)
    const s = seams()
    expect(await reconcileManagement("t", p, s.options)).toEqual({ changed: false, servicePid: null, watcherPid: null })
    expect(s.starts).toEqual({ service: 0, watcher: 0 })
  })
})

describe("saves in progress", () => {
  for (const how of ["the save lock", "saving.json"] as const) {
    it(`defers while a manual save holds ${how}, and changes nothing`, async () => {
      const svc = await service(OLD)
      const w = await watcher(OLD)
      const saver = await hold("winvm", "save", "-i", "t")
      if (how === "the save lock") {
        mkdirSync(resolve(home, "saves", "t"), { recursive: true })
        writeFileSync(resolve(home, "saves", "t", ".lock"), String(saver.pid))
      } else {
        writeFileSync(resolve(p.dir, "saving.json"), JSON.stringify({ pid: saver.pid }))
      }
      const s = seams()
      expect(await reconcileManagement("t", p, s.options)).toEqual({
        changed: false,
        servicePid: svc.pid,
        watcherPid: w.pid,
        deferred: "saving",
      })
      expect(s.starts).toEqual({ service: 0, watcher: 0 })
      expect(signals).toEqual([])
      // The save ends: the next ordinary invocation does the work.
      saver.kill("SIGKILL")
      await saver.exited
      const r = await reconcileManagement("t", p, s.options)
      expect(r.changed).toBe(true)
      expect(s.starts).toEqual({ service: 1, watcher: 1 })
      expectQemuUntouched()
    })
  }

  it("lets an autosave finish through the watcher's own shutdown before replacing the service", async () => {
    const svc = await service(OLD)
    // SIGTERM to a watcher mid-autosave: it finishes the save (here, 1 s) and then exits.
    const w = await watcher(OLD, "autosaving", "--linger", "1000")
    // The save lock, held by the watcher itself, as saves.withLock does in-process.
    mkdirSync(resolve(home, "saves", "t"), { recursive: true })
    writeFileSync(resolve(home, "saves", "t", ".lock"), String(w.pid))
    void w.exited.then(() => rmSync(resolve(home, "saves", "t", ".lock"), { force: true }))
    const s = seams()
    const t0 = Date.now()
    const first = reconcileManagement("t", p, s.options)
    await sleep(300)
    // Meanwhile another command is told the work is waiting on the autosave, and does nothing.
    expect(await reconcileManagement("t", p, s.options)).toMatchObject({ changed: false, deferred: "autosaving" })
    expect(live(svc.pid)).toBe(true)
    const r = await first
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000)
    expect(r.changed).toBe(true)
    expect(s.starts).toEqual({ service: 1, watcher: 1 })
    expect(signals.filter((x) => x.pid === w.pid).map((x) => x.sig)).toEqual(["SIGTERM"])
    expectQemuUntouched()
  })

  it("leaves the service to go by itself when the stow it waited for quit QEMU", async () => {
    const svc = await service(OLD)
    // The watcher's stow quits QEMU (the stand-in's own process does it) as it finishes.
    await watcher(OLD, "stowing", "--linger", "300", "--then-kill", String(qemu.pid), "--then-rm", p.pid)
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(r).toEqual({ changed: true, servicePid: svc.pid, watcherPid: null, deferred: "stowing" })
    expect(s.starts).toEqual({ service: 0, watcher: 0 })
    expect(signals.filter((x) => x.pid === svc.pid || x.pid === qemu.pid)).toEqual([])
  })
})

describe("one reconciliation at a time", () => {
  it("keeps its lock in the instance directory", () => {
    expect(p.reconcile).toBe(resolve(p.dir, "reconcile.lock"))
  })

  it("replaces once when two run at the same moment", async () => {
    await service(OLD)
    await watcher(OLD)
    const s = seams()
    const [a, b] = await Promise.all([reconcileManagement("t", p, s.options), reconcileManagement("t", p, s.options)])
    expect(s.starts).toEqual({ service: 1, watcher: 1 })
    expect([a.changed, b.changed].toSorted()).toEqual([false, true])
    expect(a.servicePid).toBe(b.servicePid)
    expect(a.watcherPid).toBe(b.watcherPid)
    expect(existsSync(resolve(p.dir, "reconcile.lock"))).toBe(false)
    expectQemuUntouched()
  })

  it("waits for a live holder of the lock, and changes nothing if it does not let go", async () => {
    const svc = await service(OLD)
    const other = await hold("winvm", "status")
    const start = spawnSync("ps", ["-o", "lstart=", "-p", String(other.pid)], { encoding: "utf8" }).stdout.trim()
    writeFileSync(resolve(p.dir, "reconcile.lock"), JSON.stringify({ pid: other.pid, start, token: "other" }))
    const s = seams({ lockWaitMs: 300 })
    expect(await reconcileManagement("t", p, s.options)).toEqual({ changed: false, servicePid: svc.pid, watcherPid: null })
    expect(s.starts).toEqual({ service: 0, watcher: 0 })
    expect(readFileSync(resolve(p.dir, "reconcile.lock"), "utf8")).toContain('"token":"other"')
  })

  for (const [label, stale] of [
    ["a holder that died", async (): Promise<{ pid: number; start: string }> => {
      const gone = Bun.spawn(["true"])
      await gone.exited
      return { pid: gone.pid, start: "whenever" }
    }],
    ["a pid reused by another process", async (): Promise<{ pid: number; start: string }> => {
      const reused = await hold("unrelated")
      return { pid: reused.pid, start: "Thu Jan  1 00:00:00 1970" }
    }],
  ] as const) {
    it(`takes over a lock left by ${label}, and finishes the watcher restart it promised`, async () => {
      await service(OLD)
      writeFileSync(resolve(p.dir, "reconcile.lock"), JSON.stringify({ ...(await stale()), token: "dead", restoreWatcher: true }))
      const s = seams({ lockWaitMs: 300 })
      const r = await reconcileManagement("t", p, s.options)
      expect(s.starts).toEqual({ service: 1, watcher: 1 })
      expect(r.changed).toBe(true)
      expect(existsSync(resolve(p.dir, "reconcile.lock"))).toBe(false)
      expect(signals.filter((x) => x.pid !== readService(p)?.pid && x.sig !== "SIGTERM")).toEqual([])
    })
  }
})

describe("a replacement that fails", () => {
  it("reports a retryable service-replace error, keeps QEMU, and recovers on the next run", async () => {
    const svc = await service(OLD)
    const w = await watcher(CURRENT)
    const broken = seams({ serviceTimeoutMs: 300, startService: () => undefined })
    let error: unknown
    try {
      await reconcileManagement("t", p, broken.options)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ManagementError)
    expect((error as ManagementError).kind).toBe("service-replace")
    expect((error as ManagementError).retryable).toBe(true)
    expect((error as ManagementError).message).toContain("still running")
    // The stale service is gone and nothing claims to be a healthy one.
    expect(live(svc.pid)).toBe(false)
    expect(readService(p)).toBeNull()
    // The watcher that was running is running again, and the lock is released.
    expect(watcherRecord("t")?.build).toBe(CURRENT)
    expect(live(w.pid)).toBe(false)
    expect(existsSync(resolve(p.dir, "reconcile.lock"))).toBe(false)
    expectQemuUntouched()

    const fixed = seams()
    const r = await reconcileManagement("t", p, fixed.options)
    expect(r.changed).toBe(true)
    expect(fixed.starts.service).toBe(1)
    expect(readService(p)?.build).toBe(CURRENT)
    expect(watcherRecord("t")?.build).toBe(CURRENT)
    expectQemuUntouched()
  })

  it("wraps a launch that throws", async () => {
    await service(OLD)
    const s = seams({
      startService: () => {
        throw new Error("spawn ENOENT")
      },
    })
    await expect(reconcileManagement("t", p, s.options)).rejects.toMatchObject({ kind: "service-replace", retryable: true })
    expectQemuUntouched()
  })

  it("reports a watcher that does not come back as current as watcher-replace", async () => {
    await service(CURRENT)
    await watcher(OLD)
    const s = seams({
      watcherTimeoutMs: 300,
      startWatcher: () => {
        const h = holdNow("winvm", "watch", "-i", "t")
        recordWatcher(h.pid, OLD)
        return h.pid
      },
    })
    await expect(reconcileManagement("t", p, s.options)).rejects.toMatchObject({ kind: "watcher-replace", retryable: true })
    expect(existsSync(resolve(p.dir, "reconcile.lock"))).toBe(false)
    expectQemuUntouched()
  })
})

describe("no recursion", () => {
  it("reconciles before instance read and management verbs", () => {
    for (const verb of ["status", "info", "exec", "put", "get", "terminal", "screenshot", "save", "snapshot", "config", "share"]) {
      expect(shouldReconcileVerb(verb, {})).toBe(true)
    }
  })

  it("never inside the service or the watcher, nor for teardown, build or test verbs", () => {
    for (const verb of ["serve", "watch", "stop", "kill", "destroy", "reset", "stow", "build", "setup", "adopt", "create", "run", "test", "rmi", "prune", "ls", "doctor", "help"]) {
      expect(shouldReconcileVerb(verb, {})).toBe(false)
    }
  })

  it("never in a process started with WINVM_NO_RECONCILE=1", () => {
    expect(shouldReconcileVerb("status", { WINVM_NO_RECONCILE: "1" })).toBe(false)
    expect(shouldReconcileVerb("status", { WINVM_NO_RECONCILE: "" })).toBe(true)
  })

  it("marks the detached service, the watcher and the watcher's stow child", async () => {
    const out = resolve(home, "spawned")
    const cli = resolve(home, "fake-cli.ts")
    writeFileSync(
      cli,
      `import { writeFileSync } from "node:fs"\n` +
        `writeFileSync(${JSON.stringify(out)} + "." + process.argv[2], String(process.env["WINVM_NO_RECONCILE"] ?? "unset"))\n`,
    )
    process.env["WINVM_CLI"] = cli
    const seen = async (verb: string): Promise<string> => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !existsSync(`${out}.${verb}`)) await sleep(50)
      return readFileSync(`${out}.${verb}`, "utf8")
    }
    ensureWatcher("t")
    expect(await seen("watch")).toBe("1")
    await expect(ensureService("t", p, { timeoutMs: 200 })).rejects.toThrow()
    expect(await seen("serve")).toBe("1")
    expect(await realActions("t", p, () => undefined).stow()).toBe(true)
    expect(await seen("stow")).toBe("1")
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

  const env = (extra: Record<string, string>): Record<string, string | undefined> => {
    const e: Record<string, string | undefined> = { ...process.env, WINVM_HOME: home, WINVM_BUILD_ID: "sha256:cli-test", ...extra }
    for (const k of ["WINVM_CLI", "WINVM_INSTANCE", "WINVM_NO_RECONCILE"]) if (!(k in extra)) delete e[k]
    return e
  }

  const status = (extra: Record<string, string> = {}): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [cli, "status", "--json", "-i", "t"], { env: env(extra), encoding: "utf8", timeout: 60_000 })

  it("status --json repairs a stale service and leaves QEMU running", async () => {
    const old = await service(OLD)
    const r = status()
    expect(r.status).toBe(0)
    expect(live(old.pid)).toBe(false)
    expect(readService(p)?.build).toBe("sha256:cli-test")
    expect(live(qemu.pid)).toBe(true)
    expect(JSON.parse(String(r.stdout))).toMatchObject({ name: "t" })
  }, 60_000)

  it("does not reconcile with WINVM_NO_RECONCILE=1", async () => {
    const old = await service(OLD)
    status({ WINVM_NO_RECONCILE: "1" })
    expect(live(old.pid)).toBe(true)
    expect(readService(p)?.build).toBe(OLD)
  }, 60_000)
})
