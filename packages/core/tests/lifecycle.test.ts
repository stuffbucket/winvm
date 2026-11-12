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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { ManagementError, reconcileManagement, reconcileNote, shouldReconcileVerb, type ReconcileOptions } from "../src/lifecycle"
import { PACKAGE_DIR, pathsFor, type Paths } from "../src/paths"
import * as saves from "../src/saves"
import { ensureService, readService, stopService, type ServiceInfo } from "../src/service"
import { ensureWatcher, realActions, stopWatcher, watchPathsFor, watcherRecord } from "../src/watch"
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

const recordService = (pid: number, build: string | undefined, cli = CLI): void => {
  const info: ServiceInfo = { pid, cli, version: "0", startedAt: "", ...(build === undefined ? {} : { build }) }
  writeFileSync(p.service, JSON.stringify(info))
}

const recordWatcher = (pid: number, build: string | undefined, state = "watching", cli?: string): void => {
  writeFileSync(watchPathsFor("t").pid, `${String(pid)}\n`)
  writeFileSync(
    watchPathsFor("t").state,
    JSON.stringify({ pid, state, ...(build === undefined ? {} : { build }), ...(cli === undefined ? {} : { cli }) }),
  )
}

async function service(build: string | undefined, cli = CLI): Promise<Proc> {
  const h = await hold("winvm", "serve", "-i", "t")
  recordService(h.pid, build, cli)
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
        recordService(holdNow("winvm", "serve", "-i", "t").pid, CURRENT)
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

/** Where a watcher still owed is written down, as a reconciliation that stopped one and died would leave it. */
const owedPath = (): string => resolve(p.dir, "watch.owed")
const owe = (qemuPid: number): void => writeFileSync(owedPath(), JSON.stringify({ qemu: qemuPid }))

/** A script, in the temporary home, that runs `body` with reconcileManagement imported: another winvm process. */
function childScript(body: string): string {
  const f = resolve(home, `child-${String(Date.now())}-${String(Math.random()).slice(2)}.ts`)
  writeFileSync(f, `import { reconcileManagement } from ${JSON.stringify(resolve(import.meta.dir, "..", "src", "lifecycle.ts"))}\n${body}\n`)
  return f
}

const childEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => {
  const e: Record<string, string | undefined> = { ...process.env, WINVM_HOME: home, WINVM_CLI: CLI, ...extra }
  delete e["WINVM_NO_RECONCILE"]
  return e
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

  it("holds the save lock while it replaces the service, so no save can start under it", async () => {
    await service(OLD)
    const saveLock = resolve(home, "saves", "t", ".lock")
    const during: string[] = []
    const s = seams()
    const base = s.options
    await reconcileManagement("t", p, {
      ...base,
      startService: () => {
        during.push(existsSync(saveLock) ? readFileSync(saveLock, "utf8").trim() : "no save lock")
        base.startService?.()
      },
    })
    expect(during).toEqual([String(process.pid)])
    expect(existsSync(saveLock)).toBe(false)
    expectQemuUntouched()
  })

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
    // As any winvm records it: ps in the C locale and UTC.
    const start = spawnSync("ps", ["-o", "lstart=", "-p", String(other.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).stdout.trim()
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
      writeFileSync(
        resolve(p.dir, "reconcile.lock"),
        JSON.stringify({ ...(await stale()), token: "dead", restoreWatcher: true, qemu: qemu.pid }),
      )
      owe(qemu.pid)
      const s = seams({ lockWaitMs: 300 })
      const r = await reconcileManagement("t", p, s.options)
      expect(s.starts).toEqual({ service: 1, watcher: 1 })
      expect(r.changed).toBe(true)
      expect(existsSync(resolve(p.dir, "reconcile.lock"))).toBe(false)
      expect(signals.filter((x) => x.pid !== readService(p)?.pid && x.sig !== "SIGTERM")).toEqual([])
    })
  }

  it("never takes over from a live holder whose ps prints its start in another locale and time zone", async () => {
    await service(OLD)
    const marker = resolve(home, "holding")
    // Another winvm, run from a shell with another TZ and locale, holding the lock mid-replacement.
    const script = childScript(
      `import { writeFileSync } from "node:fs"\n` +
        `await reconcileManagement("t", undefined, {\n` +
        `  current: ${JSON.stringify(CURRENT)},\n` +
        `  serviceTimeoutMs: 100,\n` +
        `  startService: () => { writeFileSync(${JSON.stringify(marker)}, "x"); Bun.sleepSync(3000) },\n` +
        `}).catch(() => undefined)`,
    )
    const child = Bun.spawn([process.execPath, script], {
      env: childEnv({ TZ: "Pacific/Auckland", LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" }),
      stdout: "ignore",
      stderr: "ignore",
    })
    spawned.push(child)
    const deadline = Date.now() + 15_000
    while (!existsSync(marker) && Date.now() < deadline) await sleep(25)
    expect(existsSync(marker)).toBe(true)
    const env = { TZ: process.env["TZ"], LC_ALL: process.env["LC_ALL"] }
    process.env["TZ"] = "America/Los_Angeles"
    process.env["LC_ALL"] = "C"
    try {
      const s = seams({ lockWaitMs: 500 })
      const r = await reconcileManagement("t", p, s.options)
      expect(s.starts).toEqual({ service: 0, watcher: 0 })
      expect(r.changed).toBe(false)
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    await child.exited
  }, 30_000)

  it("gives up on a lock it cannot read with a retryable error, rather than spinning", async () => {
    const old = await service(OLD)
    writeFileSync(p.reconcile, "{}")
    chmodSync(p.reconcile, 0)
    // In another process, so a spin cannot hang this one.
    const script = childScript(
      `const r = await reconcileManagement("t", undefined, { current: ${JSON.stringify(CURRENT)}, lockWaitMs: 300 })\n` +
        `  .then((ok) => ({ ok }), (e) => ({ kind: e.kind, retryable: e.retryable, message: e.message }))\n` +
        `console.log(JSON.stringify(r))`,
    )
    const r = spawnSync(process.execPath, [script], { env: childEnv(), encoding: "utf8", timeout: 10_000 })
    chmodSync(p.reconcile, 0o600)
    expect(r.signal).toBeNull()
    expect(JSON.parse(r.stdout) as unknown).toMatchObject({ kind: "reconcile-lock", retryable: true })
    expect(String((JSON.parse(r.stdout) as { message: string }).message)).toContain(p.reconcile)
    expect(live(old.pid)).toBe(true)
    expectQemuUntouched()
  }, 30_000)

  it("reports a lock it cannot create as a retryable error", async () => {
    const old = await service(OLD)
    chmodSync(p.dir, 0o555)
    try {
      await expect(reconcileManagement("t", p, seams({ lockWaitMs: 300 }).options)).rejects.toMatchObject({
        kind: "reconcile-lock",
        retryable: true,
      })
    } finally {
      chmodSync(p.dir, 0o755)
    }
    expect(live(old.pid)).toBe(true)
    expectQemuUntouched()
  })
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
    expect((error as ManagementError).message).toContain(resolve(p.dir, "service.log"))
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
    // Nobody holds the lock: the next command is not kept waiting.
    const t0 = Date.now()
    await reconcileManagement("t", p, seams({ lockWaitMs: 5000 }).options)
    expect(Date.now() - t0).toBeLessThan(3000)
    expectQemuUntouched()
  })

  it("names the watcher's log, where the watcher writes it", async () => {
    await service(CURRENT)
    await watcher(OLD)
    await expect(reconcileManagement("t", p, seams({ watcherTimeoutMs: 200, startWatcher: () => null }).options)).rejects.toThrow(
      watchPathsFor("t").log,
    )
  })
})

describe("a watcher owed after a failure", () => {
  it("is restored by the next run after its own restart failed", async () => {
    await service(CURRENT)
    const w = await watcher(OLD)
    // The replacement never starts: no process, no record.
    const broken = seams({ watcherTimeoutMs: 300, startWatcher: () => null })
    await expect(reconcileManagement("t", p, broken.options)).rejects.toMatchObject({ kind: "watcher-replace" })
    expect(live(w.pid)).toBe(false)
    expect(watcherRecord("t")).toBeNull()
    const fixed = seams()
    const r = await reconcileManagement("t", p, fixed.options)
    expect(fixed.starts).toEqual({ service: 0, watcher: 1 })
    expect(r.changed).toBe(true)
    expect(watcherRecord("t")?.build).toBe(CURRENT)
    expect(existsSync(p.reconcile)).toBe(false)
    expectQemuUntouched()
  })

  it("is restored by the next run after a failed service replacement whose watcher restart failed too", async () => {
    await service(OLD)
    await watcher(CURRENT)
    const broken = seams({
      serviceTimeoutMs: 300,
      startService: () => undefined,
      startWatcher: () => {
        throw new Error("spawn ENOENT")
      },
    })
    await expect(reconcileManagement("t", p, broken.options)).rejects.toMatchObject({ kind: "service-replace" })
    expect(watcherRecord("t")).toBeNull()
    const fixed = seams()
    await reconcileManagement("t", p, fixed.options)
    expect(fixed.starts).toEqual({ service: 1, watcher: 1 })
    expect(watcherRecord("t")?.build).toBe(CURRENT)
    expect(readService(p)?.build).toBe(CURRENT)
    expect(existsSync(p.reconcile)).toBe(false)
    expectQemuUntouched()
  })

  it("is settled by a watcher that is already current, so a later `watch --stop` stays stopped", async () => {
    await service(CURRENT)
    await watcher(OLD)
    // 1. The replacement fails: a watcher is owed.
    await expect(reconcileManagement("t", p, seams({ watcherTimeoutMs: 200, startWatcher: () => null }).options)).rejects.toMatchObject({
      kind: "watcher-replace",
    })
    // 2. Meanwhile a current watcher came up anyway (`winvm start`, or `winvm watch`).
    const w = await watcher(CURRENT)
    // 3. The next run finds the debt paid, and forgets it.
    const s = seams()
    expect(await reconcileManagement("t", p, s.options)).toMatchObject({ changed: false, watcherPid: w.pid })
    expect(existsSync(p.reconcile)).toBe(false)
    // 4. The user stops watching.
    w.kill("SIGTERM")
    await w.exited
    rmSync(watchPathsFor("t").pid, { force: true })
    // 5. And it stays stopped: no watcher is started where none runs.
    const r = await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 0, watcher: 0 })
    expect(r.watcherPid).toBeNull()
    expectQemuUntouched()
  })

  it("is dropped once the QEMU it was owed to has gone", async () => {
    await service(CURRENT)
    await watcher(OLD)
    await expect(reconcileManagement("t", p, seams({ watcherTimeoutMs: 200, startWatcher: () => null }).options)).rejects.toThrow()
    // Windows stopped and started again: that start decides about watching for itself.
    const next = await hold("qemu-stand-in-2")
    writeFileSync(p.pid, `${String(next.pid)}\n`)
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 0, watcher: 0 })
    expect(r.watcherPid).toBeNull()
    expect(existsSync(p.reconcile)).toBe(false)
  })
})

describe("a watcher busy saving, for a command that must not wait", () => {
  for (const state of ["autosaving", "stowing"] as const) {
    it(`defers at once while it is ${state}, never signals it, and repairs once that is over`, async () => {
      const svc = await service(OLD)
      const w = await watcher(OLD, state)
      const s = seams({ waitForBusyWatcher: false })
      for (let i = 0; i < 2; i += 1) {
        const t0 = Date.now()
        expect(await reconcileManagement("t", p, s.options)).toEqual({
          changed: false,
          servicePid: svc.pid,
          watcherPid: w.pid,
          deferred: state,
        })
        expect(Date.now() - t0).toBeLessThan(2000)
      }
      expect(signals.filter((x) => x.pid === w.pid || x.pid === svc.pid)).toEqual([])
      expect(s.starts).toEqual({ service: 0, watcher: 0 })
      // The operation is over; the watcher is only watching again.
      recordWatcher(w.pid, OLD, "watching")
      const r = await reconcileManagement("t", p, s.options)
      expect(r.changed).toBe(true)
      expect(s.starts).toEqual({ service: 1, watcher: 1 })
      expect(live(w.pid) || live(svc.pid)).toBe(false)
      expectQemuUntouched()
    })
  }
})

describe("generations from another install", () => {
  const VIEWER = "/Applications/WinVM.app/Contents/MacOS/winvm"
  const VIEWER_BUILD = "sha256:viewer"

  it("reuses a service and watcher of this build started from another path", async () => {
    const svc = await service(CURRENT, VIEWER)
    const w = await hold("winvm", "watch", "-i", "t")
    recordWatcher(w.pid, CURRENT, "watching", VIEWER)
    const s = seams()
    expect(await reconcileManagement("t", p, s.options)).toEqual({ changed: false, servicePid: svc.pid, watcherPid: w.pid })
    expect(s.starts).toEqual({ service: 0, watcher: 0 })
    expect(signals).toEqual([])
  })

  it("rotates a service and watcher of another build started from this same path (an update in place)", async () => {
    const svc = await service(OLD, CLI)
    const w = await hold("winvm", "watch", "-i", "t")
    recordWatcher(w.pid, OLD, "watching", CLI)
    const s = seams()
    await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 1, watcher: 1 })
    expect(live(svc.pid) || live(w.pid)).toBe(false)
  })

  it("rotates legacy records, with no build, whatever path started them", async () => {
    const svc = await service(undefined, VIEWER)
    const w = await hold("winvm", "watch", "-i", "t")
    recordWatcher(w.pid, undefined, "watching", VIEWER)
    const s = seams()
    await reconcileManagement("t", p, s.options)
    expect(s.starts).toEqual({ service: 1, watcher: 1 })
    expect(live(svc.pid) || live(w.pid)).toBe(false)
  })

  it("leaves another install's live generation alone, as each install asks in turn", async () => {
    const svc = await service(VIEWER_BUILD, VIEWER)
    const w = await hold("winvm", "watch", "-i", "t")
    recordWatcher(w.pid, VIEWER_BUILD, "watching", VIEWER)
    const source = seams()
    const viewer = seams({ current: VIEWER_BUILD })
    for (let i = 0; i < 2; i += 1) {
      process.env["WINVM_CLI"] = CLI
      expect(await reconcileManagement("t", p, source.options)).toEqual({ changed: false, servicePid: svc.pid, watcherPid: w.pid })
      process.env["WINVM_CLI"] = VIEWER
      expect(await reconcileManagement("t", p, viewer.options)).toEqual({ changed: false, servicePid: svc.pid, watcherPid: w.pid })
    }
    expect(source.starts).toEqual({ service: 0, watcher: 0 })
    expect(viewer.starts).toEqual({ service: 0, watcher: 0 })
    // The service and its client (the watcher) were never interrupted.
    expect(signals).toEqual([])
    expect(live(svc.pid) && live(w.pid)).toBe(true)
  })
})

describe("a service that keeps failing to start", () => {
  it("never cycles the current watcher, and converges once a service starts", async () => {
    // No service at all, and a current watcher in the middle of an idle stretch.
    const w = await watcher(CURRENT)
    const before = readFileSync(watchPathsFor("t").state, "utf8")
    const failing = seams({ serviceTimeoutMs: 200, startService: () => undefined })
    for (let i = 0; i < 3; i += 1) {
      await expect(reconcileManagement("t", p, failing.options)).rejects.toMatchObject({ kind: "service-replace" })
      expect(watcherRecord("t")?.pid).toBe(w.pid)
    }
    expect(live(w.pid)).toBe(true)
    expect(signals.filter((x) => x.pid === w.pid)).toEqual([])
    expect(readFileSync(watchPathsFor("t").state, "utf8")).toBe(before)
    expect(failing.starts.watcher).toBe(0)
    const ok = seams()
    const r = await reconcileManagement("t", p, ok.options)
    expect(ok.starts).toEqual({ service: 1, watcher: 0 })
    expect(r.watcherPid).toBe(w.pid)
    expect(readService(p)?.build).toBe(CURRENT)
    expectQemuUntouched()
  })

  it("starts a missing service first, then rotates a stale watcher", async () => {
    const w = await watcher(OLD)
    const order: string[] = []
    process.kill = ((pid: number, sig?: string | number): true => {
      if (sig !== 0) {
        signals.push({ pid, sig: String(sig ?? "SIGTERM") })
        if (pid === w.pid) order.push("stop watcher")
      }
      return realKill(pid, sig)
    }) as typeof process.kill
    const s = seams()
    const base = s.options
    await reconcileManagement("t", p, {
      ...base,
      startService: () => {
        order.push("start service")
        base.startService?.()
      },
      startWatcher: () => {
        order.push("start watcher")
        return base.startWatcher?.() ?? null
      },
    })
    expect(order).toEqual(["start service", "stop watcher", "start watcher"])
    expect(watcherRecord("t")?.build).toBe(CURRENT)
    expectQemuUntouched()
  })
})

describe("races", () => {
  it("keeps a watcher debt that another caller's lock got in ahead of", async () => {
    await service(OLD)
    const gone = Bun.spawn(["true"])
    await gone.exited
    writeFileSync(p.reconcile, JSON.stringify({ pid: gone.pid, start: "whenever", token: "dead", restoreWatcher: true, qemu: qemu.pid }))
    owe(qemu.pid)
    // A takes the dead lock over, then waits only briefly; B takes the lock in between and works slowly.
    const a = seams({ lockWaitMs: 50 })
    const b = seams()
    const slow: ReconcileOptions = {
      ...b.options,
      startService: () => {
        Bun.sleepSync(300)
        b.options.startService?.()
      },
    }
    await Promise.all([reconcileManagement("t", p, a.options), reconcileManagement("t", p, slow)])
    expect(a.starts.watcher + b.starts.watcher).toBe(1)
    expect(watcherRecord("t")?.build).toBe(CURRENT)
    expect(existsSync(owedPath())).toBe(false)
    expectQemuUntouched()
  })

  it("holds the save lock from stopping the watcher until it is back, so a load cannot start in between", async () => {
    await service(OLD)
    const w = await watcher(OLD)
    const loads: Promise<string>[] = []
    process.kill = ((pid: number, sig?: string | number): true => {
      if (sig !== 0) {
        signals.push({ pid, sig: String(sig ?? "SIGTERM") })
        // A load, arriving the moment the watcher is told to stop.
        if (pid === w.pid) loads.push(saves.withLock("t", async () => await Promise.resolve()).then(() => "loaded", () => "refused"))
      }
      return realKill(pid, sig)
    }) as typeof process.kill
    const s = seams()
    const r = await reconcileManagement("t", p, s.options)
    expect(await Promise.all(loads)).toEqual(["refused"])
    expect(r.changed).toBe(true)
    expect(s.starts).toEqual({ service: 1, watcher: 1 })
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

  const status = (extra: Record<string, string> = {}, instance: readonly string[] = ["-i", "t"]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [cli, "status", "--json", ...instance], { env: env(extra), encoding: "utf8", timeout: 60_000 })

  /** A stale service started by this same CLI path: only its build differs. */
  async function staleFromSameCli(): Promise<Proc> {
    const h = await hold("winvm", "serve", "-i", "t")
    const info: ServiceInfo = { pid: h.pid, cli, version: "0", startedAt: "", build: OLD }
    writeFileSync(p.service, JSON.stringify(info))
    return h
  }

  it("status --json repairs a service whose build alone is stale, and leaves QEMU running", async () => {
    const old = await staleFromSameCli()
    const r = status()
    expect(r.status).toBe(0)
    expect(live(old.pid)).toBe(false)
    expect(readService(p)?.build).toBe("sha256:cli-test")
    expect(readService(p)?.cli).toBe(cli)
    expect(live(qemu.pid)).toBe(true)
    expect(JSON.parse(String(r.stdout))).toMatchObject({ name: "t" })
  }, 60_000)

  it("does not reconcile with WINVM_NO_RECONCILE=1", async () => {
    const old = await staleFromSameCli()
    status({ WINVM_NO_RECONCILE: "1" })
    expect(live(old.pid)).toBe(true)
    expect(readService(p)?.build).toBe(OLD)
  }, 60_000)

  it("status --json of every instance reports them all, though one could not be repaired", async () => {
    // "a": running, and its service cannot be launched (its log is a directory).
    const a = pathsFor("a")
    mkdirSync(a.dir, { recursive: true })
    writeFileSync(a.meta, JSON.stringify({ image: "x", vnc: 8, created: "" }))
    writeFileSync(a.pid, `${String(qemu.pid)}\n`)
    writeFileSync(a.qmpQemu, "")
    mkdirSync(resolve(a.dir, "service.log"))
    // "t": running, with a stale service that can be.
    const old = await staleFromSameCli()
    const r = status({}, [])
    expect(String(r.stderr)).toContain(`::error::could not start a current control service for "a"`)
    const out = JSON.parse(String(r.stdout)) as { instances: { name: string }[] }
    expect(out.instances.map((i) => i.name).toSorted()).toEqual(["a", "t"])
    expect(live(old.pid)).toBe(false)
    expect(readService(p)?.build).toBe("sha256:cli-test")
    expect(live(qemu.pid)).toBe(true)
  }, 60_000)

  it("status --json answers at once while a stale watcher is autosaving, signals it never, and repairs once it is done", async () => {
    // "a": running, no broker (so no service to manage), and a stale watcher mid-autosave.
    const a = pathsFor("a")
    mkdirSync(a.dir, { recursive: true })
    writeFileSync(a.meta, JSON.stringify({ image: "x", vnc: 8, created: "" }))
    writeFileSync(a.pid, `${String(qemu.pid)}\n`)
    const got = resolve(home, "a-watcher-signals")
    const w = await hold("--log-signals", got, "winvm", "watch", "-i", "a")
    writeFileSync(watchPathsFor("a").pid, `${String(w.pid)}\n`)
    const busy = (state: string): void => writeFileSync(watchPathsFor("a").state, JSON.stringify({ pid: w.pid, build: OLD, state }))
    busy("autosaving")
    // "t": a stale service that can be repaired.
    const old = await staleFromSameCli()
    const quick = (instance: readonly string[]): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [cli, "status", "--json", ...instance], { env: env({}), encoding: "utf8", timeout: 30_000 })
    try {
      let t0 = Date.now()
      const one = quick(["-i", "a"])
      expect(one.signal).toBeNull()
      expect(Date.now() - t0).toBeLessThan(20_000)
      expect(JSON.parse(String(one.stdout))).toMatchObject({ name: "a" })
      t0 = Date.now()
      const all = quick([])
      expect(all.signal).toBeNull()
      expect(Date.now() - t0).toBeLessThan(20_000)
      expect((JSON.parse(String(all.stdout)) as { instances: { name: string }[] }).instances.map((i) => i.name).toSorted()).toEqual(["a", "t"])
      // The healthy one was still repaired; the busy watcher heard nothing, twice over.
      expect(live(old.pid)).toBe(false)
      expect(readService(p)?.build).toBe("sha256:cli-test")
      expect(existsSync(got)).toBe(false)
      expect(live(w.pid)).toBe(true)
      // The autosave is over: the next status rotates the watcher, and QEMU stays.
      busy("watching")
      expect(quick(["-i", "a"]).status).toBe(0)
      expect(readFileSync(got, "utf8")).toContain("SIGTERM")
      expect(live(w.pid)).toBe(false)
      expect(watcherRecord("a")?.build).toBe("sha256:cli-test")
      expect(live(qemu.pid)).toBe(true)
    } finally {
      await stopWatcher("a")
    }
  }, 120_000)
})

describe("what the CLI says after a repair", () => {
  const changed = { changed: true, servicePid: 1, watcherPid: null } as const

  it("says Windows kept running while it is", () => {
    expect(reconcileNote("t", changed, p)).toContain("Windows kept running")
  })

  it("says nothing of the kind once QEMU has gone", () => {
    rmSync(p.pid)
    expect(reconcileNote("t", changed, p)).toBeNull()
  })

  it("says nothing when nothing changed, or the work was left for later", () => {
    expect(reconcileNote("t", { changed: false, servicePid: 1, watcherPid: null }, p)).toBeNull()
    expect(reconcileNote("t", { ...changed, deferred: "stowing" }, p)).toBeNull()
  })
})
