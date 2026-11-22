import { dlopen, FFIType, ptr } from "bun:ffi"
import { closeSync, openSync } from "node:fs"

export interface Fcntl {
  readonly library: string
  readonly symbol: string
  readonly getLock: number
  readonly setLock: number
  readonly writeLock: number
  readonly unlocked: number
  readonly bytes: number
  readonly typeAt: number
  readonly pidAt: number
}

const DARWIN: Fcntl = {
  library: "/usr/lib/libSystem.B.dylib",
  symbol: "__fcntl",
  getLock: 7,
  setLock: 8,
  writeLock: 3,
  unlocked: 2,
  bytes: 24,
  typeAt: 20,
  pidAt: 16,
}

const LINUX: Fcntl = {
  library: "libc.so.6",
  symbol: "fcntl",
  getLock: 5,
  setLock: 6,
  writeLock: 1,
  unlocked: 2,
  bytes: 32,
  typeAt: 0,
  pidAt: 24,
}

export type LockState =
  | { readonly held: number }
  | "free"
  | "missing"
  | "unknown"

type Call = (fd: number, cmd: number, arg: ReturnType<typeof ptr>) => number

export interface Bound {
  readonly abi: Fcntl
  readonly call: Call
}

let bound: Bound | null | undefined

function abiFor(platform: string): Fcntl | null {
  if (platform === "darwin") return DARWIN
  if (platform === "linux") return LINUX
  return null
}

export function bindFcntl(): Bound | null {
  if (bound !== undefined) return bound
  const abi = abiFor(process.platform)
  try {
    if (abi === null) throw new Error(`no fcntl layout for ${process.platform}`)
    const lib = dlopen(abi.library, {
      [abi.symbol]: {
        args: [FFIType.i32, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
    })
    const symbol = lib.symbols[abi.symbol]
    if (symbol === undefined) throw new Error(`no ${abi.symbol}`)
    bound = { abi, call: (fd, cmd, arg) => symbol(fd, cmd, arg) }
  } catch {
    bound = null
  }
  return bound
}

export function writeLockOf(abi: Fcntl): DataView {
  const lock = new DataView(new ArrayBuffer(abi.bytes))
  lock.setInt16(abi.typeAt, abi.writeLock, true)
  return lock
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
    const fcntl = bindFcntl()
    if (fcntl === null) return "unknown"
    const lock = writeLockOf(fcntl.abi)
    if (fcntl.call(fd, fcntl.abi.getLock, ptr(lock.buffer)) !== 0)
      return "unknown"
    return lockFrom(lock, process.platform)
  } finally {
    closeSync(fd)
  }
}

export function lockFrom(lock: DataView, platform: string): LockState {
  const abi = abiFor(platform)
  if (abi === null) return "unknown"
  if (lock.getInt16(abi.typeAt, true) === abi.unlocked) return "free"
  const held = lock.getInt32(abi.pidAt, true)
  return held > 0 ? { held } : "unknown"
}
