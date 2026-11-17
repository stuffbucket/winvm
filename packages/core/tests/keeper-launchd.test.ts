import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"

import {
  type KeeperJob,
  type KeeperSpec,
  keeperJob,
  keeperRequest,
  type Launchd,
  launchctl,
  startKeeper,
} from "../src/keeper"
import { heldLease, withOperation } from "../src/operation"

const enabled =
  process.platform === "darwin" && process.env.WINVM_TEST_LAUNCHD === "1"
const keeper =
  process.env.WINVM_KEEPER ??
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
const label = `co.stuffbucket.winvm.test.keeper-${String(process.pid)}`
const root = mkdtempSync("/tmp/wkl-")
const savedHome = process.env.WINVM_HOME
process.env.WINVM_HOME = resolve(root, "home")

afterAll(() => {
  if (enabled) launchctl().bootout(label)
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
    const dir = resolve(root, "keeper")
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
})
