import { spawnText } from "./shell"

export const ps = (fields: readonly string[], pid: number): string =>
  spawnText(
    "ps",
    [...fields.flatMap((f) => ["-o", `${f}=`]), "-p", String(pid)],
    {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    },
  ).stdout.trim()

function exists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

export const UNREADABLE_START = ""

export function processStart(pid: number): string | null {
  if (!exists(pid)) return null
  const m = /^(\S+)\s+(.+)$/.exec(ps(["stat", "lstart"], pid))
  if (m === null) return UNREADABLE_START
  return m[1]?.startsWith("Z") === true
    ? null
    : (m[2]?.trim() ?? UNREADABLE_START)
}

export const isAlive = (pid: number): boolean => processStart(pid) !== null

let own: string | null | undefined

export function ownStart(): string | null {
  own ??= processStart(process.pid)
  return own
}

export function isSameProcess(
  pid: number,
  start: string | null,
  startOf: (pid: number) => string | null = processStart,
): boolean {
  const now = startOf(pid)
  return (
    now !== null &&
    (start === null ||
      start === UNREADABLE_START ||
      now === UNREADABLE_START ||
      now === start)
  )
}
