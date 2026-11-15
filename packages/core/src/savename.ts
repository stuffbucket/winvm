/**
 * A save name is a directory name, shown in tables and typed on command lines:
 * letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 64.
 * Leading dots are reserved for in-progress and lock entries.
 * Returns why a name is unacceptable, or null.
 */
export function nameError(name: string): string | null {
  if (name.length === 0) return "a save name cannot be empty"
  if (name.length > 64) return "a save name is at most 64 characters"
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return `"${name}" is not a valid save name — use letters, digits, ".", "_" and "-", starting with a letter or digit`
  }
  return null
}
