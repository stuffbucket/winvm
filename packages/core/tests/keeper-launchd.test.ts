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
import { pathsFor } from "../src/paths"
import * as qemu from "../src/qemu"
import * as servicectl from "../src/servicectl"
import * as share from "../src/share"
import * as vnc from "../src/vnc"

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

afterAll(async () => {
  if (enabled) {
    await keeperRequest(keeperSocket(pathsFor(VM)), { op: "kill" }).catch(
      () => null,
    )
    await keeperRequest(keeperSocket(pathsFor(SERVED)), { op: "kill" }).catch(
      () => null,
    )
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
})
