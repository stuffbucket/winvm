import { tmpdir } from "node:os"
import { basename, dirname, resolve } from "node:path"

export function scratchPattern(home: string, prefix: string): string | null {
  if (home === "" || dirname(home) !== resolve(tmpdir())) return null
  const own = basename(home)
  return own.startsWith(prefix) && own.length > prefix.length ? home : null
}
