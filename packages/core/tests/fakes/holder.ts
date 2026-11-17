import { dlopen, FFIType, ptr } from "bun:ffi"
import { appendFileSync, openSync, rmSync, writeSync } from "node:fs"

const opt = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const linger = Number(opt("--linger") ?? 0)
const thenKill = opt("--then-kill")
const thenRm = opt("--then-rm")
const logSignals = opt("--log-signals")
const lockPath = opt("--lock")

function holdLock(path: string): void {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    __fcntl: {
      args: [FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  const fd = openSync(path, "w")
  const lock = new DataView(new ArrayBuffer(24))
  lock.setInt16(20, 3, true)
  if (libc.symbols.__fcntl(fd, 8, ptr(lock.buffer)) !== 0)
    throw new Error(`could not lock ${path}`)
  writeSync(fd, `${String(process.pid)}\n`)
}

if (lockPath !== undefined) holdLock(lockPath)

for (const sig of ["SIGHUP", "SIGINT"] as const) {
  if (logSignals !== undefined)
    process.on(sig, () => {
      appendFileSync(logSignals, `${sig}\n`)
    })
}
process.on("SIGTERM", () => {
  if (logSignals !== undefined) appendFileSync(logSignals, "SIGTERM\n")
  setTimeout(() => {
    if (thenKill !== undefined) {
      try {
        process.kill(Number(thenKill), "SIGTERM")
      } catch {}
    }
    if (thenRm !== undefined) rmSync(thenRm, { force: true })
    process.exit(0)
  }, linger)
})
setInterval(() => undefined, 1 << 30)
console.log("ready")
