import { appendFileSync } from "node:fs"
import { connect } from "node:net"

const [beat = "service.beat", control = "control.sock", keeper = ""] =
  process.argv.slice(2)
const now = (): number => Math.floor(Date.now() / 1000)
const log = (line: string): void => {
  appendFileSync(beat, `${line}\n`)
}
const kept = (): boolean =>
  String(process.ppid) === (process.env.WINVM_KEEPER_PID ?? "")

const ended = (): void => {
  const socket = connect(keeper)
  socket.on("connect", () => {
    socket.end(`${JSON.stringify({ op: "kill" })}\n`)
  })
  socket.on("error", (error) => {
    log(`kill failed ${String(now())} ${error.message}`)
  })
  log(`stowed ${String(now())}`)
}

log(
  `start ${String(now())} ppid ${String(process.ppid)} keeper ${process.env.WINVM_KEEPER_PID ?? "none"}`,
)
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(signal, () => {
    log(`signal ${signal} ${String(now())}`)
    if (!kept()) process.exit(0)
  })
process.on("SIGUSR2", () => {
  log(`stopped ${String(now())}`)
  process.exit(0)
})
setInterval(() => {
  log(String(now()))
}, 1000)
Bun.serve({
  unix: control,
  fetch: async (req) => {
    if (new URL(req.url).pathname !== "/host-ending")
      return new Response("not found", { status: 404 })
    const body = (await req.json()) as {
      readonly deadlineMs?: number
      readonly budgetMs?: number
    }
    log(
      `host-ending ${String(now())} deadline-ms ${String(body.deadlineMs)} budget-ms ${String(body.budgetMs)}`,
    )
    setTimeout(ended, 4000)
    return new Response(null, { status: 202 })
  },
})
