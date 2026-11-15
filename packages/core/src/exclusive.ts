import { randomUUID } from "node:crypto"
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"

const scratch = (file: string, kind: string): string => `${file}.${String(process.pid)}.${randomUUID()}.${kind}`

function attempt(f: () => void): boolean {
  try {
    f()
    return true
  } catch {
    return false
  }
}

export function readOr<T>(file: string, fallback: T): string | T {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return fallback
  }
}

export function linkNew(file: string, text: string): boolean {
  const tmp = scratch(file, "tmp")
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    linkSync(tmp, file)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false
    throw e
  } finally {
    rmSync(tmp, { force: true })
  }
}

export function replaceWhole(file: string, text: string): void {
  const tmp = scratch(file, "tmp")
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

export function takeOver(file: string, judged: string): boolean {
  const aside = scratch(file, "stale")
  if (!attempt(() => renameSync(file, aside))) return false
  const same = readOr(aside, null) === judged
  if (!same) attempt(() => linkSync(aside, file))
  rmSync(aside, { force: true })
  return same
}
