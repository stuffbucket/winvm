import { resolve } from "node:path"

const HOLDER = resolve(import.meta.dir, "holder.ts")
const holders = new Set<ReturnType<typeof Bun.spawn>>()

export interface LockedPidfile {
  readonly pid: number
  readonly proc: ReturnType<typeof Bun.spawn>
}

export async function lockPidfile(
  pidfile: string,
  ...argv: string[]
): Promise<LockedPidfile> {
  const proc = Bun.spawn(
    [process.execPath, HOLDER, ...argv, "--lock", pidfile],
    { stdout: "pipe", stderr: "ignore" },
  )
  holders.add(proc)
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  reader.releaseLock()
  return { pid: proc.pid, proc }
}

export function releasePidfiles(): void {
  for (const proc of holders) proc.kill("SIGKILL")
  holders.clear()
}
