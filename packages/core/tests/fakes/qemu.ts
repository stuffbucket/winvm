import { ptr } from "bun:ffi"
import { appendFileSync, openSync, rmSync, writeSync } from "node:fs"

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
if (pidfile === undefined) {
  console.log("  ppi=<bool>")
  process.exit(0)
}

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
let watched = false
for (const path of monitors) {
  const qmp = new FakeQmp(path)
  await qmp.listen()
  if (!watched) new FakeGuest(qmp, agent)
  watched = true
  const answer = qmp.handler
  qmp.handler = async (cmd) => {
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
