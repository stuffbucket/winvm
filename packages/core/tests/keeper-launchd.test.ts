import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"

import { keeperJob, keeperRequest, launchctl, startKeeper } from "../src/keeper"

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

afterAll(() => {
  if (enabled) launchctl().bootout(label)
  rmSync(root, { recursive: true, force: true })
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
      instance: "launchd-test",
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
    expect((await startKeeper({ launchd, job, spec })).state).toBe("started")

    const running = await until("the job to run", 5000, () => {
      const info = launchd.print(label)
      return info?.state === "running" && info.pid !== null ? info : null
    })
    expect(running.program).toBe(keeper)
    const hello = await keeperRequest(resolve(dir, "keeper.sock"), {
      op: "hello",
    })
    expect(hello.ok).toBe(true)
    expect(hello.pid).toBe(running.pid)
    expect(hello.instance).toBe("launchd-test")
    const child = hello.child as { pid: number; adopted: boolean }
    expect(child.adopted).toBe(false)

    expect(await startKeeper({ launchd, job, spec })).toMatchObject({
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
