import { rmSync, writeFileSync } from "node:fs"

import { QgaChannel, QmpChannel } from "../../src/broker"
import { pathsFor } from "../../src/paths"

const name = process.argv[2] ?? "default"
const status = Number(process.argv[3] ?? 501)
const p = pathsFor(name)

const qmp = new QmpChannel({ listen: p.qmp, upstream: p.qmpQemu })
const qga = new QgaChannel({
  listen: p.qga,
  upstream: p.qgaQemu,
  portOpen: () => Promise.resolve(true),
})
await qmp.start()
await qga.start()
rmSync(p.control, { force: true })
const server = Bun.serve({
  unix: p.control,
  fetch: (req) =>
    new URL(req.url).pathname === "/ops"
      ? status === 404
        ? new Response("not found", { status })
        : Response.json(
            { protocol: 1, error: "this service does not run that" },
            { status },
          )
      : Response.json({ state: "running", connected: true }),
})
writeFileSync(
  p.service,
  JSON.stringify({
    pid: process.pid,
    cli: process.env.WINVM_CLI ?? "",
    version: "0.1.4",
    startedAt: new Date().toISOString(),
    build: "sha256:older",
  }),
)
console.log("serving")

const stop = async (): Promise<void> => {
  void server.stop(true)
  await qmp.stop()
  await qga.stop()
  rmSync(p.control, { force: true })
  process.exit(0)
}
process.on("SIGTERM", () => void stop())
process.on("SIGUSR2", () => void stop())
