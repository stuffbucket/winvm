/**
 * A stand-in process for tests: it only waits. Its command line carries
 * whatever arguments it was given, so `holder.ts winvm serve -i t` passes the
 * service check and `holder.ts winvm watch -i t` the watcher check without
 * being either. One process and no children, so killing it leaves nothing
 * behind (a `bash -c "sleep …"` stand-in leaves its sleep orphaned).
 *
 *   --linger MS     on SIGTERM, wait this long before exiting (a watcher
 *                   finishing a save)
 *   --then-kill PID on SIGTERM, before exiting, SIGTERM this pid too (a stow
 *                   quitting QEMU); only ever a pid the test spawned
 *   --then-rm FILE  and remove this file (QEMU's pidfile going with it)
 *
 * Prints "ready" once its SIGTERM handler is in place.
 */
import { rmSync } from "node:fs"

const opt = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const linger = Number(opt("--linger") ?? 0)
const thenKill = opt("--then-kill")
const thenRm = opt("--then-rm")

process.on("SIGTERM", () => {
  setTimeout(() => {
    if (thenKill !== undefined) {
      try {
        process.kill(Number(thenKill), "SIGTERM")
      } catch {
        // already gone
      }
    }
    if (thenRm !== undefined) rmSync(thenRm, { force: true })
    process.exit(0)
  }, linger)
})
setInterval(() => undefined, 1 << 30)
console.log("ready")
