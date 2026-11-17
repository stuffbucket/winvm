import { dlopen, FFIType, ptr } from "bun:ffi"
import { closeSync, openSync } from "node:fs"

const F_GETLK = 7
const F_UNLCK = 2
const F_WRLCK = 3
const FLOCK_BYTES = 24
const L_PID = 16
const L_TYPE = 20

export type LockState =
  | { readonly held: number }
  | "free"
  | "missing"
  | "unknown"

type Fcntl = (fd: number, cmd: number, arg: ReturnType<typeof ptr>) => number

let fcntl: Fcntl | null | undefined

function loadFcntl(): Fcntl | null {
  if (fcntl !== undefined) return fcntl
  try {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      __fcntl: {
        args: [FFIType.i32, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
    })
    fcntl = (fd, cmd, arg) => lib.symbols.__fcntl(fd, cmd, arg)
  } catch {
    fcntl = null
  }
  return fcntl
}

export function lockState(path: string): LockState {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unknown"
  }
  try {
    const call = loadFcntl()
    if (call === null) return "unknown"
    const lock = new DataView(new ArrayBuffer(FLOCK_BYTES))
    lock.setInt16(L_TYPE, F_WRLCK, true)
    if (call(fd, F_GETLK, ptr(lock.buffer)) !== 0) return "unknown"
    return lock.getInt16(L_TYPE, true) === F_UNLCK
      ? "free"
      : { held: lock.getInt32(L_PID, true) }
  } finally {
    closeSync(fd)
  }
}
