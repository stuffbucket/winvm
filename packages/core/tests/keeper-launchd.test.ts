import { afterAll, describe, expect, it, mock, spyOn } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { parseAssignment, writeAssignments } from "../src/config"
import { RAMFB, writeDisplay } from "../src/display"
import { type Entry, readSince, START } from "../src/eventlog"
import * as host from "../src/host"
import {
  type KeeperJob,
  type KeeperSpec,
  keeperJob,
  keeperLabel,
  keeperRequest,
  type Launchd,
  launchctl,
  startKeeper,
} from "../src/keeper"
import { keeperDir, keeperHello, keeperSocket } from "../src/kept"
import { heldLease, withOperation } from "../src/operation"
import { basePath, imageMetaPath, pathsFor } from "../src/paths"
import * as qemu from "../src/qemu"
import { currentCompat, FILES, type Manifest, saveDir } from "../src/saves"
import * as servicectl from "../src/servicectl"
import * as share from "../src/share"
import * as vnc from "../src/vnc"
import { ensureWatcher } from "../src/watch"

const enabled =
  process.platform === "darwin" && process.env.WINVM_TEST_LAUNCHD === "1"
const keeper =
  process.env.WINVM_TEST_KEEPER ??
  resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "native",
    "keeper",
    "target",
    "debug",
    "winvm-keeper",
  )
const root = mkdtempSync("/tmp/wkl-")
const savedHome = process.env.WINVM_HOME
process.env.WINVM_HOME = resolve(root, "home")

const VM = "kept-launchd"
const vmLabel = keeperLabel(resolve(root, "home"), VM)
const SERVED = "served-launchd"
const servedLabel = keeperLabel(resolve(root, "home"), SERVED)
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
const label = keeperLabel(resolve(root, "home"), "launchd-test")
const RELAUNCH = "relaunch-launchd"
const relaunchLabel = keeperLabel(resolve(root, "home"), RELAUNCH)
const FAKE_QEMU = resolve(import.meta.dir, "fakes", "qemu.ts")
const AUTOSAVE = "autosave-launchd"
const autosaveLabel = keeperLabel(resolve(root, "home"), AUTOSAVE)

afterAll(async () => {
  if (enabled) {
    await keeperRequest(keeperSocket(pathsFor(VM)), { op: "kill" }).catch(
      () => null,
    )
    await keeperRequest(keeperSocket(pathsFor(SERVED)), { op: "kill" }).catch(
      () => null,
    )
    await keeperRequest(keeperSocket(pathsFor(RELAUNCH)), {
      op: "kill",
    }).catch(() => null)
    await keeperRequest(keeperSocket(pathsFor(AUTOSAVE)), {
      op: "kill",
    }).catch(() => null)
    launchctl().bootout(autosaveLabel)
    launchctl().bootout(relaunchLabel)
    launchctl().bootout(label)
    launchctl().bootout(vmLabel)
    launchctl().bootout(servedLabel)
  }
  if (savedHome === undefined) delete process.env.WINVM_HOME
  else process.env.WINVM_HOME = savedHome
  rmSync(root, { recursive: true, force: true })
})

const leasedStart = async (
  instance: string,
  o: {
    readonly launchd: Launchd
    readonly job: KeeperJob
    readonly spec: KeeperSpec
  },
): ReturnType<typeof startKeeper> =>
  await withOperation(instance, "start", async () => {
    const lease = heldLease(instance)
    if (lease === null) throw new Error("no lease inside withOperation")
    return await startKeeper({ ...o, lease })
  })

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms))

async function until<T>(
  what: string,
  ms: number,
  probe: () => T | null | undefined,
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = probe()
    if (got !== null && got !== undefined) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

async function answered(socket: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000
  for (;;) {
    const hello = await keeperRequest(socket, { op: "hello" }).catch(
      (error: unknown) => {
        if (Date.now() > deadline) throw error
        return null
      },
    )
    if (hello !== null) return hello
    await sleep(100)
  }
}

const whats = (record: string): string[] =>
  readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.kind === "keeper")
    .map((entry) =>
      typeof entry.step === "string"
        ? `${String(entry.what)}:${entry.step}`
        : String(entry.what),
    )

describe.if(enabled)("a real launchd keeper job (WINVM_TEST_LAUNCHD=1)", () => {
  it("runs in the Background session, keeps a dummy child, and on bootout runs the stop action and exits 0", async () => {
    const dir = keeperDir(pathsFor("launchd-test"))
    const record = resolve(root, "events.jsonl")
    const marker = resolve(root, "stop.ran")
    const spec = {
      record,
      child: { name: "dummy", argv: ["/bin/sleep", "600"] },
      stop: {
        argv: [
          "/bin/sh",
          "-c",
          'echo "$WINVM_KEEPER_DEADLINE_MS" > "$0"; kill -KILL "$WINVM_KEEPER_CHILD_PID"; while kill -0 "$WINVM_KEEPER_CHILD_PID" 2>/dev/null; do sleep 0.05; done',
          marker,
        ],
      },
    }
    const launchd = launchctl()
    const job = keeperJob({ label, program: keeper, dir, exitTimeout: 20 })
    expect(
      (await leasedStart("launchd-test", { launchd, job, spec })).state,
    ).toBe("started")

    const running = await until("the job to run", 5000, () => {
      const info = launchd.print(label)
      return info?.state === "running" && info.pid !== null ? info : null
    })
    expect(running.program).toBe(keeper)
    const hello = await answered(resolve(dir, "keeper.sock"))
    expect(hello.ok).toBe(true)
    expect(hello.pid).toBe(running.pid)
    expect(hello.instance).toBe("launchd-test")
    const child = hello.child as { pid: number; adopted: boolean }
    expect(child.adopted).toBe(false)

    expect(
      await leasedStart("launchd-test", { launchd, job, spec }),
    ).toMatchObject({
      state: "running",
    })
    expect(launchd.print(label)?.pid).toBe(running.pid)

    const session = readFileSync(resolve(dir, "keeper.log"), "utf8")
    expect(session).toContain('"what":"launched"')

    expect(launchd.bootout(label)).toBe(true)
    await until("the keeper to finish", 15000, () =>
      whats(record).includes("exiting") ? true : null,
    )
    expect(whats(record)).toEqual([
      "started",
      "launched",
      "host-ending",
      "exited",
      "host-end:stop-action",
      "host-end:done",
      "exiting",
    ])
    expect(readFileSync(marker, "utf8").trim()).toMatch(/^\d{13}$/)
    expect(() => process.kill(child.pid, 0)).toThrow()
    await until("launchd to forget the job", 5000, () =>
      launchd.print(label) === null ? true : null,
    )
  }, 30000)

  it("launches QEMU's stand-in and its TPM emulator through a real keeper job, which powers it down through its own monitor at bootout", async () => {
    const fakechild = resolve(dirname(keeper), "examples", "fakechild")
    expect(existsSync(fakechild)).toBe(true)
    const saved = Object.fromEntries(
      ["WINVM_RUNTIME", "WINVM_KEEPER", "XDG_DATA_HOME"].map((k) => [
        k,
        process.env[k],
      ]),
    )
    const bin = resolve(root, "runtime", "bin")
    mkdirSync(bin, { recursive: true })
    const script = (name: string, body: string): void => {
      writeFileSync(resolve(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(resolve(bin, name), 0o755)
    }
    script(
      "swtpm",
      `while [ $# -gt 0 ]; do case "$1" in --ctrl) s="\${2#*path=}"; s="\${s%%,*}"; shift;; esac; shift; done; : > "$s"\nexec sleep 600`,
    )
    const report = resolve(root, "qemu.report")
    script(
      "qemu-system-aarch64",
      `while [ $# -gt 0 ]; do case "$1" in -pidfile) p="$2"; shift;; -qmp) case "$2" in *keeper/qmp.sock*) q="\${2#unix:}"; q="\${q%%,*}";; esac; shift;; esac; shift; done\nexec "${fakechild}" "${report}" --pidfile "$p" --qmp "$q"`,
    )
    process.env.WINVM_RUNTIME = resolve(root, "runtime")
    process.env.XDG_DATA_HOME = resolve(root, "data")
    process.env.WINVM_KEEPER = keeper
    const meta = { image: "win11-arm64", vnc: 9, created: "2026-11-17" }
    const p = pathsFor(VM)
    mkdirSync(p.tpmDir, { recursive: true })
    writeFileSync(p.meta, JSON.stringify(meta))
    const code = resolve(root, "code.fd")
    writeFileSync(code, "firmware")
    spyOn(host, "requireFirmware").mockReturnValue({ code, vars: code })
    spyOn(host, "tpmTisHasPpi").mockReturnValue(true)
    spyOn(vnc, "ensureFreeDisplay").mockImplementation((_n, _p, m) =>
      Promise.resolve(m),
    )
    spyOn(vnc, "applyPassword").mockResolvedValue(null)
    spyOn(servicectl, "ensureService").mockResolvedValue({} as never)
    const probe = share.setProbe(() => ({ ok: false, reason: "test" }))
    try {
      await withOperation(VM, "start", async () => {
        await qemu.launch(VM, p, meta, {
          installMedia: false,
          ephemeral: false,
          virtioBoot: true,
        })
      })
      const launchd = launchctl()
      const job = await until("the keeper job", 5000, () => {
        const info = launchd.print(vmLabel)
        return info?.state === "running" ? info : null
      })
      const hello = await keeperHello(p)
      expect(hello?.pid).toBe(job.pid ?? -1)
      expect(hello?.child?.name).toBe("qemu")
      expect(qemu.pidOf(p)).toBe(hello?.child?.pid ?? -1)
      const tpm = hello?.sidecars.find((s) => s.name === "swtpm")?.pid ?? -1
      expect(tpm).toBeGreaterThan(0)

      expect(launchd.bootout(vmLabel)).toBe(true)
      await until("the keeper to finish", 15000, () =>
        whats(p.events).includes("exiting") ? true : null,
      )
      expect(whats(p.events)).toEqual([
        "started",
        "launched",
        "launched",
        "host-ending",
        "host-end:powerdown",
        "exited",
        "exited",
        "host-end:done",
        "exiting",
      ])
      expect(readFileSync(report, "utf8")).toContain("qmp system_powerdown")
      expect(() => process.kill(tpm, 0)).toThrow()
      await until("launchd to forget the job", 5000, () =>
        launchd.print(vmLabel) === null ? true : null,
      )
    } finally {
      share.setProbe(probe)
      mock.restore()
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }, 30000)

  it("runs the real control service under a real keeper job, which hands it the host end at bootout", async () => {
    const fakechild = resolve(dirname(keeper), "examples", "fakechild")
    const saved = Object.fromEntries(
      ["WINVM_RUNTIME", "WINVM_KEEPER", "XDG_DATA_HOME", "WINVM_CLI"].map(
        (k) => [k, process.env[k]],
      ),
    )
    const bin = resolve(root, "served-runtime", "bin")
    mkdirSync(bin, { recursive: true })
    const script = (name: string, body: string): void => {
      writeFileSync(resolve(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(resolve(bin, name), 0o755)
    }
    script(
      "swtpm",
      `while [ $# -gt 0 ]; do case "$1" in --ctrl) s="\${2#*path=}"; s="\${s%%,*}"; shift;; esac; shift; done; : > "$s"\nexec sleep 600`,
    )
    const report = resolve(root, "served.report")
    script(
      "qemu-system-aarch64",
      `while [ $# -gt 0 ]; do case "$1" in -pidfile) p="$2"; shift;; -qmp) case "$2" in *keeper/qmp.sock*) q="\${2#unix:}"; q="\${q%%,*}";; esac; shift;; esac; shift; done\nexec "${fakechild}" "${report}" --pidfile "$p" --qmp "$q"`,
    )
    process.env.WINVM_RUNTIME = resolve(root, "served-runtime")
    process.env.XDG_DATA_HOME = resolve(root, "data")
    process.env.WINVM_KEEPER = keeper
    process.env.WINVM_CLI = CLI
    const meta = { image: "win11-arm64", vnc: 10, created: "2026-11-17" }
    const p = pathsFor(SERVED)
    mkdirSync(p.tpmDir, { recursive: true })
    writeFileSync(p.meta, JSON.stringify(meta))
    const code = resolve(root, "code.fd")
    writeFileSync(code, "firmware")
    spyOn(host, "requireFirmware").mockReturnValue({ code, vars: code })
    spyOn(host, "tpmTisHasPpi").mockReturnValue(true)
    spyOn(vnc, "ensureFreeDisplay").mockImplementation((_n, _p, m) =>
      Promise.resolve(m),
    )
    spyOn(vnc, "applyPassword").mockResolvedValue(null)
    const probe = share.setProbe(() => ({ ok: false, reason: "test" }))
    try {
      await withOperation(SERVED, "start", async () => {
        await qemu.launch(SERVED, p, meta, {
          installMedia: false,
          ephemeral: false,
          virtioBoot: true,
        })
      })
      const launchd = launchctl()
      const hello = await keeperHello(p)
      const service = hello?.service?.pid ?? -1
      expect(service).toBeGreaterThan(0)
      expect(servicectl.readService(p)?.pid).toBe(service)

      expect(launchd.bootout(servedLabel)).toBe(true)
      await until("the keeper to finish", 20000, () =>
        whats(p.events).includes("exiting") ? true : null,
      )
      const keeperWhats = whats(p.events)
      expect(keeperWhats.slice(0, 5)).toEqual([
        "started",
        "service-started",
        "launched",
        "launched",
        "host-ending",
      ])
      expect(keeperWhats).toContain("host-end:service")
      expect(keeperWhats).toContain("host-end:fallback")
      expect(keeperWhats).toContain("host-end:powerdown")
      expect(keeperWhats).toContain("service-exited")
      expect(keeperWhats.slice(-2)).toEqual(["host-end:done", "exiting"])
      const plan = readFileSync(p.events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((e) => e.kind === "service" && e.step === "plan")
      expect(plan).toMatchObject({ end: "shutdown" })
      expect(readFileSync(report, "utf8")).toContain("qmp system_powerdown")
      expect(() => process.kill(service, 0)).toThrow()
      await until("launchd to forget the job", 5000, () =>
        launchd.print(servedLabel) === null ? true : null,
      )
    } finally {
      share.setProbe(probe)
      mock.restore()
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }, 40000)

  it("relaunches QEMU as the keeper's child from inside the service, for a load and for a start sent while the service lingers", async () => {
    const saved = Object.fromEntries(
      [
        "WINVM_RUNTIME",
        "WINVM_KEEPER",
        "XDG_DATA_HOME",
        "WINVM_CLI",
        "WINVM_QEMU_DATA",
        "WINVM_FAKE_QEMU_LOG",
      ].map((k) => [k, process.env[k]]),
    )
    const runtime = resolve(root, "relaunch-runtime")
    const bin = resolve(runtime, "bin")
    mkdirSync(bin, { recursive: true })
    const script = (name: string, body: string): void => {
      writeFileSync(resolve(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(resolve(bin, name), 0o755)
    }
    script(
      "swtpm",
      `while [ $# -gt 0 ]; do case "$1" in --ctrl) s="\${2#*path=}"; s="\${s%%,*}"; shift;; esac; shift; done; : > "$s"\nexec sleep 600`,
    )
    script(
      "qemu-system-aarch64",
      `exec "${process.execPath}" "${FAKE_QEMU}" "$@"`,
    )
    const firmware = resolve(root, "relaunch-firmware")
    mkdirSync(firmware, { recursive: true })
    writeFileSync(resolve(firmware, "edk2-aarch64-code.fd"), "firmware")
    writeFileSync(resolve(firmware, "edk2-arm-vars.fd"), "variables")
    const qemuLog = resolve(root, "relaunch.qemu-log")
    process.env.WINVM_RUNTIME = runtime
    process.env.XDG_DATA_HOME = resolve(root, "data")
    process.env.WINVM_KEEPER = keeper
    process.env.WINVM_CLI = CLI
    process.env.WINVM_QEMU_DATA = firmware
    process.env.WINVM_FAKE_QEMU_LOG = qemuLog

    const image = "win11-arm64"
    const meta = { image, vnc: 11, created: "2026-11-17T00:00:00Z" }
    const p = pathsFor(RELAUNCH)
    mkdirSync(p.tpmDir, { recursive: true })
    writeFileSync(p.meta, JSON.stringify(meta))
    writeFileSync(p.overlay, "live disk")
    writeFileSync(p.vars, "live vars")
    writeDisplay(p, RAMFB)
    mkdirSync(dirname(basePath(image)), { recursive: true })
    writeFileSync(basePath(image), "immutable base")
    writeFileSync(imageMetaPath(image), JSON.stringify({ virtioBoot: true }))
    const compat = currentCompat(RELAUNCH, meta, RAMFB)
    const manifest: Manifest = {
      name: "saved",
      instance: RELAUNCH,
      kind: "manual",
      createdAt: meta.created,
      bytes: 42,
      image,
      compat: compat.hash,
      compatParts: compat.parts,
      format: "raw",
      ramFile: FILES.ramRaw,
      display: RAMFB,
    }
    const dir = saveDir(RELAUNCH, "saved")
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, FILES.manifest), JSON.stringify(manifest))
    writeFileSync(resolve(dir, FILES.ramRaw), "saved RAM")
    writeFileSync(resolve(dir, FILES.overlay), "saved disk")
    writeFileSync(resolve(dir, FILES.vars), "saved vars")

    const cli = async (
      ...argv: string[]
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      const proc = Bun.spawn([process.execPath, CLI, ...argv], {
        env: { ...process.env, WINVM_NO_RECONCILE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const killer = setTimeout(() => {
        proc.kill("SIGKILL")
      }, 40000)
      void proc.exited.then(() => {
        clearTimeout(killer)
      })
      const leases: (string | null)[] = []
      const state = { running: true }
      const runs = (): boolean => state.running
      void proc.exited.then(() => {
        state.running = false
      })
      while (runs()) {
        try {
          leases.push(
            (JSON.parse(readFileSync(p.lease, "utf8")) as { id: string }).id,
          )
        } catch {
          leases.push(null)
        }
        await sleep(5)
      }
      lastLeases = leases
      return {
        code: await proc.exited,
        stdout: await new Response(proc.stdout).text(),
        stderr: await new Response(proc.stderr).text(),
      }
    }
    let lastLeases: (string | null)[] = []
    const ops = (): Extract<Entry, { kind: "op" }>[] =>
      readSince(RELAUNCH, START).entries.flatMap((e) =>
        e.kind === "op" ? [e] : [],
      )
    const keeperEntries = (): Record<string, unknown>[] =>
      readFileSync(p.events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((e) => e.kind === "keeper")
    const parentOf = (pid: number): number =>
      Number(
        Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
          .stdout.toString()
          .trim(),
      )
    const heldThroughout = (id: string): boolean => {
      const first = lastLeases.indexOf(id)
      const last = lastLeases.lastIndexOf(id)
      return (
        first >= 0 && lastLeases.slice(first, last + 1).every((l) => l === id)
      )
    }
    const neverTwoAtOnce = (): void => {
      const lines = readFileSync(qemuLog, "utf8").trim().split("\n")
      expect(lines.filter((l) => l.startsWith("lock-failed"))).toEqual([])
      let alive = 0
      for (const l of lines) {
        alive += l.startsWith("start ") ? 1 : l.startsWith("exit ") ? -1 : 0
        expect(alive).toBeLessThanOrEqual(1)
      }
    }

    try {
      await withOperation(RELAUNCH, "start", async () => {
        await qemu.launch(RELAUNCH, p, meta, {
          installMedia: false,
          ephemeral: false,
          virtioBoot: true,
        })
      })
      const first = await keeperHello(p)
      const keeperPid = first?.pid ?? -1
      const servicePid = first?.service?.pid ?? -1
      const oldQemu = first?.child?.pid ?? -1
      expect(servicePid).toBeGreaterThan(0)
      expect(qemu.pidOf(p)).toBe(oldQemu)

      const LOAD = "relaunch-load-0001"
      const loaded = await cli("load", "-i", RELAUNCH, "saved", "--op-id", LOAD)
      expect(loaded.stderr).toBe("")
      expect(loaded.code).toBe(0)
      expect(loaded.stdout).toContain(`loaded "${RELAUNCH}" from "saved"`)
      const loadOps = ops().filter((e) => e.id === LOAD)
      expect(loadOps[0]).toMatchObject({ phase: "begin", pid: servicePid })
      expect(loadOps.at(-1)).toMatchObject({
        phase: "end",
        ok: true,
        exitCode: 0,
        leased: true,
      })
      expect(heldThroughout(LOAD)).toBe(true)
      const afterLoad = await keeperHello(p)
      const newQemu = afterLoad?.child?.pid ?? -1
      expect(afterLoad?.pid).toBe(keeperPid)
      expect(newQemu).not.toBe(oldQemu)
      expect(qemu.pidOf(p)).toBe(newQemu)
      expect(parentOf(newQemu)).toBe(keeperPid)
      expect(() => process.kill(oldQemu, 0)).toThrow()
      expect(
        keeperEntries().some((e) => e.what === "exited" && e.pid === oldQemu),
      ).toBe(true)
      neverTwoAtOnce()

      expect((await cli("stop", "-i", RELAUNCH)).code).toBe(0)
      const START_ID = "relaunch-start-0001"
      const started = await cli(
        "start",
        "-i",
        RELAUNCH,
        "--no-watch",
        "--op-id",
        START_ID,
      )
      expect(started.code).toBe(0)
      expect(started.stdout).toContain(`instance "${RELAUNCH}" up`)
      const startOps = ops().filter((e) => e.id === START_ID)
      expect(startOps[0]).toMatchObject({ phase: "begin", pid: servicePid })
      expect(startOps.at(-1)).toMatchObject({ phase: "end", ok: true })
      expect(heldThroughout(START_ID)).toBe(true)
      const afterStart = await keeperHello(p)
      const third = afterStart?.child?.pid ?? -1
      expect(afterStart?.pid).toBe(keeperPid)
      expect(afterStart?.service?.pid).toBe(servicePid)
      expect(qemu.pidOf(p)).toBe(third)
      expect(parentOf(third)).toBe(keeperPid)
      expect(() => process.kill(newQemu, 0)).toThrow()
      neverTwoAtOnce()
      expect(
        readFileSync(qemuLog, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.startsWith("start ")),
      ).toHaveLength(3)

      await keeperRequest(keeperSocket(p), { op: "kill" })
      const launchd = launchctl()
      expect(launchd.bootout(relaunchLabel)).toBe(true)
      await until("launchd to forget the job", 20000, () =>
        launchd.print(relaunchLabel) === null ? true : null,
      )
      expect(() => process.kill(servicePid, 0)).toThrow()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }, 120000)
  it("cancels the service's own autosave under way when the Mac shuts down, and the service stows Windows", async () => {
    const saved = Object.fromEntries(
      [
        "WINVM_RUNTIME",
        "WINVM_KEEPER",
        "XDG_DATA_HOME",
        "WINVM_CLI",
        "WINVM_QEMU_DATA",
        "WINVM_FAKE_QEMU_LOG",
        "WINVM_FAKE_QEMU_SLOW_MIGRATION",
        "WINVM_WATCH_TIMING",
      ].map((k) => [k, process.env[k]]),
    )
    const runtime = resolve(root, "autosave-runtime")
    const bin = resolve(runtime, "bin")
    mkdirSync(bin, { recursive: true })
    const script = (name: string, body: string): void => {
      writeFileSync(resolve(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(resolve(bin, name), 0o755)
    }
    script(
      "swtpm",
      `while [ $# -gt 0 ]; do case "$1" in --ctrl) s="\${2#*path=}"; s="\${s%%,*}"; shift;; esac; shift; done; : > "$s"\nexec sleep 600`,
    )
    script(
      "qemu-system-aarch64",
      `exec "${process.execPath}" "${FAKE_QEMU}" "$@"`,
    )
    const firmware = resolve(root, "autosave-firmware")
    mkdirSync(firmware, { recursive: true })
    writeFileSync(resolve(firmware, "edk2-aarch64-code.fd"), "firmware")
    writeFileSync(resolve(firmware, "edk2-arm-vars.fd"), "variables")
    const qemuLog = resolve(root, "autosave.qemu-log")
    process.env.WINVM_RUNTIME = runtime
    process.env.XDG_DATA_HOME = resolve(root, "data")
    process.env.WINVM_KEEPER = keeper
    process.env.WINVM_CLI = CLI
    process.env.WINVM_QEMU_DATA = firmware
    process.env.WINVM_FAKE_QEMU_LOG = qemuLog
    process.env.WINVM_FAKE_QEMU_SLOW_MIGRATION = "1"
    process.env.WINVM_WATCH_TIMING = JSON.stringify({ tickMs: 200 })

    const image = "win11-arm64"
    const meta = { image, vnc: 12, created: "2026-11-17T00:00:00Z" }
    const p = pathsFor(AUTOSAVE)
    mkdirSync(p.tpmDir, { recursive: true })
    writeFileSync(p.meta, JSON.stringify(meta))
    writeFileSync(p.overlay, "live disk")
    writeFileSync(p.vars, "live vars")
    writeDisplay(p, RAMFB)
    mkdirSync(dirname(basePath(image)), { recursive: true })
    writeFileSync(basePath(image), "immutable base")
    writeFileSync(imageMetaPath(image), JSON.stringify({ virtioBoot: true }))
    writeAssignments(AUTOSAVE, [
      parseAssignment("autosave.idleMinutes=0.01"),
      parseAssignment("stow.enabled=false"),
    ])
    const entries = (): readonly Entry[] => readSince(AUTOSAVE, START).entries
    const hostEnd = (step: string): Entry | undefined =>
      entries().find(
        (e) => e.kind === "service" && e.what === "host-end" && e.step === step,
      )
    const automatic = (operation: string, phase: string): readonly Entry[] =>
      entries().filter(
        (e) =>
          e.kind === "op" &&
          (e.phase === "begin" || e.phase === "end") &&
          e.phase === phase &&
          e.operation === operation &&
          e.automatic,
      )

    try {
      await withOperation(AUTOSAVE, "start", async () => {
        await qemu.launch(AUTOSAVE, p, meta, {
          installMedia: false,
          ephemeral: false,
          virtioBoot: true,
        })
      })
      const hello = await keeperHello(p)
      const servicePid = hello?.service?.pid ?? -1
      expect(servicePid).toBeGreaterThan(0)
      expect(ensureWatcher(AUTOSAVE)).toBe(true)
      await until("the autosave's migration", 20000, () =>
        existsSync(qemuLog) &&
        readFileSync(qemuLog, "utf8").includes("migrate ")
          ? true
          : null,
      )
      expect(automatic("save", "begin")[0]).toMatchObject({ pid: servicePid })

      const launchd = launchctl()
      expect(launchd.bootout(autosaveLabel)).toBe(true)
      await until("the keeper to finish", 30000, () =>
        whats(p.events).includes("exiting") ? true : null,
      )
      const keeperWhats = whats(p.events)
      expect(keeperWhats).toContain("host-end:service")
      expect(keeperWhats).not.toContain("host-end:fallback")
      expect(keeperWhats.slice(-2)).toEqual(["host-end:done", "exiting"])
      expect(hostEnd("plan")).toMatchObject({ end: "stow" })
      expect(hostEnd("stowed")).toBeDefined()
      expect(automatic("save", "end")[0]).toMatchObject({
        pid: servicePid,
        ok: false,
        error: expect.stringContaining("the Mac is shutting down") as string,
      })
      expect(automatic("save", "begin")).toHaveLength(1)
      expect(automatic("stow", "end")[0]).toMatchObject({
        pid: servicePid,
        ok: true,
      })
      expect(
        existsSync(resolve(saveDir(AUTOSAVE, "stow"), FILES.manifest)),
      ).toBe(true)
      expect(() => process.kill(servicePid, 0)).toThrow()
      await until("launchd to forget the job", 20000, () =>
        launchd.print(autosaveLabel) === null ? true : null,
      )
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }, 120000)
})
