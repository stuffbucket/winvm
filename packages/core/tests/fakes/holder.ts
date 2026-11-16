import { appendFileSync, rmSync } from "node:fs"

const opt = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const linger = Number(opt("--linger") ?? 0)
const thenKill = opt("--then-kill")
const thenRm = opt("--then-rm")
const logSignals = opt("--log-signals")

for (const sig of ["SIGHUP", "SIGINT"] as const) {
  if (logSignals !== undefined) process.on(sig, () => { appendFileSync(logSignals, `${sig}\n`) })
}
process.on("SIGTERM", () => {
  if (logSignals !== undefined) appendFileSync(logSignals, "SIGTERM\n")
  setTimeout(() => {
    if (thenKill !== undefined) {
      try {
        process.kill(Number(thenKill), "SIGTERM")
      } catch {
      }
    }
    if (thenRm !== undefined) rmSync(thenRm, { force: true })
    process.exit(0)
  }, linger)
})
setInterval(() => undefined, 1 << 30)
console.log("ready")
