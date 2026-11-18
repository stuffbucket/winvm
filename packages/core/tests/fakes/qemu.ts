import { ptr } from "bun:ffi"
import {
  appendFileSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"

import { bindFcntl, writeLockOf } from "../../src/pidlock"
import { FakeAgent } from "./agent"
import { FakeGuest } from "./guest"
import { FakeQmp } from "./qmp"

const args = process.argv.slice(2)
const after = (flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args[i + 1]
}
const log = process.env.WINVM_FAKE_QEMU_LOG
const say = (line: string): void => {
  if (log !== undefined) appendFileSync(log, `${line}\n`)
}

const pidfile = after("-pidfile")
if (pidfile === undefined) process.exit(0)

const fcntl = bindFcntl()
if (fcntl === null) throw new Error(`no fcntl on ${process.platform}`)
const fd = openSync(pidfile, "w")
const lock = writeLockOf(fcntl.abi)
if (fcntl.call(fd, fcntl.abi.setLock, ptr(lock.buffer)) !== 0) {
  say(`lock-failed ${String(process.pid)} ${String(Date.now())}`)
  process.exit(1)
}
writeSync(fd, `${String(process.pid)}\n`)
say(
  `start ${String(process.pid)} ${String(Date.now())} ${args.includes("-incoming") ? "incoming" : "boot"}`,
)

const end = (why: string): void => {
  setTimeout(() => {
    say(`exit ${String(process.pid)} ${String(Date.now())} ${why}`)
    process.exit(0)
  }, 20)
}

const monitors = args.flatMap((a, i) =>
  args[i - 1] === "-qmp"
    ? [(a.replace(/^unix:/, "").split(",")[0] ?? "").trim()]
    : [],
)
const agentPath = /path=([^,]+)/.exec(
  args.find((a) => a.includes("id=qga0")) ?? "",
)?.[1]
if (agentPath === undefined) throw new Error("no guest agent chardev")

rmSync(agentPath, { force: true })
const agent = new FakeAgent(agentPath)
await agent.listen()
const slowFirst = process.env.WINVM_FAKE_QEMU_SLOW_MIGRATION === "1"
let migrations = 0
let migrating: { slow: boolean; cancelled: boolean } | null = null
const migrate = (uri: string): void => {
  const to = uri.startsWith("file:")
    ? uri.slice("file:".length)
    : / -o '([^']+)'$/.exec(uri)?.[1]
  if (to !== undefined) writeFileSync(to, "captured RAM")
  migrations += 1
  migrating = { slow: slowFirst && migrations === 1, cancelled: false }
  say(`migrate ${String(process.pid)} ${String(Date.now())}`)
}
const migrationStatus = (): string => {
  const m = migrating
  if (m?.cancelled === true) {
    migrating = null
    return "cancelled"
  }
  if (m?.slow === true) return "active"
  migrating = null
  return "completed"
}

let watched = false
for (const path of monitors) {
  const qmp = new FakeQmp(path)
  await qmp.listen()
  if (!watched) new FakeGuest(qmp, agent)
  watched = true
  const answer = qmp.handler
  qmp.handler = async (cmd) => {
    const given = (cmd.arguments ?? {}) as Record<string, unknown>
    if (cmd.execute === "migrate") {
      migrate(String(given.uri))
      return { return: {} }
    }
    if (cmd.execute === "migrate_cancel") {
      if (migrating !== null) migrating.cancelled = true
      return { return: {} }
    }
    if (cmd.execute === "query-migrate")
      return {
        return: { status: migrationStatus(), ram: { transferred: 4096 } },
      }
    if (cmd.execute === "quit") {
      end("quit")
      return { return: {} }
    }
    if (cmd.execute === "system_powerdown") {
      qmp.emit({
        event: "POWERDOWN",
        timestamp: { seconds: 5, microseconds: 0 },
      })
      qmp.emit({
        event: "SHUTDOWN",
        data: { guest: true, reason: "guest-shutdown" },
        timestamp: { seconds: 6, microseconds: 0 },
      })
      end("powerdown")
      return { return: {} }
    }
    return await answer(cmd)
  }
}
setInterval(() => undefined, 1 << 30)
