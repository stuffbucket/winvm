import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { currentCompat, FILES, type Manifest, saveDir } from "../src/saves"
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
const SCRATCH = "winvm-watching-"
const QUICK = { tickMs: 200 }
const ON_MAC = process.platform === "darwin"

let home = ""
let saved: Record<string, string | undefined> = {}
let p: Paths
let fakeQmp: FakeQmp
let fakeAgent: FakeAgent
let guest: FakeGuest
let service: ReturnType<typeof Bun.spawn> | null = null
let vncClients = 0
let reportsVersion: string | null = null
let slowMigrations: ("until-cancel" | number)[] = []
let migration: {
  slow: "until-cancel" | number
  at: number
  cancelled: boolean
} | null = null

const runtime = (): string => resolve(home, "runtime")

const env = (timing: object = QUICK): Record<string, string> => {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("WINVM_")) e[k] = v
  return {
    ...e,
    WINVM_HOME: home,
    WINVM_CLI: CLI,
    WINVM_BUILD_ID: "sha256:watching",
    WINVM_NO_RECONCILE: "1",
    WINVM_KEEPER: "off",
    WINVM_MOUNTS: resolve(home, "mounts"),
    WINVM_RUNTIME: runtime(),
    WINVM_QEMU_DATA: resolve(home, "firmware"),
    WINVM_WATCH_TIMING: JSON.stringify(timing),
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
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
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

async function startService(timing: object = QUICK): Promise<void> {
  service = Bun.spawn([process.execPath, CLI, "serve", "-i", "t"], {
    env: env(timing),
    stdout: "ignore",
    stderr: "ignore",
  })
  const end = Date.now() + 15_000
  while (!(await answers())) {
    if (Date.now() > end) throw new Error("the service never answered")
    await Bun.sleep(50)
  }
}

async function watching(timing: object = QUICK): Promise<void> {
  await startService(timing)
  const r = await winvm("start", "-i", "t")
  if (r.code !== 0) throw new Error(`start: ${r.stderr}`)
  await until(
    "the watcher to watch",
    async () => (await watcher())?.state === "watching",
  )
}

async function startQemu(program?: string): Promise<void> {
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
    program ?? resolve(runtime(), "bin", "qemu-system-aarch64"),
    ...args.filter((a) => a !== p.pid && a !== "-pidfile"),
    "-pidfile",
    p.pid,
  )
}

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
      case "migrate": {
        migrateTo(String(args.uri))
        const slow = slowMigrations.shift()
        migration =
          slow === undefined ? null : { slow, at: Date.now(), cancelled: false }
        return { return: {} }
      }
      case "migrate_cancel":
        if (migration !== null) migration.cancelled = true
        return { return: {} }
      case "query-migrate": {
        const m = migration
        if (m?.cancelled === true) {
          migration = null
          return { return: { status: "cancelled" } }
        }
        if (
          m !== null &&
          (m.slow === "until-cancel" || Date.now() - m.at < m.slow)
        )
          return { return: { status: "active" } }
        migration = null
        return {
          return: { status: "completed", ram: { transferred: 4096 } },
        }
      }
      case "quit":
        setTimeout(() => void releasePidfiles(), 20)
        return { return: {} }
      case "query-vnc":
        return {
          return: {
            enabled: true,
            clients: Array.from({ length: vncClients }, () => ({})),
          },
        }
      case "query-version": {
        if (reportsVersion === null) return await scripted(cmd)
        const [major, minor, micro] = reportsVersion.split(".").map(Number)
        return { return: { qemu: { major, minor, micro }, package: "" } }
      }
      default:
        return await scripted(cmd)
    }
  }
}

function publish(name: string, kind: Manifest["kind"], at: string): void {
  const meta = readMeta("t")
  if (meta === null) throw new Error("no meta")
  const compat = currentCompat("t", meta, RAMFB)
  const m: Manifest = {
    name,
    instance: "t",
    kind,
    createdAt: at,
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
}

function savesOf(kind: string): readonly string[] {
  const dir = resolve(home, "saves", "t")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .filter((n) => {
      try {
        return (
          (
            JSON.parse(
              readFileSync(resolve(dir, n, FILES.manifest), "utf8"),
            ) as { kind?: string }
          ).kind === kind
        )
      } catch {
        return false
      }
    })
    .toSorted()
}

const records = (): readonly Entry[] => readSince("t", START).entries

const automaticOps = (operation: string, phase: "begin" | "end"): Entry[] =>
  records().filter(
    (e) =>
      e.kind === "op" &&
      e.phase === phase &&
      e.operation === operation &&
      e.automatic,
  )

const refusals = (): Entry[] =>
  records().filter((e) => e.kind === "warning" && e.what === "stow refused")

async function until(
  what: string,
  ok: () => boolean | Promise<boolean>,
  ms = 15_000,
): Promise<void> {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

interface Watcher {
  readonly alive: boolean
  readonly pid: number | null
  readonly state: string
  readonly autosave: Record<string, unknown> | null
  readonly stow: Record<string, unknown> | null
}

async function watcher(): Promise<Watcher | null> {
  const r = await winvm("status", "-i", "t", "--json")
  return (JSON.parse(r.stdout) as { watcher: Watcher | null }).watcher
}

async function statusText(): Promise<string> {
  return (await winvm("status", "-i", "t")).stdout
}

const watcherRow = (text: string): string =>
  /^ {2}watcher\s+(.*)$/m.exec(text)?.[1] ?? ""

const offsetMs = (): number => Math.abs(guest.offsetMs)

function legacyWatcherPid(): number | null {
  try {
    const pid = Number.parseInt(
      readFileSync(resolve(p.dir, "watch.pid"), "utf8"),
      10,
    )
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
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
  vncClients = 0
  reportsVersion = null
  slowMigrations = []
  migration = null
  await startQemu()
  fakeQmp = new FakeQmp(p.qmpQemu)
  await fakeQmp.listen()
  fakeAgent = new FakeAgent(p.qgaQemu)
  await fakeAgent.listen()
  guest = new FakeGuest(fakeQmp, fakeAgent)
  monitor()
})

afterEach(async () => {
  const left = legacyWatcherPid()
  if (left !== null) {
    try {
      process.kill(left, "SIGCONT")
      process.kill(left, "SIGKILL")
    } catch {}
  }
  if (service !== null) {
    try {
      process.kill(service.pid, "SIGCONT")
    } catch {}
    service.kill("SIGTERM")
    const ended = service.exited
    if (!(await Promise.race([ended.then(() => true), Bun.sleep(3000)])))
      service.kill("SIGKILL")
    await ended
  }
  service = null
  await releasePidfiles()
  await fakeQmp.close().catch(() => undefined)
  await fakeAgent.close().catch(() => undefined)
  for (const k of Object.keys(process.env))
    if (k.startsWith("WINVM_")) delete process.env[k]
  for (const [k, v] of Object.entries(saved))
    if (v !== undefined) process.env[k] = v
  if (home.startsWith(resolve(tmpdir(), SCRATCH)))
    rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!ON_MAC)("what the watcher does for the user", () => {
  it("autosaves a guest left idle, once, as winvm's own save, and says so in status", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.01",
      "stow.enabled=false",
    )
    await watching()
    await until("an autosave", () => savesOf("auto").length === 1)
    await until("its end", () => automaticOps("save", "end").length === 1)
    await Bun.sleep(1500)
    expect(savesOf("auto")).toHaveLength(1)
    expect(savesOf("auto")[0]).toMatch(/^auto-\d{8}T\d{6}Z$/)
    expect(automaticOps("save", "begin")).toHaveLength(1)
    expect(automaticOps("save", "end")[0]).toMatchObject({ ok: true })
    const w = await watcher()
    expect(w).toMatchObject({
      alive: true,
      state: "watching",
      autosave: { enabled: true, idleMinutes: 0.01, keep: 3 },
      stow: { enabled: false },
    })
    expect(typeof w?.autosave?.lastAt).toBe("string")
    expect(watcherRow(await statusText())).toMatch(
      /^watching, guest idle \d+s · autosave after 0\.01 min idle \(keep 3, last \d+s ago\) · stow off$/,
    )
  }, 45_000)

  it("keeps the newest autosave.keep autosaves and never touches other saves", async () => {
    publish("auto-20260101T000000Z", "auto", "2026-01-01T00:00:00Z")
    publish("auto-20260102T000000Z", "auto", "2026-01-02T00:00:00Z")
    publish("mine", "manual", "2025-01-01T00:00:00Z")
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.01",
      "autosave.keep=2",
      "stow.enabled=false",
    )
    await watching()
    await until(
      "the rotation",
      () =>
        savesOf("auto").length === 2 &&
        !savesOf("auto").includes("auto-20260101T000000Z"),
    )
    expect(savesOf("auto")).toContain("auto-20260102T000000Z")
    expect(savesOf("manual")).toEqual(["mine"])
  }, 45_000)

  it("does not autosave while a VNC client is connected, and does once it leaves", async () => {
    vncClients = 1
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.01",
      "stow.enabled=false",
    )
    await watching()
    await Bun.sleep(2500)
    expect(savesOf("auto")).toEqual([])
    vncClients = 0
    await until("an autosave", () => savesOf("auto").length === 1)
  }, 45_000)

  it("never autosaves a paused guest, and does once it runs again", async () => {
    guest.status = "paused"
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.01",
      "stow.enabled=false",
    )
    await watching()
    await Bun.sleep(2500)
    expect(savesOf("auto")).toEqual([])
    guest.status = "running"
    await until("an autosave", () => savesOf("auto").length === 1)
  }, 45_000)

  it("counts winvm exec as use of the guest", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.05",
      "stow.enabled=false",
    )
    await watching()
    const busyUntil = Date.now() + 5000
    while (Date.now() < busyUntil) {
      expect(
        (await winvm("exec", "-i", "t", "--", "cmd", "/c", "ver")).code,
      ).toBe(0)
      await Bun.sleep(300)
    }
    expect(savesOf("auto")).toEqual([])
    await until("an autosave", () => savesOf("auto").length === 1)
  }, 45_000)

  it("leaves a command holding the instance alone, and autosaves once it is done", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.05",
      "stow.enabled=false",
    )
    await watching()
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
    await Bun.sleep(4500)
    expect(savesOf("auto")).toEqual([])
    expect(automaticOps("save", "begin")).toEqual([])
    rmSync(p.lease)
    await until("an autosave", () => savesOf("auto").length === 1)
  }, 45_000)

  it("stows a guest left idle for longer, and QEMU stops", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.enabled=false",
      "stow.idleMinutes=0.01",
    )
    await watching()
    await until("the stow", () => savesOf("stow").length === 1)
    await until("QEMU to stop", () => !existsSync(p.pid))
    await until("its end", () => automaticOps("stow", "end").length === 1)
    expect(automaticOps("stow", "end")[0]).toMatchObject({ ok: true })
    await until(
      "the watcher to stop",
      async () => watcherRow(await statusText()) === "not running",
    )
  }, 45_000)

  it("turns idle stows off until QEMU restarts when winvm refuses one, says why, and records it once", async () => {
    await releasePidfiles()
    await startQemu("qemu-system-aarch64")
    reportsVersion = "10.0.0"
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.enabled=false",
      "stow.idleMinutes=0.01",
    )
    await watching()
    await until("the refusal", () => refusals().length === 1)
    await until(
      "idle stows off",
      async () => (await watcher())?.stow?.off !== undefined,
    )
    await Bun.sleep(2500)
    expect(refusals()).toHaveLength(1)
    expect(refusals()[0]).toMatchObject({ automatic: true })
    expect(savesOf("stow")).toEqual([])
    expect(existsSync(p.pid)).toBe(true)
    const w = await watcher()
    expect(w?.stow).toMatchObject({ enabled: false })
    expect(String(w?.stow?.off)).toContain(
      "idle stows are off until QEMU restarts",
    )
    const text = await statusText()
    expect(watcherRow(text)).toEndWith("stow off until QEMU restarts")
    expect(text).toContain(
      `note: the watcher of "t" does not stow Windows when it is idle: winvm refused a stow`,
    )
    writeFileSync(
      p.lease,
      JSON.stringify({
        operation: "load",
        id: "a-load",
        pid: process.pid,
        pidStart: null,
        startedAt: "2026-11-17T00:00:00.000Z",
        instance: "t",
        automatic: false,
      }),
    )
    await releasePidfiles()
    await startQemu("qemu-system-aarch64")
    rmSync(p.lease)
    await until("a refusal for the new QEMU", () => refusals().length === 2)
  }, 45_000)

  it("tries an undecided idle stow again after another idle stretch", async () => {
    await releasePidfiles()
    await startQemu("qemu-system-aarch64")
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.enabled=false",
      "stow.idleMinutes=0.01",
    )
    await watching()
    await until("two undecided refusals", () => refusals().length >= 2, 20_000)
    expect(refusals().every((e) => e.kind === "warning" && e.undecided)).toBe(
      true,
    )
    expect(watcherRow(await statusText())).toEndWith("stow after 0.01 min idle")
  }, 45_000)

  it("fixes the guest's clock when it has drifted", async () => {
    guest.offsetMs = 90_000
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.enabled=false",
      "stow.enabled=false",
    )
    await watching({ tickMs: 200, driftCheckMs: 800 })
    await until("the clock to be set", () => offsetMs() < 2000)
  }, 45_000)

  it("fixes the guest's clock after the host sleeps", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.enabled=false",
      "stow.enabled=false",
    )
    await watching({ tickMs: 200, wakeGapMs: 1000, driftCheckMs: 3_600_000 })
    const pid = (await watcher())?.pid ?? null
    if (pid === null || pid <= 1) throw new Error("no watcher pid")
    await Bun.sleep(600)
    guest.offsetMs = 90_000
    process.kill(pid, "SIGSTOP")
    await Bun.sleep(2500)
    process.kill(pid, "SIGCONT")
    await until("the clock to be set", () => offsetMs() < 2000)
  }, 45_000)

  it("picks up a change of settings while it runs", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.enabled=false",
      "stow.enabled=false",
    )
    await watching()
    await Bun.sleep(1500)
    expect(savesOf("auto")).toEqual([])
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.enabled=true",
      "autosave.idleMinutes=0.01",
    )
    await until("an autosave", () => savesOf("auto").length === 1)
  }, 45_000)

  it("stops for watch.enabled=false, and status says it is not running", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.05",
      "stow.enabled=false",
    )
    await watching()
    await until("the watcher", async () =>
      watcherRow(await statusText()).startsWith("watching"),
    )
    await winvm("config", "-i", "t", "watch.enabled=false")
    await Bun.sleep(5000)
    expect(savesOf("auto")).toEqual([])
    expect(watcherRow(await statusText())).toBe("not running")
  }, 45_000)

  it("stops for winvm watch --stop, and --status prints its state", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.05",
      "stow.enabled=false",
    )
    await watching()
    const before = JSON.parse(
      (await winvm("watch", "-i", "t", "--status")).stdout,
    ) as Watcher
    expect(before).toMatchObject({
      state: "watching",
      autosave: { enabled: true, idleMinutes: 0.05, keep: 3 },
      stow: { enabled: false, idleMinutes: 60 },
    })
    expect(await winvm("watch", "-i", "t", "--stop")).toEqual({
      code: 0,
      stdout: 'stopped the watcher for "t"\n',
      stderr: "",
    })
    await Bun.sleep(5000)
    expect(savesOf("auto")).toEqual([])
    expect(watcherRow(await statusText())).toBe("not running")
    const after = JSON.parse(
      (await winvm("watch", "-i", "t", "--status")).stdout,
    ) as Watcher
    expect(after.state).toBe("stopped")
    expect(await winvm("watch", "-i", "t", "--stop")).toEqual({
      code: 0,
      stdout: 'instance "t" has no watcher running\n',
      stderr: "",
    })
  }, 45_000)

  it("does not watch a guest started with --no-watch", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.01",
      "stow.enabled=false",
    )
    await startService()
    expect((await winvm("start", "-i", "t", "--no-watch")).code).toBe(0)
    await Bun.sleep(2500)
    expect(savesOf("auto")).toEqual([])
    expect(watcherRow(await statusText())).toBe("not set up")
  }, 45_000)
})

describe("the watcher's work, as winvm's service runs it", () => {
  const servicePid = (): number => service?.pid ?? -1
  it.skipIf(!ON_MAC)(
    "autosaves and stows as ops of the service itself, marked as winvm's own",
    async () => {
      await winvm(
        "config",
        "-i",
        "t",
        "autosave.idleMinutes=0.01",
        "stow.idleMinutes=0.04",
      )
      await watching()
      await until("the stow", () => automaticOps("stow", "end").length === 1)
      expect(automaticOps("save", "begin")[0]).toMatchObject({
        pid: servicePid(),
        leased: true,
      })
      expect(automaticOps("stow", "begin")[0]).toMatchObject({
        pid: servicePid(),
        leased: true,
      })
      expect((await watcher())?.pid).toBe(servicePid())
    },
    45_000,
  )

  it.skipIf(!ON_MAC)(
    "never autosaves while a person's command runs in the service, and does once it is done",
    async () => {
      await winvm(
        "config",
        "-i",
        "t",
        "autosave.idleMinutes=0.01",
        "stow.enabled=false",
      )
      guest.bootDelayMs = 3000
      await watching()
      expect((await winvm("reboot", "-i", "t")).code).toBe(0)
      await until("an autosave", () => automaticOps("save", "end").length === 1)
      const reboot = records().filter(
        (e) => e.kind === "op" && e.operation === "reboot",
      )
      const began = reboot.find((e) => e.kind === "op" && e.phase === "begin")
      const ended = reboot.find((e) => e.kind === "op" && e.phase === "end")
      if (began === undefined || ended === undefined)
        throw new Error("no reboot")
      expect(began).toMatchObject({ pid: servicePid() })
      expect(
        automaticOps("save", "begin").filter((e) => e.t < ended.t),
      ).toEqual([])
      expect(readFileSync(resolve(p.dir, "watch.log"), "utf8")).toContain(
        "is busy: reboot",
      )
    },
    45_000,
  )

  it.skipIf(!ON_MAC)(
    "at host end, cancels its own autosave under way, then stows Windows",
    async () => {
      await winvm(
        "config",
        "-i",
        "t",
        "autosave.idleMinutes=0.01",
        "stow.enabled=false",
      )
      slowMigrations = ["until-cancel"]
      await watching()
      await until("the autosave's migration", () =>
        fakeQmp.commands.includes("migrate"),
      )
      const r = await fetch("http://localhost/host-ending", {
        unix: p.control,
        method: "POST",
        body: JSON.stringify({ deadlineMs: Date.now() + 40_000 }),
      })
      expect(r.status).toBe(202)
      await until(
        "the host end to finish",
        () =>
          records().some(
            (e) =>
              e.kind === "service" &&
              e.what === "host-end" &&
              e.step === "stowed",
          ),
        30_000,
      )
      const steps = records().filter(
        (e) => e.kind === "service" && e.what === "host-end",
      )
      expect(steps[0]).toMatchObject({ step: "plan", end: "stow" })
      expect(fakeQmp.commands).toContain("migrate_cancel")
      expect(automaticOps("save", "end")[0]).toMatchObject({ ok: false })
      expect(automaticOps("save", "begin")).toHaveLength(1)
      expect(automaticOps("stow", "end")[0]).toMatchObject({ ok: true })
      expect(savesOf("stow")).toEqual(["stow"])
      expect(savesOf("auto")).toEqual([])
    },
    45_000,
  )

  it("turns the watcher on for winvm watch, and says --interval is gone", async () => {
    await winvm(
      "config",
      "-i",
      "t",
      "autosave.idleMinutes=0.01",
      "stow.enabled=false",
    )
    await startService()
    const on = await winvm("watch", "-i", "t")
    expect(on.code).toBe(0)
    expect(on.stdout).toBe(
      `watcher: in winvm's service (pid ${String(servicePid())}) · ${resolve(p.dir, "watch.log")}\n`,
    )
    await until("an autosave", () => savesOf("auto").length === 1)
    expect(await winvm("watch", "-i", "t", "--interval", "5")).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "::error::--interval is gone: winvm's service watches the guest, every 15 s\n",
    })
  }, 45_000)
})
